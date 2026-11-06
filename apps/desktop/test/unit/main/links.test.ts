import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IPC } from '../../../src/shared/api/desktop.ts';
import type { RuntimeStatus } from '../../../src/shared/api/desktop.ts';
import type { MainToRuntime } from '../../../src/shared/api/host-bridge.ts';
import { parseMainMessage } from '../../../src/shared/api/host-bridge.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { RendererLink } from '../../../src/main/renderer-link.ts';
import { RuntimeLink, runtimeEnv } from '../../../src/main/runtime-link.ts';
import type { RuntimeHostLike } from '../../../src/main/runtime-link.ts';
import type { PortLike } from '../../../src/main/runtime/rpc-client.ts';
import { DEFAULT_DESKTOP_PREFERENCES, SettingsView, changedPreferences } from '../../../src/main/settings-view.ts';
import type { SettingsRpc } from '../../../src/main/settings-view.ts';

/** Manual timers: tests fire them explicitly. */
function timers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void) => { const id = next++; pending.set(id, fn); return id; },
    clearTimer: (id: unknown) => { pending.delete(id as number); },
    fireAll: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    get size() { return pending.size; },
  };
}

function contents(id = 5) {
  const sent: Array<[string, ...unknown[]]> = [];
  let destroyed = false;
  return { id, sent, isDestroyed: () => destroyed, destroy: () => { destroyed = true; }, send: (channel: string, ...args: unknown[]) => { sent.push([channel, ...args]); } };
}

test('renderer link: pushes only to a live page, queues navigate until the page loaded', () => {
  const loaded: string[] = [];
  const link = new RendererLink({ onLoaded: () => loaded.push('loaded') });
  link.send(IPC.updateState, { status: 'idle' }); // no window: dropped
  link.sendWhenLoaded(IPC.navigate, { conversationId: 'ch_01jab3k9z7mx2c4q' });
  const page = contents();
  link.attach(page);
  assert.equal(link.contentsId, 5);
  assert.deepEqual(page.sent, []);
  link.finishedLoading();
  assert.deepEqual(loaded, ['loaded']);
  assert.deepEqual(page.sent, [[IPC.navigate, { conversationId: 'ch_01jab3k9z7mx2c4q' }]]);
  page.destroy();
  assert.equal(link.contentsId, null, 'destroyed window is not trusted any more');
});

