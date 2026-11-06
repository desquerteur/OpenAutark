import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { SpaceRepo } from '../../../src/runtime/store/spaces.ts';
import { KvRepo, MetaRepo } from '../../../src/runtime/store/kv.ts';
import { FileRepo } from '../../../src/runtime/store/files.ts';
import { RunItemRepo, RunRepo } from '../../../src/runtime/store/runs.ts';
import { FeedbackRepo } from '../../../src/runtime/store/feedback.ts';
import { SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { memoryDb } from './helpers.ts';

test('agent rows round-trip including JSON columns and optional fields', () => {
  const db = memoryDb();
  const repo = new AgentRepo(db);
  const agent: Agent = {
    id: 'ag_1', name: 'Mara', role: 'Web developer', avatar: { kind: 'initials', value: 'M', color: 3 },
    instructions: 'Build pages.', mode: 'web', skills: ['a', 'b'], modelPolicy: { effort: 'high' },
    status: 'idle', createdBy: 'human', createdAt: 1, updatedAt: 2,
  };
  repo.save(agent);
  assert.deepEqual(repo.get('ag_1'), agent);
  repo.save({ ...agent, team: 'Web', updatedAt: 3 });
  assert.equal(repo.get('ag_1')?.team, 'Web');
  assert.equal(repo.count(), 1);
  assert.ok(repo.setStatus('ag_1', 'working', 'deploying', 4));
  assert.equal(repo.get('ag_1')?.statusNote, 'deploying');
  repo.save({ ...agent, archivedAt: 5 });
  assert.equal(repo.list().length, 0);
  assert.equal(repo.list(true).length, 1);
});

test('spaces, kv and meta rows', () => {
  const db = memoryDb();
  const spaces = new SpaceRepo(db);
  spaces.upsert({ id: 'sp_1', name: 'Company', kind: 'company', sort: 0, createdAt: 1 });
  assert.deepEqual(spaces.list(), [{ id: 'sp_1', name: 'Company', kind: 'company', sort: 0, createdAt: 1 }]);
  assert.equal(spaces.maxSort(), 0);

  const kv = new KvRepo(db);
  kv.set('legacy', 'connections', [{ id: 'openai' }], 1);
  assert.deepEqual(kv.get('legacy', 'connections'), [{ id: 'openai' }]);
  assert.equal(kv.list('legacy').length, 1);
  assert.ok(kv.delete('legacy', 'connections'));
  assert.equal(kv.get('legacy', 'connections'), undefined);

  const meta = new MetaRepo(db);
  assert.equal(meta.get('schema'), String(SCHEMA_VERSION));
  meta.set('import.v7', 'x');
  assert.equal(meta.get('import.v7'), 'x');
});

test('files keep the first metadata and distinguish "not extracted" from "no text"', () => {
  const repo = new FileRepo(memoryDb());
  const id = 'a'.repeat(64);
  repo.insert({ id, name: 'a.txt', mime: 'text/plain', size: 3, createdAt: 1 });
  repo.insert({ id, name: 'other.txt', mime: 'text/plain', size: 3, createdAt: 2 });
  assert.equal(repo.get(id)?.name, 'a.txt');
  assert.equal(repo.cachedText(id), undefined);
  repo.setText(id, '');
  assert.equal(repo.cachedText(id), '');
  repo.setText(id, 'x'.repeat(1000));
  assert.equal(repo.get(id)?.textPreview?.length, 400);
});

test('runs and run items; idempotency key is unique', () => {
  const db = memoryDb();
  const runs = new RunRepo(db);
  const items = new RunItemRepo(db);
  runs.save({ id: 'run_1', agentId: 'ag_1', trigger: 'message', status: 'running', startedAt: 1, route: { reason: 'pin', by: 'rules', category: 'chat' } });
  assert.deepEqual(runs.get('run_1')?.route, { reason: 'pin', by: 'rules', category: 'chat' });
  items.insert({ id: 'ri_1', runId: 'run_1', seq: 1, kind: 'effect', data: { a: 1 }, effectStatus: 'pending', idemKey: 'k1', createdAt: 1 });
  assert.throws(() => items.insert({ id: 'ri_2', runId: 'run_1', seq: 2, kind: 'effect', data: {}, idemKey: 'k1', createdAt: 1 }));
  assert.equal(items.nextSeq('run_1'), 2);
  assert.equal(items.byIdemKey('k1')?.id, 'ri_1');
  assert.deepEqual(runs.interruptRunning(9), ['run_1']);
  assert.equal(runs.get('run_1')?.status, 'interrupted');
  assert.equal(items.markPendingUnknown().length, 1);
  assert.equal(items.get('ri_1')?.effectStatus, 'unknown');
});

test('feedback rows', () => {
  const db = memoryDb();
  const feedback = new FeedbackRepo(db);
  feedback.save({ id: 'fb_1', kind: 'bug', text: 'Broken', author: 'human', context: { version: '0.2.0', os: 'win32' }, status: 'local', createdAt: 1 });
  feedback.save({ ...feedback.get('fb_1')!, status: 'sent', sentAt: 2 });
  assert.equal(feedback.list()[0].status, 'sent');
});
