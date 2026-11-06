// The Linux AT-SPI driver (23.10.2026; computer/drivers.ts, resources/computer/linux-helper.py +
// linux_atspi.py) run for real under Python against a scripted AT-SPI desktop (fake-gi/): the ready
// handshake, windows with the Workforce app marked, a tree in the Windows helper's node shape,
// element actions with the observed-identity precondition, toggles and expands that check their
// state, pointer/key events on X11 and an honest 'unavailable' on Wayland and for key combinations
// without GDK; a wheel without a point stays where the pointer is; the script's own Workforce-window
// rules against a scripted X11 display (linux-guard-check.py – the runtime no longer configures them); and human priority
// with Linux's unknown idle time judged by the host's idle seconds against the helper's own last
// input (presence.ts).
// Skips without a Python interpreter. A real Linux desktop and libX11 itself are not covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHelper, driverFor } from '../../../src/runtime/computer/drivers.ts';
import { ComputerService } from '../../../src/runtime/computer/service.ts';
import { judgePresence } from '../../../src/runtime/computer/presence.ts';
import type { Lease, Supervisor } from '../../../src/runtime/system/supervisor.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { Host } from '../../../src/runtime/host.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = path.resolve(here, '..', '..', '..', 'resources');
const python = ['python3', 'python'].find((command) => spawnSync(command, ['--version']).status === 0);

