// The window's crash rule (main/window-recovery.ts): a crash reloads, more than MAX_RELOADS within WINDOW_MS
// stops and asks; a clean exit or a killed process is left alone; a blocked renderer is never retried.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RELOADS, RendererRecovery, WINDOW_MS, stuckDialog } from '../../../src/main/window-recovery.ts';

test('a crash reloads; too many within a minute stop and ask; reset starts over', () => {
  let now = 0;
  const recovery = new RendererRecovery({ now: () => now });
  for (let i = 0; i < MAX_RELOADS; i++) assert.equal(recovery.gone('crashed').kind, 'reload');
  assert.deepEqual(recovery.gone('oom'), { kind: 'stuck', why: 'repeated' });
  recovery.reset();
  assert.equal(recovery.gone('crashed').kind, 'reload');
  now += WINDOW_MS;
  for (let i = 0; i < MAX_RELOADS - 1; i++) assert.equal(recovery.gone('crashed').kind, 'reload', 'older crashes are forgotten');
});

test('clean exits and killed processes are left alone; a blocked renderer is never retried', () => {
  const recovery = new RendererRecovery({ now: () => 0 });
  assert.equal(recovery.gone('clean-exit').kind, 'ignore');
  assert.equal(recovery.gone('killed').kind, 'ignore');
  assert.deepEqual(recovery.gone('integrity-failure'), { kind: 'stuck', why: 'blocked' });
  assert.match(stuckDialog('blocked').detail, /blocked the window's code/);
  assert.deepEqual(stuckDialog('repeated').buttons, ['Try again', 'Close window']);
});