test('renderer link: restart readiness and the prepare-restart ack', async () => {
  const t = timers();
  let changes = 0;
  const link = new RendererLink({ onReadyChange: () => { changes++; }, setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.equal(link.rendererReady, true, 'no window: nothing to lose');
  assert.equal(await link.prepareRestart(1000), true);
  const page = contents();
  link.attach(page);
  assert.equal(link.rendererReady, false, 'loading page is not ready');
  link.finishedLoading();
  link.setReady(true);
  assert.equal(link.rendererReady, true);
  link.loading(); // reload
  assert.equal(link.rendererReady, false);
  link.finishedLoading();

  const confirmed = link.prepareRestart(1000);
  const [, requestId] = page.sent.at(-1) as [string, number];
  assert.equal(page.sent.at(-1)![0], IPC.prepareRestart);
  link.ack(requestId, true);
  assert.equal(await confirmed, true);

  const refused = link.prepareRestart(1000);
  link.ack((page.sent.at(-1) as [string, number])[1], false);
  assert.equal(await refused, false);

  const silent = link.prepareRestart(1000);
  t.fireAll();
  assert.equal(await silent, false, 'timeout = not confirmed');

  const closing = link.prepareRestart(1000);
  link.detach();
  assert.equal(await closing, true, 'window gone: nothing left to flush');
  assert.ok(changes >= 3);
});

class FakeHost implements RuntimeHostLike<PortLike> {
  isUp = false;
  child = false;
  sent: MainToRuntime[] = [];
  connects: string[] = [];
  started = 0;
  start() { this.started++; this.child = true; }
  connect(client: 'desktop' | 'main'): PortLike | null {
    if (!this.child) return null;
    this.connects.push(client);
    return { postMessage() {}, on() { return this; }, start() {}, close() {} };
  }
  send(message: MainToRuntime) { this.sent.push(message); }
  async stop() { this.child = false; }
}

test('runtime link: desktop ports wait for a restarting runtime, main RPC re-attaches on up', async () => {
  const t = timers();
  const link = new RuntimeLink<PortLike>({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const host = new FakeHost();
  link.bind(host);
  const statuses: RuntimeStatus[] = [];
  link.onChange(status => statuses.push(status));

  const early = link.desktopPort(); // before start: no process yet
  link.start();
  link.handleStatus({ state: 'starting' });
  link.handleStatus({ state: 'up' });
  assert.ok(await early, 'answered on up');
  assert.equal(link.rpc.connected, true, 'main RpcClient attached');
  assert.deepEqual(host.connects, ['main', 'desktop']);

  assert.ok(await link.desktopPort(), 'immediate while running');
  host.child = false;
  link.handleStatus({ state: 'restarting', inMs: 1000 });
  assert.equal(link.rpc.connected, false);
  const waiting = link.desktopPort();
  link.handleStatus({ state: 'stopped' });
  assert.equal(await waiting, null, 'stopped: no port');
  assert.equal(await link.desktopPort(), null);

  const timedOut = link.desktopPort();
  link.handleStatus({ state: 'restarting', inMs: 1000 });
  const pending = link.desktopPort();
  t.fireAll();
  assert.equal(await pending, null, 'gives up after the wait');
  assert.equal(await timedOut, null);

  link.power('resume');
  link.event('update.state', { status: 'idle', version: '1', percent: 0, automaticInstall: true });
  assert.deepEqual(host.sent.map(message => message.type), ['power', 'event']);
  assert.deepEqual(statuses.map(status => status.state), ['starting', 'up', 'restarting', 'stopped', 'restarting']);
});

test('host bridge: the runtime takes the power events, B-044 online among them, and drops unknown ones', () => {
  for (const event of ['resume', 'suspend', 'lock', 'unlock', 'online']) assert.deepEqual(parseMainMessage({ type: 'power', event }), { type: 'power', event });
  assert.equal(parseMainMessage({ type: 'power', event: 'offline' }), null);
});

function settings(prefs: Partial<Settings['preferences']> = {}): Settings {
  return { preferences: { ...DEFAULT_DESKTOP_PREFERENCES, ...prefs } } as unknown as Settings;
}

test('settings view: defaults before the runtime answers, change notification after', async () => {
  let stored = settings({ theme: 'dark' });
  let updatedListener: ((value: Settings) => void) | null = null;
  const topics: string[] = [];
  const rpc = {
    call: async (method: string, params?: unknown) => {
      if (method === 'settings.get') return stored;
      if (method === 'settings.update') { stored = settings({ ...stored.preferences, ...(params as { preferences: object }).preferences }); return stored; }
      throw new Error(method);
    },
    on: (_event: string, listener: (value: Settings) => void) => { updatedListener = listener; return () => {}; },
    subscribe: async (topic: string) => { topics.push(topic); return () => {}; },
  } as unknown as SettingsRpc;
  const view = new SettingsView(rpc);
  assert.deepEqual(view.preferences(), DEFAULT_DESKTOP_PREFERENCES);
  const seen: string[][] = [];
  view.onChange((next, previous) => seen.push(changedPreferences(next, previous)));
  await view.start();
  assert.deepEqual(topics, ['system']);
  assert.equal(view.preferences().theme, 'dark');
  assert.equal(seen[0].length, 4, 'first load reports everything');
  await view.update({ preferences: { autoDownloadUpdates: true } });
  assert.deepEqual(seen[1], ['autoDownloadUpdates']);
  updatedListener!(settings({ theme: 'dark', autoDownloadUpdates: true, closeToTray: false }));
  assert.deepEqual(seen[2], ['closeToTray']);
  assert.equal(view.preferences().closeToTray, false);
  await view.start(); // a runtime restart: reload only, no second subscription
  assert.deepEqual(topics, ['system']);
});

test('runtime env: inherited, but never runs the runtime as plain node or with injected options', () => {
  const env = runtimeEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require evil.js', WORKFORCE_FAKE_ENGINE: '1' });
  assert.deepEqual(env, { PATH: '/bin', WORKFORCE_FAKE_ENGINE: '1' });
});
