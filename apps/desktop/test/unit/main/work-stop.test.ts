// The emergency stop of all agent work on the main side (23.10., main/work-stop.ts + main/tray.ts):
// the global shortcut Ctrl+Alt+Shift+X is registered only while agents work on this PC (never while
// idle, stopped or with the runtime gone), pressing it or the tray entry calls work.stop at once – no
// confirmation – and a system notice says what happened (also when it failed); the tray offers
// "Stop all agent work" while the runtime is up and "Resume agent work" after the stop. Keys held by
// another company are tried again on each change and on a quiet retry (B-072).
// Owns: these assertions only. Never: Electron, real shortcuts, notifications or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkStopControl, stopNotice, type ShortcutRegistry, type TrayWorkStop } from '../../../src/main/work-stop.ts';
import { trayMenu, trayTooltip } from '../../../src/main/tray.ts';
import { WORK_STOP_ACCELERATOR, type WorkStopState } from '../../../src/shared/model/work-stop.ts';

function rig(initial: WorkStopState, options: { failStop?: boolean } = {}) {
  let listener: ((state: WorkStopState) => void) | undefined;
  const calls: string[] = [];
  const subscribed: string[] = [];
  let answer = initial;
  const rpc = {
    async call(method: string) {
      calls.push(method);
      if (method === 'work.stop') {
        if (options.failStop) throw new Error('The runtime is restarting.');
        answer = { stopped: true, at: answer.at + 1, stoppedRuns: 2, working: true };
      }
      if (method === 'work.resume') answer = { stopped: false, at: answer.at + 1, working: false };
      return answer;
    },
    on(_event: string, fn: (state: WorkStopState) => void) { listener = fn; return () => { listener = undefined; }; },
    async subscribe(topic: string) { subscribed.push(topic); return () => {}; },
  };
  const held = new Map<string, () => void>();
  const shortcut: ShortcutRegistry & { taken?: boolean } = {
    register(accelerator, callback) { if (shortcut.taken) return false; held.set(accelerator, callback); return true; },
    unregister(accelerator) { held.delete(accelerator); },
  };
  const views: TrayWorkStop[] = [];
  const notices: Array<{ title: string; body: string }> = [];
  const lines: string[] = [];
  const control = new WorkStopControl({
    rpc: rpc as never, shortcut, tray: { setWorkStop: (view) => views.push(view) },
    notify: (title, body) => notices.push({ title, body }), log: (line) => lines.push(line),
  });
  return { control, calls, subscribed, held, shortcut, views, notices, lines, emit: (state: WorkStopState) => listener?.(state) };
}

const idle: WorkStopState = { stopped: false, at: 1, working: false };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the shortcut exists only while agents work; pressing it stops at once and a notice follows', async () => {
  const r = rig(idle);
  await r.control.start();
  assert.deepEqual(r.subscribed, ['system']);
  assert.deepEqual(r.calls, ['work.state']);
  assert.equal(r.held.size, 0, 'idle: the keys stay with other apps');
  assert.deepEqual(r.views.at(-1), { kind: 'ready', shortcut: false }, 'the tray offers the stop anyway');

  r.emit({ ...idle, working: true });
  assert.ok(r.held.has(WORK_STOP_ACCELERATOR));
  assert.deepEqual(r.views.at(-1), { kind: 'ready', shortcut: true });

  r.held.get(WORK_STOP_ACCELERATOR)!();
  await settle();
  assert.deepEqual(r.calls, ['work.state', 'work.stop'], 'no confirmation step');
  assert.equal(r.held.size, 0, 'stopped: nothing left to stop');
  assert.deepEqual(r.views.at(-1), { kind: 'stopped' });
  assert.deepEqual(r.notices, [{ title: 'Agent work stopped', body: '2 running turns were ended. Nothing runs until you press Resume (tray or window).' }]);

  r.emit({ ...idle, working: true, at: 1 });
  assert.deepEqual(r.views.at(-1), { kind: 'stopped' }, 'an older event never undoes the newer stop');
  r.emit({ stopped: true, at: 2, stoppedRuns: 2, working: false }); // the turns ended (same latch time)
  assert.deepEqual(r.views.at(-1), { kind: 'stopped' });

  await r.control.resume();
  assert.equal(r.calls.at(-1), 'work.resume');
  assert.deepEqual(r.views.at(-1), { kind: 'ready', shortcut: false });
  assert.equal(r.notices.length, 1, 'Resume needs no notice');
});

