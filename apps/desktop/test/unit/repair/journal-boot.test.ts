// Start guard (repair/journal.ts, repair/boot.ts): an upgrade failure shows the repair screen in
// the same start; other failures and hard crashes count, the start after MAX_ATTEMPTS of them
// shows it (crash_loop); a stable runtime or a clean stop resets the count; the pinned problem
// stays across restarts until Retry (clearRepair) or another app version; errors are one
// redacted line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UpgradeError } from '../../../src/runtime/db/upgrade.ts';
import { guardedBoot } from '../../../src/runtime/repair/boot.ts';
import { BootJournal, MAX_ATTEMPTS, STABLE_MS } from '../../../src/runtime/repair/journal.ts';

function journalIn(t: { after(fn: () => void): void }): BootJournal {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 0;
  return new BootJournal({ dataDir: dir, now: () => ++now });
}

test('hard crashes before the runtime is stable count; the start after three shows the crash loop', (t) => {
  const journal = journalIn(t);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    assert.deepEqual(journal.begin('1.0.0'), { attempt });
    if (attempt === 2) journal.up(); // ready, but died before STABLE_MS
  }
  const { problem } = journal.begin('1.0.0');
  assert.equal(problem?.code, 'crash_loop');
  assert.equal(problem?.attempts, MAX_ATTEMPTS);
  assert.equal(journal.begin('1.0.0').problem?.code, 'crash_loop', 'pinned across restarts');
  journal.stopped();
  assert.equal(journal.begin('1.0.0').problem?.code, 'crash_loop', 'a clean stop of the repair runtime keeps it');
  journal.clearRepair();
  assert.deepEqual(journal.begin('1.0.0'), { attempt: 1 }, 'Retry: the next start runs normally');
});

test('a stable runtime and a clean stop reset the count; another version starts fresh', (t) => {
  const journal = journalIn(t);
  journal.begin('1.0.0');
  journal.begin('1.0.0');
  journal.up();
  journal.stable();
  assert.deepEqual(journal.begin('1.0.0'), { attempt: 1 });
  journal.up();
  journal.stopped();
  assert.deepEqual(journal.begin('1.0.0'), { attempt: 1 });
  journal.begin('1.0.0');
  journal.begin('1.0.0');
  assert.deepEqual(journal.begin('1.0.1'), { attempt: 1 }, 'an update starts counting again');
  journal.failed(new UpgradeError('migration_failed', 'x'), '1.0.1');
  assert.deepEqual(journal.begin('1.0.2'), { attempt: 1 }, 'a newer version is tried even after a pinned problem');
});

test('failed(): an upgrade problem pins at once with the schemas; other errors only on the last attempt, redacted', (t) => {
  const journal = journalIn(t);
  journal.begin('2.0.0');
  assert.equal(journal.failed(new Error('listen EADDRINUSE token=abcdef1234567890 at C:\\Users\\anna\\x'), '2.0.0'), undefined);
  assert.equal(journal.read()?.lastError, 'listen EADDRINUSE token=[redacted] at C:\\Users\\[user]\\x');
  journal.begin('2.0.0');
  journal.begin('2.0.0');
  const loop = journal.failed(new Error('boom\nstack line'), '2.0.0');
  assert.deepEqual({ code: loop?.code, attempts: loop?.attempts, detail: loop?.detail }, { code: 'crash_loop', attempts: 3, detail: 'boom' });

  const other = journalIn(t);
  other.begin('2.0.0');
  const error = new UpgradeError('schema_newer', 'newer data', { dataSchema: 99 });
  const problem = other.failed(error, '2.0.0');
  assert.deepEqual({ code: problem?.code, dataSchema: problem?.dataSchema, appSchema: problem?.appSchema, detail: problem?.detail }, { code: 'schema_newer', dataSchema: 99, appSchema: error.appSchema, detail: 'newer data' });
  assert.equal(other.begin('2.0.0').problem?.code, 'schema_newer');
});

test('guardedBoot: runtime → up + one stable timer; upgrade error → repair in this process; other error → rethrown, repair at the next start', async (t) => {
  const journal = journalIn(t);
  const timers: number[] = [];
  const later = (fn: () => void, ms: number) => { timers.push(ms); fn(); };
  const ok = await guardedBoot({ journal, version: '3.0.0', start: async () => 'runtime', repair: () => 'repair', later });
  assert.deepEqual(ok, { kind: 'runtime', runtime: 'runtime' });
  assert.deepEqual(timers, [STABLE_MS]);
  assert.equal(journal.read()?.phase, 'stable');

  const failing = await guardedBoot({ journal, version: '3.0.0', start: async () => { throw new UpgradeError('migration_failed', 'schema 40 failed', { dataSchema: 40 }); }, repair: (problem) => `repair:${problem.code}`, later });
  assert.equal(failing.kind, 'repair');
  assert.equal(failing.kind === 'repair' && failing.repair, 'repair:migration_failed');

  const fresh = journalIn(t);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await assert.rejects(guardedBoot({ journal: fresh, version: '3.0.0', start: async () => { throw new Error('port busy'); }, repair: () => 'repair', later }), /port busy/);
  }
  const next = await guardedBoot({ journal: fresh, version: '3.0.0', start: async () => 'never', repair: (problem) => problem, later });
  assert.equal(next.kind, 'repair', 'the start after three failures shows the repair screen');
  assert.equal(next.kind === 'repair' && next.problem.detail, 'port busy');
});
