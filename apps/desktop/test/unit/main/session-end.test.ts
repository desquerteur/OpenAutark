// "Keep agents running" (B-044, src/main/session-end.ts): the system ending the session is a deliberate
// end. Linux: powerMonitor 'shutdown' (not macOS, where Electron emits it on the person's Cmd+Q / Dock Quit
// as well). Windows: one hidden native window (never shown, no taskbar
// entry) receives 'session-end' also while the person's window is closed to the tray, and every
// BrowserWindow reports it too; the mark {state:'quit', by:'system'} is on disk at once, the quit that
// follows keeps it, and the next launcher start resumes without counting an unexpected end.
// Owns: these assertions only. Never: Electron or the real profile.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStateMarks, decideLaunch, readRunState, writeRunState } from '../../../src/main/launcher.ts';
import { watchSessionEnd, type SessionEndElectron } from '../../../src/main/session-end.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-session-end-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function fakes(platform: string, options: { failWindow?: boolean } = {}) {
  const app = new EventEmitter();
  const powerMonitor = new EventEmitter();
  const windows: Array<{ options: unknown; events: EventEmitter }> = [];
  class FakeBaseWindow extends EventEmitter {
    constructor(windowOptions: unknown) {
      super();
      if (options.failWindow) throw new Error('no window');
      windows.push({ options: windowOptions, events: this });
    }
  }
  const electron = { platform, app, powerMonitor, BaseWindow: FakeBaseWindow } as unknown as SessionEndElectron;
  return { electron, app, powerMonitor, windows };
}

test('Linux: powerMonitor shutdown; no window', () => {
  const f = fakes('linux');
  let ended = 0;
  watchSessionEnd(f.electron, () => { ended++; });
  f.powerMonitor.emit('shutdown');
  assert.equal(ended, 1);
  assert.equal(f.windows.length, 0);
  assert.equal(f.app.listenerCount('browser-window-created'), 0);
});

test('macOS: no shutdown listener – Electron emits it on Cmd+Q and the Dock\'s Quit too (the person\'s quit)', () => {
  const f = fakes('darwin');
  let ended = 0;
  watchSessionEnd(f.electron, () => { ended++; });
  assert.equal(f.powerMonitor.listenerCount('shutdown'), 0);
  f.powerMonitor.emit('shutdown');
  assert.equal(ended, 0);
  assert.equal(f.windows.length, 0);
});

test('Windows: no shutdown listener either (session-end only)', () => {
  const f = fakes('win32');
  watchSessionEnd(f.electron, () => {});
  assert.equal(f.powerMonitor.listenerCount('shutdown'), 0);
});

test('Windows: a hidden window receives session-end while no other window exists; BrowserWindows report it too', () => {
  const f = fakes('win32');
  let ended = 0;
  watchSessionEnd(f.electron, () => { ended++; });
  assert.equal(f.windows.length, 1);
  assert.deepEqual(f.windows[0].options, { show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false });
  f.windows[0].events.emit('session-end', { reasons: ['logoff'] });
  assert.equal(ended, 1, 'the person\'s window is closed to the tray: the hidden one still reports it');
  const browserWindow = new EventEmitter();
  f.app.emit('browser-window-created', {}, browserWindow);
  browserWindow.emit('session-end', { reasons: ['shutdown'] });
  assert.equal(ended, 2);
  assert.equal(f.windows[0].events.listenerCount('query-session-end'), 0, 'a cancelled shutdown leaves no mark');
  const lines: string[] = [];
  const failing = fakes('win32', { failWindow: true });
  assert.doesNotThrow(() => watchSessionEnd(failing.electron, () => {}, (line) => lines.push(line)));
  assert.match(lines[0], /session end window not created: no window/);
});

test('the system mark is on disk at once, survives the quit that follows, and the next launcher start resumes quietly', () => {
  const dir = path.join(tmp, 'marks');
  const now = Date.UTC(2026, 9, 25, 22, 0);
  writeRunState(dir, { state: 'running', at: now - 60_000, pid: 5 });
  const marks = new RunStateMarks(dir, undefined, () => now);
  const f = fakes('win32');
  watchSessionEnd(f.electron, () => marks.quit('system'));
  f.windows[0].events.emit('session-end', { reasons: ['shutdown'] });
  assert.deepEqual(readRunState(dir), { state: 'quit', by: 'system', at: now });
  marks.quit('person'); // before-quit of the ending process
  assert.equal(readRunState(dir)?.by, 'system');
  // Fast Startup: the boot time does not reset – without the mark this would be an unexpected end.
  const next = decideLaunch({ previous: readRunState(dir), source: 'task', nextDue: null, now: now + 8 * 3_600_000, bootAt: now - 86_400_000, pid: 6 });
  assert.deepEqual(next, { start: true, reason: 'resume', handoff: true }, 'the sign-in start goes on');
  assert.equal(next.notice, undefined, 'no "Restarted after an unexpected close"');
  const detached = decideLaunch({ previous: readRunState(dir), source: 'person', nextDue: null, now: now + 8 * 3_600_000, bootAt: now - 86_400_000, pid: 7 });
  assert.equal(detached.write?.ends, undefined, 'no unexpected end counted by the detached start either');
});
