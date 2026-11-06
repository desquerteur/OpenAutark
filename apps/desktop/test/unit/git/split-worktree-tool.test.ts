// B-057 S16 agents.split_merge over real git (worktreeFixture, a split service backed by the split rows): only the agent
// that split may call it, never a split's own turn; its description names part, branch and stat; a merge into the
// person's own checkout is raised to write_system (the person approves, like git.merge), a merge into the agent's task
// worktree stays write_local; run merges or discards and hands the outcome to services.splits.markBranch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { splitRecordOf } from '../../../src/runtime/git/records.ts';
import { finishSplitWorktree, openSplitWorktree } from '../../../src/runtime/git/split-worktree.ts';
import { agentIdentity, commitWork } from '../../../src/runtime/git/worktree-ops.ts';
import { SplitRepo } from '../../../src/runtime/store/splits.ts';
import { splitMergeTools } from '../../../src/runtime/tools/builtin/agents-split-merge.ts';
import type { SplitService } from '../../../src/runtime/contracts/splits.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Split, SplitGroup, SplitTurn } from '../../../src/shared/model/splits.ts';
import { GIT_SKIP, git, gitCode, worktreeFixture } from './helpers.ts';

const skip = GIT_SKIP;
const T = Date.UTC(2026, 9, 29, 9, 0, 0);
const tool = splitMergeTools[0];
const textOf = (out: ToolOutput) => out.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');

function setup() {
  const f = worktreeFixture();
  for (const id of ['ag_ada', 'ag_bob']) f.db.run(`INSERT OR IGNORE INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES (?, ?, '{}', 'human', 0, 0)`, [id, id]);
  const rows = new SplitRepo(f.db);
  const site = f.repo('site', { 'a.txt': 'a\n' });
  const marks: Array<{ splitId: string; branch: unknown }> = [];
  const splits: Pick<SplitService, 'list' | 'markBranch'> = {
    list: (q) => rows.listGroups({ agentId: q.agentId }).filter((g) => !q.groupId || g.id === q.groupId)
      .map((g) => ({ ...g, splits: rows.listSplits({ groupId: g.id }).map((split) => ({ ...split, runs: 1 })) })),
    markBranch: (splitId, branch) => { marks.push({ splitId, branch }); },
  };
  f.services.splits = splits as SplitService;
  /** A group of Ada's with one ended worktree part that changed a.txt (its work committed, folder closed). */
  const endedPart = async (cwd: string, id: string, title: string): Promise<{ group: SplitGroup; split: Split; branch: string }> => {
    const group: SplitGroup = { id, agentId: 'ag_ada', parentRunId: 'run_parent', thread: f.chat.id, cwd, goal: 'Change the site', ultra: false, status: 'settled', parts: 0, createdAt: T };
    rows.saveGroup(group);
    const split: Split = { id: `sp_${id.slice(-1)}00001`, groupId: id, agentId: 'ag_ada', idx: 1, of: 1, title, brief: 'Do it.', context: 'brief', after: [], worktree: true, status: 'running', attempts: 1, createdAt: T };
    rows.saveSplit(split);
    const opened = await openSplitWorktree(f.services, group, split);
    writeFileSync(path.join(opened.cwd, 'a.txt'), `${title}\n`);
    const ended = { ...rows.updateSplit(split.id, { status: 'done' })!, of: 1 };
    const { stat } = await finishSplitWorktree(f.services, ended);
    rows.updateSplit(split.id, { branch: { name: opened.branch, stat } });
    return { group, split: ended, branch: opened.branch };
  };
  const ctx = (agentId = 'ag_ada', split?: SplitTurn): ToolContext => ({
    agent: f.org.require(agentId), runId: 'run_parent', mode: 'code', services: f.services, signal: new AbortController().signal, status: () => {},
    ...(split ? { split } : {}),
  });
  return { ...f, rows, site, marks, endedPart, ctx };
}

test("agents.split_merge: only the agent that split, never in a split's turn; a merge into the person's checkout asks the person; run merges and records it", { skip }, async () => {
  const f = setup();
  try {
    const { group, split, branch } = await f.endedPart(f.site, 'sg_1', 'Fix the header');
    const args = { groupId: group.id, idx: 1, action: 'merge' as const };
    const merge = tool.describe!(args, f.ctx());
    assert.equal(merge.summary, `Merge part #1 "Fix the header" (${branch}, 1 file +1 −1) into main in site`);
    const discard = tool.describe!({ ...args, action: 'discard' }, f.ctx());
    assert.equal(discard.summary, `Discard part #1 "Fix the header" (${branch}, 1 file +1 −1): delete its branch and folder`);

    assert.throws(() => tool.describe!(args, f.ctx('ag_bob')), /I have no split group sg_1\./);
    const turn: SplitTurn = { splitId: split.id, groupId: group.id, idx: 1, of: 1, title: 'Fix the header', parentRunId: 'run_parent', parentThread: f.chat.id, context: 'brief', firstTurn: false };
    assert.throws(() => tool.describe!(args, f.ctx('ag_ada', turn)), /A split does not merge or discard parts: my main self does that once the group has ended\./);
    assert.throws(() => tool.describe!({ ...args, idx: 9 }, f.ctx()), /Split group sg_1 has no part #9\./);
    await assert.rejects(tool.run(args, f.ctx('ag_bob')), /I have no split group sg_1\./);
    assert.equal(readFileSync(path.join(f.site, 'a.txt'), 'utf8'), 'a\n', 'nothing merged by a refused call');

    const out = await tool.run(args, f.ctx());
    assert.equal(out.isError, undefined, textOf(out));
    assert.match(textOf(out), new RegExp(`^Merged ${branch.replace(/[/.-]/g, '\\$&')} \\(part #1\\) into main \\(commit [0-9a-f]{7}\\)\\.$`));
    assert.equal(readFileSync(path.join(f.site, 'a.txt'), 'utf8'), 'Fix the header\n');
    assert.deepEqual(f.marks, [{ splitId: split.id, branch: { name: branch, stat: '1 file +1 −1', merged: 'merged' } }]);
    assert.notEqual(gitCode(f.site, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], f.env), 0, 'branch deleted');
    await assert.rejects(tool.run(args, f.ctx()), /Part #1 is already merged\./);
    assert.throws(() => tool.describe!({ ...args, action: 'discard' }, f.ctx()), /Part #1 is already merged\./, 'no approval card for a call that cannot run');
    f.rows.updateSplit(split.id, { status: 'running' });
    assert.throws(() => tool.describe!(args, f.ctx()), /Part #1 is still running\. Merge or discard it once it has ended\./);
  } finally { await f.settled(); f.cleanup(); }
});

