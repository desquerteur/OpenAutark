// Retention (privacy/retention.ts via PrivacyService): old tool traces and corrected knowledge versions go –
// never open effects, run summaries, current knowledge or the person's references; a pass runs on request, on a
// settings change and at most daily on a finished run (no timer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { PrivacyService } from '../../../src/runtime/privacy/service.ts';
import { DAY_MS } from '../../../src/runtime/knowledge/age.ts';
import type { LifecycleSettings } from '../../../src/shared/model/lifecycle.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import { clock, memoryDb, recordingBus } from '../store/helpers.ts';

function world(lifecycle: LifecycleSettings = {}) {
  const db = memoryDb();
  const time = clock();
  const { bus } = recordingBus();
  const knowledge = new KnowledgeStore({ db, clock: time, bus });
  const settings = { lifecycle };
  const privacy = new PrivacyService({ db, clock: time, bus, settings: () => settings, purgeVersions: (ids) => knowledge.purgeVersions(ids) });
  const run = (id: string, endedAt: number, effect?: string) => {
    db.run(`INSERT INTO runs (id, agent_id, trigger, status, started_at, ended_at, summary) VALUES (?, 'ag_tom', 'message', 'done', ?, ?, 'rendered')`, [id, endedAt - 10, endedAt]);
    db.run(`INSERT INTO run_items (id, run_id, seq, kind, name, data, created_at) VALUES (?, ?, 0, 'tool_call', 'media.look', '{"callId":"c0","args":{"file":"a.mp4"}}', ?)`, [`ri_${id}_0`, id, endedAt]);
    db.run(`INSERT INTO run_items (id, run_id, seq, kind, name, data, effect_status, created_at) VALUES (?, ?, 1, 'tool_call', 'social.post', '{"callId":"c1"}', ?, ?)`, [`ri_${id}_1`, id, effect ?? 'confirmed', endedAt]);
    db.run(`INSERT INTO run_items (id, run_id, seq, kind, data, created_at) VALUES (?, ?, 2, 'tool_result', '{"callId":"c0","ok":true,"summary":"teaser fine"}', ?)`, [`ri_${id}_2`, id, endedAt]);
  };
  const items = (runId: string) => db.all<{ id: string }>('SELECT id FROM run_items WHERE run_id = ? ORDER BY seq', [runId]).map((row) => row.id);
  return { db, clock: time, bus, knowledge, privacy, settings, run, items };
}

test('retention off: nothing is deleted; traceDays deletes old traces but keeps open effects and the run', () => {
  const f = world();
  const now = f.clock.now();
  f.run('run_old', now - 40 * DAY_MS);
  f.run('run_open', now - 40 * DAY_MS, 'unknown');
  f.run('run_new', now - 2 * DAY_MS);
  const off = f.privacy.applyRetention();
  assert.deepEqual({ traces: off.traces, versions: off.versions }, { traces: 0, versions: 0 });

  f.settings.lifecycle = { retention: { traceDays: 30 } };
  const pass = f.privacy.applyRetention();
  assert.equal(pass.traces, 5); // run_old: 3 items, run_open: 2 (its unknown effect stays)
  assert.deepEqual(f.items('run_old'), []);
  assert.deepEqual(f.items('run_open'), ['ri_run_open_1'], 'an unknown effect is never forgotten');
  assert.equal(f.items('run_new').length, 3);
  assert.ok(f.db.get(`SELECT 1 AS ok FROM runs WHERE id = 'run_old'`), 'the run row (summary, cost) stays');
});

test('historyDays deletes old corrected versions, never the current one or references', async () => {
  const f = world({ retention: { historyDays: 30 } });
  const first = f.knowledge.save({ scope: 'global', kind: 'fact', title: 'Rent', body: 'Rent is 900 EUR', createdBy: 'human' });
  const second = f.knowledge.correct(first.id, { body: 'Rent is 950 EUR' }, 'human');
  const reference = f.knowledge.save({ scope: 'reference', scopeId: 'human', kind: 'reference', title: 'Why', body: 'Because quality matters', createdBy: 'human' });
  f.knowledge.expire(reference.id, 'human');
  f.clock.advance(31 * DAY_MS);
  const pass = f.privacy.applyRetention();
  assert.equal(pass.versions, 1);
  assert.equal(f.knowledge.history(second.id).length, 1, 'only the current version is left');
  assert.ok(f.knowledge.get(second.id), 'the current version stays');
  assert.ok(f.knowledge.get(reference.id), "the person's references keep their own lifecycle");
  assert.deepEqual((await f.knowledge.search({ text: 'Rent EUR' })).map((hit) => hit.item.id), [second.id]);
});

test('passes run on a settings change and at most daily on a finished run – never on a timer', () => {
  const f = world();
  f.privacy.start();
  const now = f.clock.now();
  f.run('run_a', now - 40 * DAY_MS);
  f.bus.emit('run.upserted', { id: 'run_x', agentId: 'ag_tom', status: 'done', endedAt: now, trigger: 'message' } as Run);
  assert.equal(f.items('run_a').length, 3, 'retention off: a finished run changes nothing');
  f.settings.lifecycle = { retention: { traceDays: 30 } };
  f.bus.emit('settings.updated', f.settings as never);
  assert.equal(f.items('run_a').length, 0, 'a new retention applies at once');
  f.run('run_b', now - 40 * DAY_MS);
  f.bus.emit('run.upserted', { id: 'run_y', agentId: 'ag_tom', status: 'done', endedAt: now, trigger: 'message' } as Run);
  assert.equal(f.items('run_b').length, 3, 'the last pass is less than a day old');
  f.clock.advance(DAY_MS);
  f.bus.emit('run.upserted', { id: 'run_z', agentId: 'ag_tom', status: 'running', trigger: 'message' } as Run);
  assert.equal(f.items('run_b').length, 3, 'a running run is no trigger');
  f.bus.emit('run.upserted', { id: 'run_z', agentId: 'ag_tom', status: 'done', endedAt: f.clock.now(), trigger: 'message' } as Run);
  assert.equal(f.items('run_b').length, 0);
  f.privacy.stop();
});
