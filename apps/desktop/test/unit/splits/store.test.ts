// B-057 foundation: the split repository (runtime/store/splits.ts) – group and split rows round-trip with their JSON
// columns (after, fork, branch) and 0/1 flags, the derived parts / of counts, the listing filters, patches (absent key
// kept, present undefined cleared), the cascade from agent to group to splits, and the runs repo's split_id mapping
// with its top-level and per-split listings.
// Owns: these repository checks. Never: split lifecycle behaviour (runtime/splits/**).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SplitRepo } from '../../../src/runtime/store/splits.ts';
import { RunRepo } from '../../../src/runtime/store/runs.ts';
import type { Split, SplitGroup } from '../../../src/shared/model/splits.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import { memoryDb } from '../store/helpers.ts';

const T = 1_700_000_000_000;

function setup() {
  const db = memoryDb();
  for (const id of ['ag_ava', 'ag_ben']) {
    db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES (?, ?, '{}', 'human', 0, 0)`, [id, id]);
  }
  return { db, repo: new SplitRepo(db), runs: new RunRepo(db) };
}

const group = (over: Partial<SplitGroup> = {}): SplitGroup => ({
  id: 'sg_1', agentId: 'ag_ava', parentRunId: 'rn_parent', conversationId: 'cv_1', thread: 'cv_1', modeKey: 'code',
  cwd: 'C:/work/repo', goal: 'Review the release', ultra: true, status: 'pending', parts: 0, createdAt: T, ...over,
});

const split = (idx: number, over: Partial<Split> = {}): Split => ({
  id: `sp_${idx}`, groupId: 'sg_1', agentId: 'ag_ava', idx, of: 0, title: `Part ${idx}`, brief: `Do part ${idx}.`,
  context: 'fork', after: [], worktree: false, status: 'pending', attempts: 0, createdAt: T + idx, ...over,
});

test('a group and its splits round-trip, with JSON columns, flags and the derived counts', () => {
  const { repo } = setup();
  repo.saveGroup(group({ origin: { source: 'app:mail', label: 'New mail' }, taskId: 'tk_1' }));
  repo.saveSplit(split(1, { returns: 'A list of findings', model: 'cheap', effort: 'low' }));
  repo.saveSplit(split(2, {
    context: 'brief', after: [1], worktree: true, fork: { how: 'native', engine: 'codex', accountId: 'acc_1', parentRef: 'th_1' },
    branch: { name: 'wf/split-2', stat: '2 files changed', merged: 'conflict' },
  }));

  assert.deepEqual(repo.getGroup('sg_1'), group({ origin: { source: 'app:mail', label: 'New mail' }, taskId: 'tk_1', parts: 2 }));
  assert.deepEqual(repo.getSplit('sp_1'), split(1, { returns: 'A list of findings', model: 'cheap', effort: 'low', of: 2 }));
  const second = repo.getSplit('sp_2')!;
  assert.deepEqual(second.after, [1]);
  assert.equal(second.worktree, true);
  assert.equal(second.context, 'brief');
  assert.deepEqual(second.fork, { how: 'native', engine: 'codex', accountId: 'acc_1', parentRef: 'th_1' });
  assert.deepEqual(second.branch, { name: 'wf/split-2', stat: '2 files changed', merged: 'conflict' });
  assert.equal(second.of, 2);
  assert.equal(repo.getGroup('sg_missing'), undefined);
  assert.equal(repo.getSplit('sp_missing'), undefined);

  // A second save replaces the stored fields; identity and creation time stay.
  repo.saveGroup(group({ status: 'running', startedAt: T + 10, ultra: false }));
  assert.equal(repo.getGroup('sg_1')?.status, 'running');
  assert.equal(repo.getGroup('sg_1')?.ultra, false);
  assert.equal(repo.getGroup('sg_1')?.startedAt, T + 10);
});

test('idx is unique within a group', () => {
  const { repo } = setup();
  repo.saveGroup(group());
  repo.saveSplit(split(1));
  assert.throws(() => repo.saveSplit(split(1, { id: 'sp_other' })), /UNIQUE/);
});

test('updateSplit and updateGroup: present keys change, undefined clears, absent keys stay', () => {
  const { repo } = setup();
  repo.saveGroup(group());
  repo.saveSplit(split(1, { error: 'The model was busy.', model: 'strong' }));

  const running = repo.updateSplit('sp_1', { status: 'running', attempts: 1, startedAt: T + 5, error: undefined, fork: { how: 'ledger' } });
  assert.equal(running?.status, 'running');
  assert.equal(running?.attempts, 1);
  assert.equal(running?.startedAt, T + 5);
  assert.equal(running?.error, undefined, 'present with undefined clears');
  assert.equal(running?.model, 'strong', 'absent stays');
  assert.deepEqual(running?.fork, { how: 'ledger' });
  assert.deepEqual(repo.updateSplit('sp_1', { after: [], branch: { name: 'wf/split-1' } })?.branch, { name: 'wf/split-1' });
  assert.equal(repo.updateSplit('sp_1', { branch: undefined })?.branch, undefined);
  assert.deepEqual(repo.updateSplit('sp_1', {}), repo.getSplit('sp_1'), 'an empty patch changes nothing');
  assert.equal(repo.updateSplit('sp_missing', { status: 'done' }), undefined);

  const settled = repo.updateGroup('sg_1', { status: 'settled', endedAt: T + 20, ultra: false });
  assert.equal(settled?.status, 'settled');
  assert.equal(settled?.endedAt, T + 20);
  assert.equal(settled?.ultra, false);
  assert.equal(settled?.goal, 'Review the release');
  assert.equal(repo.updateGroup('sg_1', { cwd: undefined })?.cwd, undefined);
  assert.equal(repo.updateGroup('sg_missing', { status: 'stopped' }), undefined);
});

test('listGroups filters by agent, parent run, chat, thread and status, newest first, with a limit', () => {
  const { repo } = setup();
  repo.saveGroup(group({ id: 'sg_a', createdAt: T }));
  repo.saveGroup(group({ id: 'sg_b', createdAt: T + 1, status: 'running', parentRunId: 'rn_2' }));
  repo.saveGroup(group({ id: 'sg_c', createdAt: T + 2, conversationId: undefined, taskId: 'tk_1', thread: 'task:tk_1', status: 'gathered' }));
  repo.saveGroup(group({ id: 'sg_d', createdAt: T + 3, agentId: 'ag_ben', thread: 'cv_2', conversationId: 'cv_2' }));
  const ids = (list: SplitGroup[]) => list.map((g) => g.id);

  assert.deepEqual(ids(repo.listGroups()), ['sg_d', 'sg_c', 'sg_b', 'sg_a']);
  assert.deepEqual(ids(repo.listGroups({ agentId: 'ag_ava' })), ['sg_c', 'sg_b', 'sg_a']);
  assert.deepEqual(ids(repo.listGroups({ parentRunId: 'rn_2' })), ['sg_b']);
  assert.deepEqual(ids(repo.listGroups({ conversationId: 'cv_1' })), ['sg_b', 'sg_a']);
  assert.deepEqual(ids(repo.listGroups({ agentId: 'ag_ava', thread: 'task:tk_1' })), ['sg_c']);
  assert.deepEqual(ids(repo.listGroups({ statuses: ['pending', 'running'] })), ['sg_d', 'sg_b', 'sg_a']);
  assert.deepEqual(ids(repo.listGroups({ statuses: [] })), [], 'an empty status list matches nothing');
  assert.deepEqual(ids(repo.listGroups({ agentId: 'ag_ava', limit: 2 })), ['sg_c', 'sg_b']);
});

test('listSplits filters by group(s), agent and status, a group in idx order', () => {
  const { repo } = setup();
  repo.saveGroup(group({ id: 'sg_1' }));
  repo.saveGroup(group({ id: 'sg_2', agentId: 'ag_ben', createdAt: T + 100 }));
  repo.saveSplit(split(2, { status: 'running' }));
  repo.saveSplit(split(1, { status: 'done' }));
  repo.saveSplit(split(3, { createdAt: T, status: 'queued' }));
  repo.saveSplit(split(1, { id: 'sp_b1', groupId: 'sg_2', agentId: 'ag_ben', createdAt: T + 100 }));
  const ids = (list: Split[]) => list.map((s) => s.id);

  assert.deepEqual(ids(repo.listSplits({ groupId: 'sg_1' })), ['sp_3', 'sp_1', 'sp_2'], 'creation order first');
  assert.deepEqual(repo.listSplits({ groupId: 'sg_1' }).map((s) => s.of), [3, 3, 3]);
  assert.deepEqual(ids(repo.listSplits({ groupIds: ['sg_1', 'sg_2'] })).sort(), ['sp_1', 'sp_2', 'sp_3', 'sp_b1']);
  assert.deepEqual(ids(repo.listSplits({ groupIds: [] })), []);
  assert.deepEqual(ids(repo.listSplits({ agentId: 'ag_ben' })), ['sp_b1']);
  assert.deepEqual(ids(repo.listSplits({ agentId: 'ag_ava', statuses: ['queued', 'running'] })), ['sp_3', 'sp_2']);
  assert.equal(repo.listSplits().length, 4);
});

test('deleting the agent removes its groups and their splits', () => {
  const { db, repo } = setup();
  repo.saveGroup(group());
  repo.saveSplit(split(1));
  db.run(`DELETE FROM agents WHERE id = 'ag_ava'`);
  assert.equal(repo.getGroup('sg_1'), undefined);
  assert.equal(repo.getSplit('sp_1'), undefined);
});

test('runs keep their split id; topLevel leaves split runs out, listBySplit reads them', () => {
  const { runs } = setup();
  const run = (id: string, startedAt: number, splitId?: string): Run => ({
    id, agentId: 'ag_ava', trigger: splitId ? 'split' : 'message', status: 'done', startedAt, ...(splitId ? { splitId } : {}),
  });
  runs.save(run('rn_main', T));
  runs.save(run('rn_s1', T + 1, 'sp_1'));
  runs.save(run('rn_s2', T + 2, 'sp_2'));
  runs.save(run('rn_s1b', T + 3, 'sp_1'));

  assert.equal(runs.get('rn_s1')?.splitId, 'sp_1');
  assert.equal(runs.get('rn_s1')?.trigger, 'split');
  assert.equal(runs.get('rn_main')?.splitId, undefined);
  // A later save without the split id keeps it (a finish never drops it).
  const { splitId: _drop, ...rest } = runs.get('rn_s1')!;
  runs.save({ ...rest, status: 'failed' });
  assert.equal(runs.get('rn_s1')?.splitId, 'sp_1');

  assert.deepEqual(runs.listByAgent('ag_ava', 10).map((r) => r.id), ['rn_s1b', 'rn_s2', 'rn_s1', 'rn_main']);
  assert.deepEqual(runs.listByAgent('ag_ava', 10, { topLevel: true }).map((r) => r.id), ['rn_main']);
  assert.deepEqual(runs.listBySplit(['sp_1']).map((r) => r.id), ['rn_s1', 'rn_s1b']);
  assert.deepEqual(runs.listBySplit(['sp_1', 'sp_2']).map((r) => r.id), ['rn_s1', 'rn_s2', 'rn_s1b']);
  assert.deepEqual(runs.listBySplit([]), []);
});
