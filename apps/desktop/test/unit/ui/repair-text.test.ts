// Repair screen wording (ui/repair/repair-text.ts): one title per start problem; a copy from before
// the update is mentioned only when one exists; a failed safety copy says the data was not changed;
// a copy is labelled by the update it was made before (and as made after an incomplete update);
// a copy newer than this app is not offered; a retry or restore that lands on the repair screen
// again leaves every button enabled (screenStatus).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyLabel, problemText, restorable, screenStatus, type LastAction } from '../../../src/ui/repair/repair-text.ts';
import type { RepairState, StartProblem, UpgradeBackupInfo } from '../../../src/shared/model/repair.ts';

const copy: UpgradeBackupInfo = { id: '0.3.0-s46', appVersion: '0.3.0', schema: 46, bytes: 1, createdAt: 5 };
const problem = (code: StartProblem['code'], extra: Partial<StartProblem> = {}): StartProblem => ({ code, version: '0.3.0', at: 1, ...extra });

test('every problem has its own title; copies are named only when they exist', () => {
  const titles = new Set((['migration_failed', 'schema_newer', 'backup_failed', 'data_unreadable', 'crash_loop'] as const).map((code) => problemText(problem(code), [copy]).title));
  assert.equal(titles.size, 5);
  assert.match(problemText(problem('migration_failed'), [copy]).body.join(' '), /copy of your data from before the update is kept/);
  assert.doesNotMatch(problemText(problem('migration_failed'), []).body.join(' '), /copy/);
  assert.match(problemText(problem('schema_newer'), [copy]).body.join(' '), /restore a copy/);
  assert.doesNotMatch(problemText(problem('schema_newer'), []).body.join(' '), /restore/);
  assert.match(problemText(problem('backup_failed'), [copy]).body.join(' '), /your data was not changed/);
  assert.match(problemText(problem('crash_loop', { attempts: 3 }), []).body[0], /stopped 3 times in a row/);
});

test('a copy is labelled by the update it was made before', () => {
  assert.equal(copyLabel(copy, () => '21 Oct'), 'Before the update to 0.3.0 · 21 Oct');
});

test('a copy of data an incomplete update left behind says so; a copy newer than this app cannot be restored', () => {
  assert.equal(copyLabel({ ...copy, partial: true }, () => '21 Oct'), 'Before the update to 0.3.0 · 21 Oct · after an incomplete update');
  assert.equal(restorable(copy, 46), true);
  assert.equal(restorable({ ...copy, schema: 53 }, 50), false);
});

test('the screen never stays locked: retry or restore are busy only until the runtime answers again', () => {
  const first: RepairState = { active: true, problem: problem('migration_failed', { at: 1 }), backups: [copy], appSchema: 50 };
  assert.deepEqual(screenStatus(null, first), { busy: null, note: null });
  assert.deepEqual(screenStatus({ kind: 'retry', state: first, done: false }, first), { busy: 'retry', note: null }, 'running');
  const sent: LastAction = { kind: 'retry', state: first, done: false, note: { text: 'Starting again…' } };
  assert.deepEqual(screenStatus(sent, first), { busy: 'retry', note: { text: 'Starting again…' } }, 'stays busy until the restart answers');
  // The restarted runtime lands on the repair screen again with the same problem (a deterministic failure).
  const again: RepairState = { ...first, problem: problem('migration_failed', { at: 2 }) };
  assert.deepEqual(screenStatus(sent, again), { busy: null, note: { text: 'Started again: the same problem came back.', error: true } }, 'every button works again');
  // Even the same problem object in a new answer counts as a new state.
  assert.equal(screenStatus(sent, { ...first }).busy, null);
  const restore: LastAction = { kind: 'restore:0.3.0-s46', state: first, done: false };
  assert.deepEqual(screenStatus(restore, { ...first, problem: problem('crash_loop', { attempts: 3 }) }), { busy: null, note: null });
  const failed: LastAction = { kind: 'restore:0.3.0-s46', state: first, done: true, note: { text: 'The data is in use.', error: true } };
  assert.deepEqual(screenStatus(failed, first), { busy: null, note: { text: 'The data is in use.', error: true } }, 'an error frees the buttons at once');
  assert.deepEqual(screenStatus({ kind: 'diagnostics', state: first, done: true, note: { text: 'Saved to x' } }, first).busy, null);
});
