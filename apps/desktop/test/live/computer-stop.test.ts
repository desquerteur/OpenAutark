// LIVE (opt-in, MP7): the person's Stop ends a running drag at once. A slow drag runs over the
// label of a disposable WinForms window this test opens itself (fixtures/cu-form.ps1); Stop
// after 600 ms must end the call within a second with "Stopped by the person", leave the pointer
// short of the drag's end and refuse the next input; after Resume the helper starts again, and the
// mouse button the cut drag held is let go (the helper's 'release' op, sent after the Stop).
// Moves the real mouse, so it runs only when the person agreed to real input as well (like the
// keyboard and mouse part of computer-use.test.ts; WORKFORCE_LIVE=1 alone never moves anything):
//   WORKFORCE_LIVE=1 WORKFORCE_LIVE_COMPUTER=1 node --test test/live/computer-stop.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WindowsHelper } from '../../src/runtime/computer/helper.ts';
import { ComputerService } from '../../src/runtime/computer/service.ts';
import { Supervisor } from '../../src/runtime/system/supervisor.ts';
import { MemoryLogger } from '../../src/runtime/system/log.ts';
import type { Host } from '../../src/runtime/host.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const live = process.env.WORKFORCE_LIVE === '1' && process.platform === 'win32';
/** Real mouse input only when the person agreed to it as well. */
const input = live && process.env.WORKFORCE_LIVE_COMPUTER === '1';

test('Stop aborts a drag in progress', { skip: input ? false : 'moves the real mouse: set WORKFORCE_LIVE=1 and WORKFORCE_LIVE_COMPUTER=1 (on Windows)', timeout: 120_000 }, async (t) => {
  const form = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'fixtures', 'cu-form.ps1')], { stdio: 'ignore' });
  const log = new MemoryLogger();
  const helper = new WindowsHelper({ supervisor: new Supervisor({ log }), scriptPath: path.join(root, 'resources', 'computer', 'windows-helper.ps1'), log, appPids: () => [process.pid] });
  // An Electron-like host that reports the person idle: this check is about Stop, not human priority.
  const host = {
    kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
    app: { version: '0.0.0', packaged: false, resourcesDir: root, dataDir: root, executable: process.execPath },
    async idleSeconds() { return 600; },
  } as Host;
  const computer = new ComputerService({ host, supervisor: { spawn: () => { throw new Error('the helper is injected'); } }, resourcesDir: path.join(root, 'resources'), log, helper, platform: 'win32' });
  t.after(async () => { await computer.dispose(); form.kill(); });

  let win: { hwnd: number; title: string; rect?: [number, number, number, number] } | undefined;
  for (let i = 0; i < 40 && !win; i++) {
    win = (await computer.windows()).find((w) => w.title.startsWith('WF-CU-Check'));
    if (!win) await delay(500);
  }
  assert.ok(win?.rect, 'the disposable window appeared');
  const [x, y] = win.rect;
  const from = { x: x + 40, y: y + 150 };
  const to = { x: x + 460, y: y + 150 };

  const started = Date.now();
  const drag = computer.drag({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs: 4000 });
  await delay(600);
  computer.activity.stop();
  await assert.rejects(drag, /Stopped by the person/);
  assert.ok(Date.now() - started < 2000, 'the drag ended at the Stop, not after its 4 s');
  await assert.rejects(computer.click({ x: from.x, y: from.y }), /Stopped by the person/);

  computer.activity.resume();
  const cursor = await helper.call<{ x: number; y: number }>('cursor', {}, { timeoutMs: 60_000 });
  assert.ok(cursor.x < to.x - 50, `the pointer stopped midway (at ${cursor.x}, end ${to.x})`);
  // The Stop's release (or this one, whichever ran first) let go of the button the cut drag held:
  // a second release finds nothing held (the person must not hold a mouse button or Ctrl/Shift/Alt/Win now).
  await helper.call('release', {}, { timeoutMs: 60_000 });
  const again = await helper.call<{ released: string[] }>('release', {}, { timeoutMs: 60_000 });
  assert.deepEqual(again.released, [], 'nothing is held after the Stop');
});