/** Spawns for real; drops -E so the fake `gi` on PYTHONPATH is found (the flags themselves are asserted). */
function supervisor(env: NodeJS.ProcessEnv, seen: string[][]): Pick<Supervisor, 'spawn'> {
  return {
    spawn(input) {
      seen.push(input.args);
      const child = spawn(input.command, input.args.filter((arg) => arg !== '-E'), { env: { ...process.env, ...env, PYTHONPATH: path.join(here, 'fake-gi') }, stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      return { id: 1, owner: input.owner, kind: 'light', startedAt: 0, lastActiveAt: 0, child, exited, touch() {}, release: async () => { child.kill(); await exited; } } as unknown as Lease;
    },
  };
}

function rig(session: string, env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-atspi-'));
  const logFile = path.join(dir, 'events.jsonl');
  const seen: string[][] = [];
  const helper = createHelper('linux', {
    // DISPLAY empty: no X11 here, AT-SPI is the only source (the X11 rules: linux-guard-check.py).
    supervisor: supervisor({ XDG_SESSION_TYPE: session, FAKE_ATSPI_LOG: logFile, DISPLAY: '', ...env }, seen), resourcesDir: resources, log: new MemoryLogger(),
    unpacked: (file) => file, python,
  });
  const events = (): Array<Record<string, unknown>> => { try { return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
  return { helper, seen, events, cleanup: async () => { await helper.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

const code = (wanted: string, message?: RegExp) => (error: unknown) => error instanceof WorkforceError && error.code === wanted && (!message || message.test(error.message));

test('drivers: Windows and Linux control, macOS watch only', () => {
  assert.equal(driverFor('win32')?.input, 'full');
  assert.deepEqual([driverFor('linux')?.semantic, driverFor('linux')?.input], [true, 'x11']);
  assert.equal(driverFor('darwin'), undefined);
});

test('Linux AT-SPI helper: windows, tree, element actions with their checks, X11 input', { skip: python ? false : 'no Python interpreter' }, async () => {
  const r = rig('x11');
  try {
    const windows = await r.helper.call<Array<{ hwnd: number; title: string; process: string; pid: number; foreground: boolean; app: boolean }>>('windows');
    assert.deepEqual(r.seen[0].slice(0, 2), ['-E', '-s'], 'no PYTHONPATH, no user site packages');
    assert.deepEqual(windows.map((w) => [w.title, w.process, w.pid, w.foreground, w.app]), [['Notes - gedit', 'gedit', 4242, true, false], ['Workforce', 'workforce', 999, false, false]]);
    const editor = windows[0].hwnd;
    const tree = await r.helper.call<{ hwnd: number; title: string; nodes: Array<Record<string, unknown>> }>('tree', { hwnd: editor });
    assert.equal(tree.title, 'Notes - gedit');
    assert.deepEqual(tree.nodes.map((n) => [n.rid, n.role, n.name]), [['', 'window', 'Notes - gedit'], ['0', 'button', 'Save'], ['1', 'edit', 'Body'], ['2', 'checkbox', 'Wrap'], ['3', 'treeitem', 'Folder'], ['4', 'text', 'Status']]);
    assert.deepEqual([tree.nodes[1].rect, tree.nodes[1].patterns, tree.nodes[2].value, tree.nodes[3].toggle, tree.nodes[4].expand], [[110, 120, 80, 30], ['invoke'], 'hello', 'off', 'collapsed']);

    await r.helper.call('act', { hwnd: editor, rid: '0', expectName: 'Save', expectRole: 'button', action: 'invoke', settleMs: 0 });
    await assert.rejects(r.helper.call('act', { hwnd: editor, rid: '0', expectName: 'Export', expectRole: 'button', action: 'invoke', settleMs: 0 }), code('conflict', /The element changed: expected "Export" but found "Save"/));
    const typed = await r.helper.call<{ element: { value: string } }>('act', { hwnd: editor, rid: '1', expectName: 'Body', action: 'set_value', value: 'new text', settleMs: 0 });
    assert.equal(typed.element.value, 'new text');
    const on = await r.helper.call<{ element: { toggle: string } }>('act', { hwnd: editor, rid: '2', action: 'toggle', value: 'on', settleMs: 0 });
    assert.equal(on.element.toggle, 'on');
    await r.helper.call('act', { hwnd: editor, rid: '2', action: 'toggle', value: 'on', settleMs: 0 }); // already on: nothing happens
    const open = await r.helper.call<{ element: { expand: string } }>('act', { hwnd: editor, rid: '3', action: 'expand', settleMs: 0 });
    assert.equal(open.element.expand, 'expanded');
    await assert.rejects(r.helper.call('act', { hwnd: editor, rid: '9', action: 'invoke', settleMs: 0 }), code('not_found', /The element is gone/));
    await r.helper.call('act', { hwnd: windows[1].hwnd, rid: '0', action: 'invoke', settleMs: 0, app: true }); // cleared by the runtime

    await r.helper.call('click', { x: 150, y: 135, button: 'left', count: 2 });
    await r.helper.call('key', { vks: [13], repeat: 1 });
    await r.helper.call('type', { text: 'Hi' });
    await assert.rejects(r.helper.call('key', { vks: [17, 83] }), code('unavailable', /need GDK/));
    await r.helper.call('path', { steps: [0, 0, 0], end: 'drag', drag: [20, 0, 40, 40, 0, 80], button: 'left', dwellMs: 0, downMs: 0, settleMs: 0 });
    await assert.rejects(r.helper.call('screenshot', {}), code('unavailable'));
    const presence = await r.helper.call<{ idleUnknown: boolean; injectedAgoMs: number }>('presence');
    assert.equal(presence.idleUnknown, true);
    assert.ok(presence.injectedAgoMs >= 0, 'the time since its own last input');

    // The Workforce window (1000,0 600x400): a click there or a drag that ends there waits for the
    // runtime's clearance (refused before the button goes down, with the point); moves and wheel
    // steps press nothing; a wheel without a point needs the pointer's position (X11), and never
    // jumps to the corner.
    const before = r.events().filter((e) => e.mouse).length;
    await assert.rejects(r.helper.call('scroll', { dy: 3 }), code('bad_request', /give x and y/));
    assert.equal(r.events().filter((e) => e.mouse).length, before, 'no pointer event at all');
    await r.helper.call('move', { x: 1599, y: 399 });
    await r.helper.call('scroll', { x: 1300, y: 50, dy: -2 });
    await r.helper.call('click', { x: 1100, y: 100, app: true });
    assert.deepEqual(r.events().filter((e) => e.mouse).slice(before).map((e) => e.mouse), [[1599, 399, 'abs'], [1300, 50, 'b4c'], [1300, 50, 'b4c'], [1100, 100, 'b1c']]);
    // B-055: a planned path – moves on time, then a press held for pressMs (no X11 here: no pointer reads).
    const moved = r.events().filter((e) => e.mouse).length;
    const done = await r.helper.call<{ at: number[] }>('path', { steps: [200, 200, 0, 210, 205, 10, 220, 210, 20], end: 'click', pressMs: 10, dwellMs: 0 });
    assert.deepEqual(done.at, [220, 210]);
    assert.deepEqual(r.events().filter((e) => e.mouse).slice(moved).map((e) => e.mouse), [[200, 200, 'abs'], [210, 205, 'abs'], [220, 210, 'abs'], [220, 210, 'b1p'], [220, 210, 'b1r']]);
    await assert.rejects(r.helper.call('cursor'), code('unavailable', /no X11/), 'the pointer cannot be read without X11: the runtime then jumps');

    const events = r.events();
    assert.deepEqual(events.filter((e) => e.action).map((e) => e.action), [['Save', 'click'], ['Wrap', 'toggle'], ['Folder', 'expand or contract'], ['Stop', 'click']], 'one action each – no repeat for an element already on; the Workforce one only once cleared');
    assert.deepEqual(events.find((e) => e.set_text)?.set_text, ['Body', 'new text']);
    assert.deepEqual(events.filter((e) => e.mouse).slice(0, 1).map((e) => e.mouse), [[150, 135, 'b1d']]);
    assert.deepEqual(events.filter((e) => e.key).map((e) => e.key), [[0xff0d, null, 3], [0, 'Hi', 4]], 'Enter as a keysym, text as a string');
    const drag = events.filter((e) => Array.isArray(e.mouse) && /^b1[pr]$/.test((e.mouse as string[])[2])).map((e) => (e.mouse as unknown[])[2]);
    assert.deepEqual(drag, ['b1p', 'b1r', 'b1p', 'b1r'], 'the drag path, then the click path (pressed and released)');
  } finally { await r.cleanup(); }
});

test('Workforce-window rules against a scripted X11 display: its windows\' rectangles, the keyboard, fail closed', { skip: python ? false : 'no Python interpreter' }, () => {
  const out = spawnSync(python!, ['-B', path.join(here, 'linux-guard-check.py'), path.join(resources, 'computer')], {
    env: { ...process.env, PYTHONPATH: path.join(here, 'fake-gi'), FAKE_ATSPI_HIDE: 'workforce', DISPLAY: '' }, encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  type Case = { case: string; ok: boolean; code?: string; message?: string; value?: unknown; app?: unknown };
  const cases = new Map(out.stdout.trim().split(/\r?\n/).map((line): [string, Case] => { const item = JSON.parse(line) as Case; return [item.case, item]; }));
  const refused = (name: string, wanted: RegExp, kind = 'forbidden') => { const item = cases.get(name)!; assert.equal(item.ok, false, name); assert.equal(item.code, kind, name); assert.match(item.message ?? '', wanted, name); };
  refused('no source locates Workforce', /cannot be located/);
  assert.deepEqual(cases.get('X11 zone')?.value, [[1000, 0, 600, 400]], 'viewable Workforce windows only (an unmapped one has no rectangle)');
  refused('point on Workforce', /Autark window: its guarded controls are checked first/, 'app_window');
  assert.deepEqual(cases.get('point on Workforce')?.app, { point: { x: 1100, y: 100 } });
  assert.equal(cases.get('point on Workforce, cleared')?.ok, true);
  assert.equal(cases.get('point on the editor')?.ok, true);
  assert.equal(cases.get('keyboard with the editor in front')?.ok, true);
  assert.deepEqual(cases.get('pointer and idle')?.value, [[150, 135], 1234]);
  refused('keyboard with Workforce in front (X11)', /has the keyboard/, 'app_window');
  assert.equal(cases.get('keyboard with Workforce in front, cleared')?.ok, true);
  refused('X11 reads no process ids', /cannot be located/);
  assert.deepEqual(cases.get('no Workforce app here')?.value, [], 'a headless worker has no Workforce window');
});

test('Wayland: element actions work, pointer and keyboard input are refused honestly', { skip: python ? false : 'no Python interpreter' }, async () => {
  const r = rig('wayland');
  try {
    const [editor] = await r.helper.call<Array<{ hwnd: number }>>('windows');
    await r.helper.call('act', { hwnd: editor.hwnd, rid: '0', expectName: 'Save', action: 'invoke', settleMs: 0 });
    await assert.rejects(r.helper.call('click', { x: 1, y: 1 }), code('unavailable', /Wayland/));
    await assert.rejects(r.helper.call('act', { hwnd: editor.hwnd, rid: '0', action: 'click', settleMs: 0 }), code('unavailable', /Wayland/));
    assert.equal(r.events().filter((e) => e.mouse).length, 0);
  } finally { await r.cleanup(); }
});

test('ComputerService on Linux: unknown idle time is judged by the host idle seconds against our own last input', async () => {
  const calls: string[] = [];
  let injectedAgoMs: number | undefined = 300;
  const helper = {
    call: async (op: string) => { calls.push(op); return op === 'presence' ? { idleUnknown: true, injectedAgoMs } : op === 'windows' ? [] : {}; },
    running: () => true, dispose: async () => {},
  };
  let idle = 60;
  const host = { kind: 'electron', idleSeconds: async () => idle } as unknown as Host;
  const computer = new ComputerService({ host, supervisor: { spawn: () => { throw new Error('no'); } }, resourcesDir: resources, log: new MemoryLogger(), helper: helper as never, platform: 'linux', now: () => 10_000 });
  assert.equal(computer.canControl(), true);
  const instant = { motion: 'instant' as const };
  await computer.click({ x: 5, y: 5, ...instant });
  assert.deepEqual(calls, ['click'], 'idle for a minute: no presence check needed');
  idle = 0; // input within the last second - our own click 300 ms ago
  await computer.click({ x: 5, y: 5, ...instant });
  await computer.drag({ x1: 5, y1: 5, x2: 50, y2: 5, ...instant });
  assert.deepEqual(calls.slice(1), ['presence', 'click', 'presence', 'path'], 'consecutive steps are not taken for the person');
  injectedAgoMs = 2500; // the newest input is clearly after our own: the person
  await assert.rejects(computer.click({ x: 5, y: 5, ...instant }), code('conflict', /The person is using the computer/));
  assert.equal(calls.at(-1), 'presence', 'nothing was clicked');
});

test('presence: tick counts where the helper has them; the host seconds otherwise; no idle source on a headless PC means no input', () => {
  assert.doesNotThrow(() => judgePresence({ idleMs: 5000, injectedAgoMs: null }));
  assert.throws(() => judgePresence({ idleMs: 100, injectedAgoMs: 2000 }), code('conflict'));
  assert.doesNotThrow(() => judgePresence({ idleMs: 100, injectedAgoMs: 200 }), 'our own input');
  assert.throws(() => judgePresence({ idleMs: 100 }), code('conflict'), 'input, and none of ours');
  assert.doesNotThrow(() => judgePresence({ idleUnknown: true, injectedAgoMs: 1500 }, 1000), 'within the host second');
  assert.throws(() => judgePresence({ idleUnknown: true, injectedAgoMs: 2500 }, 1000), code('conflict'));
  assert.throws(() => judgePresence({ idleUnknown: true, injectedAgoMs: 100 }), code('unavailable', /cannot tell whether the person is using it/));
});
