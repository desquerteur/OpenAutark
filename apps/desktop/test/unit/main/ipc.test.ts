import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IPC } from '../../../src/shared/api/desktop.ts';
import type { IpcResult } from '../../../src/shared/api/desktop.ts';
import type { UpdateState } from '../../../src/shared/model/system.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { registerIpc, trusted } from '../../../src/main/ipc.ts';
import type { IpcDeps, IpcEventLike, IpcMainLike } from '../../../src/main/ipc.ts';
import * as args from '../../../src/main/ipc-args.ts';

const WINDOW_ID = 3;
const STATE: UpdateState = { status: 'development', version: '0.2.0', percent: 0, automaticInstall: true };

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, (event: IpcEventLike, ...values: unknown[]) => Promise<unknown>>();
  readonly listeners = new Map<string, (event: IpcEventLike, ...values: unknown[]) => void>();
  handle(channel: string, listener: (event: IpcEventLike, ...values: unknown[]) => Promise<unknown>) { this.handlers.set(channel, listener); }
  on(channel: string, listener: (event: IpcEventLike, ...values: unknown[]) => void) { this.listeners.set(channel, listener); }
  invoke(event: IpcEventLike, channel: string, ...values: unknown[]) { return this.handlers.get(channel)!(event, ...values) as Promise<IpcResult<unknown>>; }
  send(event: IpcEventLike, channel: string, ...values: unknown[]) { this.listeners.get(channel)!(event, ...values); }
}