test('a stop from the phone shows in the tray; a failed stop says so; a gone runtime drops shortcut and entry; a taken shortcut is logged once', async () => {
  const r = rig({ stopped: false, at: 5, working: true });
  await r.control.start();
  r.emit({ stopped: true, at: 6, stoppedFrom: 'Pixel 9' });
  assert.deepEqual(r.views.at(-1), { kind: 'stopped', from: 'Pixel 9' });
  assert.equal(r.notices.length, 0, 'the notice belongs to a stop pressed here');
  r.control.reset();
  assert.equal(r.held.size, 0);
  assert.equal(r.views.at(-1), null);

  const failing = rig({ stopped: false, at: 1, working: true }, { failStop: true });
  await failing.control.start();
  await failing.control.stop();
  assert.deepEqual(failing.notices.map((notice) => notice.title), ['Agent work was not stopped']);
  assert.ok(failing.lines.some((line) => /agent work not stopped: The runtime is restarting\./.test(line)));
  assert.ok(failing.held.has(WORK_STOP_ACCELERATOR), 'still offered: nothing changed');

  const taken = rig(idle);
  taken.shortcut.taken = true;
  await taken.control.start();
  taken.emit({ ...idle, working: true, at: 2 });
  taken.emit({ ...idle, working: true, at: 3 });
  assert.equal(taken.lines.filter((line) => /taken by another app/.test(line)).length, 1);
  assert.deepEqual(taken.views.at(-1), { kind: 'ready', shortcut: false }, 'the tray entry names no keys it does not hold');
  taken.control.dispose();
});

test('another company holds the keys: this one takes them on the next change or retry once they are free (B-072)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const r = rig(idle);
  r.shortcut.taken = true;
  await r.control.start();
  r.emit({ ...idle, working: true, at: 2 });
  assert.equal(r.held.size, 0);
  r.shortcut.taken = false; // the holder's agents went idle
  r.emit({ ...idle, working: true, at: 3 });
  assert.ok(r.held.has(WORK_STOP_ACCELERATOR), 'a change tries again');

  const quiet = rig(idle);
  quiet.shortcut.taken = true;
  await quiet.control.start();
  quiet.emit({ ...idle, working: true, at: 2 });
  t.mock.timers.tick(10_000);
  assert.equal(quiet.held.size, 0);
  quiet.shortcut.taken = false;
  t.mock.timers.tick(10_000);
  assert.ok(quiet.held.has(WORK_STOP_ACCELERATOR), 'the retry takes them without a change');
  assert.deepEqual(quiet.views.at(-1), { kind: 'ready', shortcut: true });
  assert.equal(quiet.lines.filter((line) => /taken by another app/.test(line)).length, 1, 'retries stay quiet');
  quiet.emit({ ...idle, working: false, at: 3 });
  assert.equal(quiet.held.size, 0, 'idle again: the keys go back');
  r.control.dispose();
});

test('tray: Stop all agent work (keys only while registered), Resume after the stop, tooltip line; notice wording', () => {
  const deps = { onOpen() {}, onQuit() {}, onStopWork() {}, onResumeWork() {} };
  assert.deepEqual(trayMenu(deps, null).map((item) => item.label ?? item.type), ['Open', 'separator', 'Quit'], 'runtime down: no entry');
  const ready = trayMenu(deps, { kind: 'ready', shortcut: true });
  assert.deepEqual(ready.map((item) => item.label ?? item.type), ['Open', 'Stop all agent work', 'separator', 'Quit']);
  assert.deepEqual([ready[1].accelerator, ready[1].registerAccelerator], ['Ctrl+Alt+Shift+X', false]);
  assert.equal(trayMenu(deps, { kind: 'ready', shortcut: false })[1].accelerator, undefined);
  assert.deepEqual(trayMenu(deps, { kind: 'stopped' }).map((item) => item.label ?? item.type), ['Open', 'Resume agent work', 'separator', 'Quit']);
  assert.equal(trayTooltip('Workforce', 2, { kind: 'stopped' }), 'Workforce (2) – Agent work stopped');
  assert.equal(trayTooltip('Workforce', 0, { kind: 'ready', shortcut: true }), 'Workforce');
  assert.equal(stopNotice({ stopped: true, at: 1, stoppedRuns: 1 }).body, '1 running turn was ended. Nothing runs until you press Resume (tray or window).');
  assert.equal(stopNotice({ stopped: true, at: 1 }).body, 'Nothing runs until you press Resume (tray or window).');
});

test('a double press (or tray plus keys) before the answer sends one work.stop and shows one notice', async () => {
  const r = rig({ stopped: false, at: 1, working: true });
  await r.control.start();
  const first = r.control.stop();
  const second = r.control.stop();
  r.held.get(WORK_STOP_ACCELERATOR)?.();
  assert.equal(first, second, 'the stop on its way is shared');
  await first;
  await settle();
  assert.deepEqual(r.calls, ['work.state', 'work.stop']);
  assert.equal(r.notices.length, 1);
  await r.control.stop(); // a later press asks again (the runtime answers the stopped state)
  assert.equal(r.calls.filter((method) => method === 'work.stop').length, 2);
});
