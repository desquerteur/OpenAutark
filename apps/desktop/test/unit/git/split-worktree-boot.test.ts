// B-057 I3 over real git (worktreeFixture): the boot sweep of split worktrees (sweepSplitWorktrees – splits reconcile)
// closes the open folders of parts that ended without their finish, commits what they left on their branch and keeps
// the branch, leaves a part that still runs alone; the person's splits.branch RPC merges a done part's own branch into
// the folder it started from (as the person) or discards an ended part's branch, records the outcome on the part
// (markBranch), and refuses phones without 'manage', parts without a branch, parts that still run, a merge of a part
// that did not end done, and a branch already merged or discarded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { splitRecordOf } from '../../../src/runtime/git/records.ts';
import { finishSplitWorktree, openSplitWorktree, sweepSplitWorktrees } from '../../../src/runtime/git/split-worktree.ts';
import { register } from '../../../src/runtime/rpc/handlers/splits.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { SplitRepo } from '../../../src/runtime/store/splits.ts';
import type { SplitService } from '../../../src/runtime/contracts/splits.ts';
import type { Split, SplitGroup, SplitStatus } from '../../../src/shared/model/splits.ts';
import { OWNER, PHONE, TestClient } from '../rpc/s1-helpers.ts';
import { GIT_SKIP, git, gitCode, worktreeFixture } from './helpers.ts';

const skip = GIT_SKIP;
const T = Date.UTC(2026, 10, 30, 9, 0, 0);

function setup() {
  const table = new HandlerTable();
  register(table);
  const f = worktreeFixture({ table });
  for (const id of ['ag_ada', 'ag_bob']) f.db.run(`INSERT OR IGNORE INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES (?, ?, '{}', 'human', 0, 0)`, [id, id]);
  const rows = new SplitRepo(f.db);
  const site = f.repo('site', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const group: SplitGroup = { id: 'sg_1', agentId: 'ag_ada', parentRunId: 'run_parent', conversationId: f.chat.id, thread: f.chat.id, cwd: site, goal: 'Change the site', ultra: false, status: 'settled', parts: 3, createdAt: T };
  rows.saveGroup(group);
  // A split service over the rows: get (with its group) and markBranch (as the split core records it).
  const view = (split: Split) => ({ ...split, runs: 1 });
  const splits: Pick<SplitService, 'get' | 'markBranch'> = {
    get: (splitId) => {
      const split = rows.getSplit(splitId);
      const g = split && rows.getGroup(split.groupId);
      return split && g ? { split: view(split), group: { ...g, splits: rows.listSplits({ groupId: g.id }).map(view) } } : undefined;
    },
    markBranch: (splitId, branch) => { rows.updateSplit(splitId, { branch: { ...rows.getSplit(splitId)?.branch, ...branch } }); },
  };
  f.services.splits = splits as SplitService;
  const part = (idx: number, title: string, over: Partial<Split> = {}): Split => {
    const value: Split = { id: `sp_10000${idx}`, groupId: group.id, agentId: 'ag_ada', idx, of: 3, title, brief: 'Do it.', context: 'brief', after: [], worktree: true, status: 'running', attempts: 1, createdAt: T + idx, ...over };
    rows.saveSplit(value);
    return value;
  };
  /** A worktree part that changed `file` and ended `status` – its work committed on its branch, the branch on the row. */
  const ended = async (idx: number, file: string, status: SplitStatus = 'done') => {
    const split = part(idx, `Change ${file}`);
    const opened = await openSplitWorktree(f.services, group, split);
    writeFileSync(path.join(opened.cwd, file), `part ${idx}\n`);
    const done = { ...rows.updateSplit(split.id, { status })!, of: split.of };
    const { stat } = await finishSplitWorktree(f.services, done);
    rows.updateSplit(split.id, { branch: { name: opened.branch, ...(stat ? { stat } : {}) } });
    return { split: done, branch: opened.branch };
  };
  const hasBranch = (branch: string) => gitCode(site, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], f.env) === 0;
  return { ...f, rows, site, group, part, ended, hasBranch, owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE) };
}

const code = async (promise: Promise<unknown>) => { try { await promise; return 'ok'; } catch (error) { return `${(error as { code?: string }).code}: ${(error as Error).message}`; } };

test("boot sweep: an ended part's open folder is closed, its leftover work committed on its kept branch; a running part stays", { skip }, async () => {
  const f = setup();
  try {
    const crashed = f.part(1, 'Crashed');
    const running = f.part(2, 'Running');
    const w1 = await openSplitWorktree(f.services, f.group, crashed);
    const w2 = await openSplitWorktree(f.services, f.group, running);
    writeFileSync(path.join(w1.cwd, 'a.txt'), 'unsaved\n');
    f.rows.updateSplit(crashed.id, { status: 'failed' }); // ended without its finish (the app stopped)
    await sweepSplitWorktrees(f.services);
    assert.equal(splitRecordOf(f.db, crashed.id)?.state, 'closed');
    assert.ok(!existsSync(w1.cwd), 'its folder is removed');
    assert.ok(f.hasBranch(w1.branch), 'its branch with work on it is kept');
    assert.equal(git(f.site, ['show', `${w1.branch}:a.txt`], f.env), 'unsaved\n', 'nothing it left is lost');
    assert.equal(splitRecordOf(f.db, running.id)?.state, 'active');
    assert.ok(existsSync(w2.cwd), 'a part that still runs keeps its folder');
    await sweepSplitWorktrees(f.services); // idempotent
    assert.equal(splitRecordOf(f.db, running.id)?.state, 'active');
  } finally { await f.settled(); f.cleanup(); }
});