/** The preload's page lease: page id (32 hex) + restart counter. */
const lease = (count = 0, page = 'a') => `${page.repeat(32)}.${count}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

function events() {
  const mainFrame = { url: 'app://app/index.html', parent: null };
  const posted: Array<{ channel: string; message?: unknown; transfer?: unknown[] }> = [];
  const sender = { id: WINDOW_ID, mainFrame, postMessage: (channel: string, message: unknown, transfer?: unknown[]) => { posted.push({ channel, message, transfer }); } };
  return {
    posted,
    app: { sender, senderFrame: mainFrame } as IpcEventLike,
    subFrame: { sender, senderFrame: { url: 'wf-sandbox://app/msg_01jab3k9z7mx2c4q/0', parent: mainFrame } } as IpcEventLike,
    otherWindow: { sender: { id: 99, mainFrame }, senderFrame: mainFrame } as IpcEventLike,
    navigatedAway: { sender, senderFrame: { url: 'https://evil.example/', parent: null } } as IpcEventLike,
  };
}

function setup(overrides: Partial<IpcDeps> = {}) {
  const calls: string[] = [];
  const deps: IpcDeps = {
    windowContentsId: () => WINDOW_ID,
    runtime: { desktopPort: async () => ({ close() {} }), status: () => ({ state: 'up' }) },
    updates: {
      state: () => STATE,
      apply: async () => { calls.push('apply'); return STATE; },
      defer: () => STATE,
      setAutoDownload: async enabled => { calls.push(`auto:${enabled}`); return STATE; },
      setRendererReady: ready => { calls.push(`ready:${ready}`); },
    },
    restartAck: (id, ok) => { calls.push(`ack:${id}:${ok}`); },
    armMedia: kinds => { calls.push(`arm:${kinds.join('+')}`); },
    capture: { window: async () => 'data:image/png;base64,AA==', screen: async () => { throw new WorkforceError('unavailable', 'The screen could not be captured.'); } },
    files: {
      pick: async kind => { calls.push(`pick:${kind}`); return []; },
      pickFolder: async purpose => { calls.push(`folder:${String(purpose)}`); return null; },
      open: async (id, reveal) => { calls.push(`open:${reveal}`); },
    },
    clipboardWrite: async text => { calls.push(`copy:${text}`); },
    openExternal: async url => { calls.push(`external:${url}`); },
    ...overrides,
  };
  const ipc = new FakeIpcMain();
  registerIpc(ipc, deps);
  return { ipc, calls, e: events() };
}

test('every channel of the contract is registered', () => {
  const { ipc } = setup();
  const pushOnly = new Set<string>([IPC.runtimePort, IPC.runtimeStatus, IPC.updateState, IPC.prepareRestart, IPC.navigate]);
  for (const channel of Object.values(IPC)) {
    if (pushOnly.has(channel)) continue;
    assert.ok(ipc.handlers.has(channel) || ipc.listeners.has(channel), channel);
  }
});

test('trust check refuses sub-frames, other windows and navigated pages', async () => {
  const { ipc, calls, e } = setup();
  assert.equal(trusted(e.app, WINDOW_ID), true);
  for (const event of [e.subFrame, e.otherWindow, e.navigatedAway]) {
    assert.equal(trusted(event, WINDOW_ID), false);
    const result = await ipc.invoke(event, IPC.updateApply);
    assert.deepEqual(result, { ok: false, error: { code: 'forbidden', message: 'Untrusted request.' } });
    ipc.send(event, IPC.updateReady, true);
  }
  assert.deepEqual(calls, [], 'no action ran for untrusted senders');
  assert.equal(trusted(e.app, null), false, 'window closed');
});

test('trusted invokes answer IpcResult envelopes; errors keep their code', async () => {
  const { ipc, calls, e } = setup();
  assert.deepEqual(await ipc.invoke(e.app, IPC.updateGet), { ok: true, value: STATE });
  assert.deepEqual(await ipc.invoke(e.app, IPC.mediaArm, ['audio']), { ok: true, value: null });
  assert.deepEqual(await ipc.invoke(e.app, IPC.captureScreen), { ok: false, error: { code: 'unavailable', message: 'The screen could not be captured.' } });
  assert.deepEqual(await ipc.invoke(e.app, IPC.filesPickFolder, 'restore'), { ok: true, value: null });
  assert.deepEqual(calls, ['arm:audio', 'folder:restore']);
});

test('argument validation: bad input never reaches the action', async () => {
  const { ipc, calls, e } = setup();
  const bad = async (channel: string, ...values: unknown[]) => {
    const result = await ipc.invoke(e.app, channel, ...values);
    assert.equal(result.ok, false, `${channel} ${JSON.stringify(values)}`);
    if (!result.ok) assert.equal(result.error.code, 'bad_request');
  };
  await bad(IPC.mediaArm, ['microphone']);
  await bad(IPC.mediaArm, []);
  await bad(IPC.filesPick, 'executables');
  await bad(IPC.filesOpen, '../../etc/passwd');
  await bad(IPC.updateAutoDownload, 'yes');
  await bad(IPC.clipboardWrite, 'a\0b');
  await bad(IPC.openExternal, 'file:///C:/Windows/System32/cmd.exe');
  // fire-and-forget channels drop invalid input silently
  ipc.send(e.app, IPC.prepareRestartAck, -1, true);
  assert.deepEqual(calls, []);
  // valid input passes
  ipc.send(e.app, IPC.prepareRestartAck, 4, true);
  ipc.send(e.app, IPC.updateReady, true);
  assert.deepEqual(await ipc.invoke(e.app, IPC.filesOpen, 'a'.repeat(64), true), { ok: true, value: null });
  assert.deepEqual(await ipc.invoke(e.app, IPC.openExternal, 'https://example.com'), { ok: true, value: null });
  assert.deepEqual(calls, ['ack:4:true', 'ready:true', 'open:true', 'external:https://example.com/']);
});

test('runtime connect posts a port to the asking renderer (none when the runtime is stopped)', async () => {
  let port: unknown = { close() {} };
  const { ipc, e } = setup({ runtime: { desktopPort: async () => port, status: () => ({ state: 'up' }) } });
  ipc.send(e.app, IPC.runtimeConnect, lease(0));
  await tick();
  assert.equal(e.posted.length, 1);
  assert.equal(e.posted[0].channel, IPC.runtimePort);
  assert.deepEqual(e.posted[0].transfer, [port]);
  port = null;
  ipc.send(e.app, IPC.runtimeConnect, lease(1));
  await tick();
  assert.deepEqual(e.posted[1], { channel: IPC.runtimePort, message: 'unavailable', transfer: [] }, 'empty transfer: the preload rejects connect()');
  ipc.send(e.subFrame, IPC.runtimeConnect, lease(2));
  await tick();
  assert.equal(e.posted.length, 2, 'a mini-app frame never gets a runtime port');
});

test('runtime connect: a failing port request answers at once with an empty transfer', async () => {
  const lines: string[] = [];
  const failing = setup({
    runtime: { desktopPort: () => { throw new Error('channel failed'); }, status: () => ({ state: 'up' }) },
    log: line => lines.push(line),
  });
  failing.ipc.send(failing.e.app, IPC.runtimeConnect, lease());
  await tick();
  assert.deepEqual(failing.e.posted, [{ channel: IPC.runtimePort, message: 'unavailable', transfer: [] }]);
  assert.match(lines[0], /runtime port failed/);

  const rejecting = setup({ runtime: { desktopPort: () => Promise.reject(new Error('gone')), status: () => ({ state: 'up' }) } });
  rejecting.ipc.send(rejecting.e.app, IPC.runtimeConnect, lease());
  await tick();
  assert.deepEqual(rejecting.e.posted, [{ channel: IPC.runtimePort, message: 'unavailable', transfer: [] }]);
});

test('runtime connect: a second request while the page holds a live port gets no port', async () => {
  let opened = 0;
  const lines: string[] = [];
  const { ipc, e } = setup({
    runtime: { desktopPort: async () => ({ id: ++opened, close() {} }), status: () => ({ state: 'up' }) },
    log: line => lines.push(line),
  });
  const ports = () => e.posted.filter(entry => entry.transfer?.length).map(entry => (entry.transfer![0] as { id: number }).id);

  ipc.send(e.app, IPC.runtimeConnect, lease(0));
  await tick();
  assert.deepEqual(ports(), [1]);
  // The same page asks again (a page script reaching connect()): refused, no new port opened.
  ipc.send(e.app, IPC.runtimeConnect, lease(0));
  await tick();
  assert.deepEqual(e.posted.at(-1), { channel: IPC.runtimePort, message: 'in_use', transfer: [] });
  assert.equal(opened, 1, 'the runtime was not even asked');
  assert.match(lines[0], /refused a second runtime port/);
  // Two requests racing on one lease: only the first gets a port.
  ipc.send(e.app, IPC.runtimeConnect, lease(1));
  ipc.send(e.app, IPC.runtimeConnect, lease(1));
  await tick();
  assert.deepEqual(ports(), [1, 2]);
  assert.equal(opened, 2);
  // After a runtime restart (the preload moved its counter) and after a reload (new page id).
  ipc.send(e.app, IPC.runtimeConnect, lease(2));
  await tick();
  ipc.send(e.app, IPC.runtimeConnect, lease(0, 'b'));
  await tick();
  assert.deepEqual(ports(), [1, 2, 3, 4]);
  // The reloaded page is bound by the same rule.
  ipc.send(e.app, IPC.runtimeConnect, lease(0, 'b'));
  await tick();
  assert.deepEqual([ports(), e.posted.at(-1)?.message], [[1, 2, 3, 4], 'in_use']);
});

test('runtime connect: a request without a valid lease is refused; a failed request frees its lease', async () => {
  let port: unknown = null;
  let asked = 0;
  const { ipc, e } = setup({ runtime: { desktopPort: async () => { asked++; return port; }, status: () => ({ state: 'up' }) } });
  for (const bad of [undefined, '', 'x.0', `${'A'.repeat(32)}.0`, `${'a'.repeat(32)}`, `${'a'.repeat(32)}.-1`, 42]) {
    ipc.send(e.app, IPC.runtimeConnect, bad);
  }
  await tick();
  assert.equal(asked, 0);
  assert.ok(e.posted.every(entry => entry.message === 'bad_request' && entry.transfer?.length === 0));
  // The runtime is stopped: no port, and the same lease may ask again once it runs.
  const before = e.posted.length;
  ipc.send(e.app, IPC.runtimeConnect, lease(0));
  await tick();
  port = { close() {} };
  ipc.send(e.app, IPC.runtimeConnect, lease(0));
  await tick();
  assert.deepEqual(e.posted.slice(before).map(entry => entry.transfer?.length), [0, 1]);
});

test('runtime connect: a port for a window that became untrusted meanwhile is closed, the lease freed', async () => {
  let contents: number | null = WINDOW_ID;
  const closed: number[] = [];
  let next = 0;
  const { ipc, e } = setup({
    windowContentsId: () => contents,
    runtime: {
      // The window navigates away while the runtime prepares the first port.
      desktopPort: async () => { const id = ++next; if (id === 1) contents = null; return { close() { closed.push(id); } }; },
      status: () => ({ state: 'up' }),
    },
  });
  ipc.send(e.app, IPC.runtimeConnect, lease(0));
  await tick();
  assert.deepEqual([closed, e.posted.length], [[1], 0], 'closed, not posted');
  contents = WINDOW_ID;
  ipc.send(e.app, IPC.runtimeConnect, lease(0));
  await tick();
  assert.equal(e.posted[0].transfer?.length, 1, 'the lease was freed');
});

test('title bar layout: trusted pages switch the caption height; any other value means columns', () => {
  const layouts: string[] = [];
  const { ipc, e } = setup({ titleBarLayout: layout => { layouts.push(layout); } });
  ipc.send(e.app, IPC.titleBarLayout, 'compact');
  ipc.send(e.app, IPC.titleBarLayout, 'columns');
  ipc.send(e.app, IPC.titleBarLayout, { height: 999 });
  ipc.send(e.subFrame, IPC.titleBarLayout, 'compact');
  ipc.send(e.otherWindow, IPC.titleBarLayout, 'compact');
  assert.deepEqual(layouts, ['compact', 'columns', 'columns']);
});

test('online (B-044): the app window\'s network event reaches the runtime; other senders are dropped without a refusal line', () => {
  let online = 0;
  const lines: string[] = [];
  const { ipc, e } = setup({ online: () => { online++; }, log: line => { lines.push(line); } });
  ipc.send(e.app, IPC.online);
  for (const event of [e.subFrame, e.otherWindow, e.navigatedAway]) ipc.send(event, IPC.online);
  assert.equal(online, 1);
  assert.deepEqual(lines, [], 'a hidden window that shares the preload sends it too: no refusal lines');
  const failing = setup({ online: () => { throw new Error('runtime down'); } });
  assert.doesNotThrow(() => failing.ipc.send(failing.e.app, IPC.online));
});

test('ipcFailure keeps our sentences but hides system errors', () => {
  assert.deepEqual(args.ipcFailure(new WorkforceError('not_found', 'Chat not found.')), { ok: false, error: { code: 'not_found', message: 'Chat not found.' } });
  assert.deepEqual(args.ipcFailure(new Error('The backup folder is empty.')), { ok: false, error: { code: 'internal', message: 'The backup folder is empty.' } });
  const system = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\Users\\me\\secret.txt'"), { errno: -2, syscall: 'open' });
  assert.deepEqual(args.ipcFailure(system), { ok: false, error: { code: 'internal', message: 'The app could not do this.' } });
  assert.deepEqual(args.mediaKinds(['video', 'video']), ['video']);
  assert.deepEqual(args.mediaKinds(['audio', 'video']), ['audio', 'video']);
  assert.equal(args.optionalFlag(undefined), false);
  assert.throws(() => args.requestId(1.5));
});

test('a disposed frame (throwing accessor) is never trusted', () => {
  const event = { sender: { id: WINDOW_ID }, get senderFrame(): { url: string } { throw new Error('Render frame was disposed'); } } as IpcEventLike;
  assert.equal(trusted(event, WINDOW_ID), false);
});
