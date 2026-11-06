// B-057 S16 split worktrees over real git (worktreeFixture): two parts open their own worktrees in parallel from the
// parent's branch, finish commits their work (the agent's identity, a Workforce-Split trailer) and closes the folders,
// both merge into the parent's folder (--no-ff); a conflicting part is aborted cleanly and listed, discard deletes branch
// and folder; a parent in its task worktree gets the part merged back into that worktree; canIsolate's refusals; the
// caps (an ended part's leftover folder is closed at the next open, a remnant removed) and the merge refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { saveRecord, splitRecordOf } from '../../../src/runtime/git/records.ts';
import { canIsolate, finishSplitWorktree, mergeSplit, openSplitWorktree, splitWorktreeCwd } from '../../../src/runtime/git/split-worktree.ts';
import { agentIdentity, commitWork } from '../../../src/runtime/git/worktree-ops.ts';
import { SplitRepo } from '../../../src/runtime/store/splits.ts';
import type { Split, SplitGroup, SplitStatus } from '../../../src/shared/model/splits.ts';
import { GIT_SKIP, git, gitCode, makeRepo, worktreeFixture } from './helpers.ts';

const skip = GIT_SKIP;
const T = Date.UTC(2026, 9, 29, 9, 0, 0);

function setup() {
  const f = worktreeFixture();
  for (const id of ['ag_ada', 'ag_bob']) f.db.run(`INSERT OR IGNORE INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES (?, ?, '{}', 'human', 0, 0)`, [id, id]);
  const rows = new SplitRepo(f.db);
  const site = f.repo('site', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'src/x.ts': 'export {};\n' });
  const group = (cwd: string, id = 'sg_1'): SplitGroup => {
    const value: SplitGroup = { id, agentId: 'ag_ada', parentRunId: 'run_parent', thread: f.chat.id, cwd, goal: 'Change the site', ultra: false, status: 'running', parts: 0, createdAt: T };
    rows.saveGroup(value);
    return value;
  };
  const part = (g: SplitGroup, idx: number, title: string, over: Partial<Split> = {}): Split => {
    const value: Split = { id: `sp_${g.id.slice(-1)}0000${idx}`, groupId: g.id, agentId: 'ag_ada', idx, of: 2, title, brief: 'Do it.', context: 'brief', after: [], worktree: true, status: 'running', attempts: 1, createdAt: T + idx, ...over };
    rows.saveSplit(value);
    return value;
  };
  const end = (split: Split, status: SplitStatus = 'done'): Split => ({ ...rows.updateSplit(split.id, { status })!, of: split.of });
  const hasBranch = (branch: string) => gitCode(site, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], f.env) === 0;
  const head = () => git(site, ['rev-parse', 'HEAD'], f.env).trim();
  return { ...f, rows, site, group, part, end, hasBranch, head };
}

test('two parts open their own worktrees in parallel from the parent\'s branch; finish commits and closes; both merge into the parent\'s folder', { skip }, async () => {
  const f = setup();
  try {
    const g = f.group(f.site);
    const one = f.part(g, 1, 'Fix the header');
    const two = f.part(g, 2, 'Add a footer');
    const [w1, w2] = await Promise.all([openSplitWorktree(f.services, g, one), openSplitWorktree(f.services, g, two)]);
    assert.deepEqual([w1.branch, w2.branch], ['wf/split-fix-the-header-100001', 'wf/split-add-a-footer-100002']);
    assert.notEqual(w1.cwd, w2.cwd);
    assert.equal(path.dirname(w1.cwd), path.dirname(w2.cwd));
    const rec = splitRecordOf(f.db, one.id)!;
    assert.match(rec.rel, /^\.worktrees\/site-[0-9a-f]{6}\/split-fix-the-header-100001$/);
    assert.deepEqual([rec.base, rec.state, rec.split?.groupId], ['main', 'active', 'sg_1']);
    assert.deepEqual(await openSplitWorktree(f.services, g, one), w1, 'opening again returns the open one');
    assert.equal(splitWorktreeCwd(f.services, one.id), w1.cwd);

    writeFileSync(path.join(w1.cwd, 'a.txt'), 'A\n');
    writeFileSync(path.join(w2.cwd, 'b.txt'), 'B\n');
    assert.equal(readFileSync(path.join(f.site, 'a.txt'), 'utf8'), 'a\n', "the parent's folder does not see a part's work");
    const [d1, d2] = [f.end(one), f.end(two)];
    assert.deepEqual(await finishSplitWorktree(f.services, d1), { stat: '1 file +1 −1' });
    assert.deepEqual(await finishSplitWorktree(f.services, d2), { stat: '1 file +1 −1' });
    assert.ok(!existsSync(w1.cwd) && !existsSync(w2.cwd), 'folders removed');
    assert.ok(f.hasBranch(w1.branch) && f.hasBranch(w2.branch), 'branches kept');
    assert.equal(splitWorktreeCwd(f.services, one.id), undefined);
    assert.equal(git(f.site, ['log', '-1', '--format=%B', w1.branch], f.env).trim(), `Split #1 of 2: Fix the header\n\nAutark-Split: ${one.id}`);
    assert.match(git(f.site, ['log', '-1', '--format=%an <%ae>', w1.branch], f.env), /^Ada \(Autark\) <ag_ada@agents\.autark\.invalid>/);

    assert.deepEqual(await mergeSplit(f.services, d1, 'merge', 'ag_ada'), { outcome: 'merged' });
    assert.deepEqual(await mergeSplit(f.services, d2, 'merge', 'ag_ada'), { outcome: 'merged' });
    assert.deepEqual([readFileSync(path.join(f.site, 'a.txt'), 'utf8'), readFileSync(path.join(f.site, 'b.txt'), 'utf8')], ['A\n', 'B\n']);
    assert.equal(git(f.site, ['status', '--porcelain'], f.env), '');
    assert.equal(git(f.site, ['rev-list', '--merges', '--count', 'HEAD'], f.env).trim(), '2');
    assert.match(git(f.site, ['log', '-1', '--format=%s|%an', 'HEAD'], f.env), /^Merge wf\/split-add-a-footer-100002: part #2 Add a footer\|Ada \(Autark\)/);
    assert.ok(!f.hasBranch(w1.branch) && !f.hasBranch(w2.branch), 'merged branches deleted');
    assert.deepEqual([splitRecordOf(f.db, one.id)?.state, splitRecordOf(f.db, two.id)?.state], ['merged', 'merged']);
    await assert.rejects(mergeSplit(f.services, d1, 'merge', 'ag_ada'), /Part #1 is already merged\./);
  } finally { await f.settled(); f.cleanup(); }
});

test('a conflicting part is aborted and listed, the parent\'s folder stays as it was; discard deletes branch and folder', { skip }, async () => {
  const f = setup();
  try {
    const g = f.group(f.site);
    const one = f.part(g, 1, 'Header A');
    const two = f.part(g, 2, 'Header B');
    const w1 = await openSplitWorktree(f.services, g, one);
    const w2 = await openSplitWorktree(f.services, g, two);
    writeFileSync(path.join(w1.cwd, 'a.txt'), 'X\n');
    writeFileSync(path.join(w2.cwd, 'a.txt'), 'Y\n');
    const [d1, d2] = [f.end(one), f.end(two)];
    await finishSplitWorktree(f.services, d1);
    await finishSplitWorktree(f.services, d2);
    assert.deepEqual(await mergeSplit(f.services, d1, 'merge', 'ag_ada'), { outcome: 'merged' });
    const before = f.head();
    assert.deepEqual(await mergeSplit(f.services, d2, 'merge', 'ag_ada'), { outcome: 'conflict', conflicts: ['a.txt'] });
    assert.equal(f.head(), before);
    assert.equal(git(f.site, ['status', '--porcelain'], f.env), '', 'no half merge left');
    assert.notEqual(gitCode(f.site, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], f.env), 0);
    assert.equal(readFileSync(path.join(f.site, 'a.txt'), 'utf8'), 'X\n');
    const kept = splitRecordOf(f.db, two.id)!;
    assert.deepEqual([kept.state, kept.merge?.conflicts, f.hasBranch(w2.branch)], ['closed', ['a.txt'], true]);

    assert.deepEqual(await mergeSplit(f.services, d2, 'discard', 'ag_ada'), { outcome: 'discarded' });
    assert.ok(!f.hasBranch(w2.branch));
    assert.equal(splitRecordOf(f.db, two.id)?.state, 'discarded');
    assert.deepEqual(await mergeSplit(f.services, d2, 'discard', 'ag_ada'), { outcome: 'discarded' }, 'again: nothing left to do');
    await assert.rejects(mergeSplit(f.services, d1, 'discard', 'ag_ada'), /Part #1 is already merged\./);

    // A stopped part whose folder is still open (no finish ran): discard deletes the folder with its unsaved work.
    const three = f.part(g, 3, 'Try something');
    const w3 = await openSplitWorktree(f.services, g, three);
    writeFileSync(path.join(w3.cwd, 'c.txt'), 'draft\n');
    assert.deepEqual(await mergeSplit(f.services, f.end(three, 'stopped'), 'discard', 'ag_ada'), { outcome: 'discarded' });
    assert.ok(!existsSync(w3.cwd) && !f.hasBranch(w3.branch));
    assert.equal(git(f.site, ['worktree', 'list', '--porcelain'], f.env).split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
    assert.equal(f.head(), before);
  } finally { await f.settled(); f.cleanup(); }
});

test('a parent in a folder inside the repository: the part works in that folder of its worktree; work that cannot be committed fails the finish', { skip }, async () => {
  const f = setup();
  try {
    const g = f.group(path.join(f.site, 'src'));
    const one = f.part(g, 1, 'Deep change');
    const w = await openSplitWorktree(f.services, g, one);
    const rec = splitRecordOf(f.db, one.id)!;
    assert.equal(w.cwd, path.join(rec.path, 'src'));
    assert.ok(existsSync(path.join(w.cwd, 'x.ts')));
    writeFileSync(path.join(w.cwd, 'y.ts'), 'export {};\n');
    git(rec.path, ['checkout', '-q', '-b', 'wf/elsewhere'], f.env); // the part left its branch: nothing is committed on it
    await assert.rejects(finishSplitWorktree(f.services, f.end(one)),
      /^WorkforceError: its changes stay uncommitted in \.worktrees\/site-[0-9a-f]{6}\/split-deep-change-100001 \(The worktree is on 'wf\/elsewhere'/);
    assert.ok(existsSync(path.join(w.cwd, 'y.ts')), 'the work stays in its folder');
    assert.equal(splitRecordOf(f.db, one.id)?.leftover, true);
  } finally { await f.settled(); f.cleanup(); }
});

test('canIsolate: a repository folder (or one inside it) is fine; no repository, the workspace, outside and a detached HEAD are refused', { skip }, async () => {
  const f = setup();
  try {
    assert.equal(await canIsolate(f.services, f.site), undefined);
    assert.equal(await canIsolate(f.services, path.join(f.site, 'src')), undefined);
    mkdirSync(path.join(f.paths.workspace, 'plain'));
    assert.equal(await canIsolate(f.services, path.join(f.paths.workspace, 'plain')), 'plain is not a git repository inside the workspace.');
    assert.equal(await canIsolate(f.services, f.paths.workspace), 'The working folder is the workspace itself, not a git repository inside it.');
    const outside = makeRepo(path.join(f.paths.data, 'outside'), f.env);
    assert.equal(await canIsolate(f.services, outside), 'The repository must lie inside the workspace.');
    git(f.site, ['checkout', '-q', '--detach'], f.env);
    assert.equal(await canIsolate(f.services, f.site), 'The working folder is on a detached HEAD: check out a branch first.');
    git(f.site, ['checkout', '-q', 'main'], f.env);
    const plain = f.group(path.join(f.paths.workspace, 'plain'), 'sg_2');
    await assert.rejects(openSplitWorktree(f.services, plain, f.part(plain, 1, 'Refused')), /^WorkforceError: Part #1 got no worktree: plain is not a git repository inside the workspace\.$/);
    assert.equal(git(f.site, ['branch', '--format=%(refname:short)'], f.env).trim(), 'main', 'no branch created');
    assert.ok(!existsSync(path.join(f.paths.workspace, '.worktrees')), 'no folder created');
  } finally { await f.settled(); f.cleanup(); }
});

test('canIsolate: the workspace itself as a repository is refused', { skip }, async () => {
  const f = worktreeFixture();
  try {
    makeRepo(f.paths.workspace, f.env);
    mkdirSync(path.join(f.paths.workspace, 'site'));
    for (const dir of [f.paths.workspace, path.join(f.paths.workspace, 'site')]) {
      assert.equal(await canIsolate(f.services, dir), 'The workspace itself is a git repository; put the project in its own folder inside the workspace.');
    }
  } finally { await f.settled(); f.cleanup(); }
});

test("caps: a part over the cap fails clearly; an ended part's leftover folder is closed at the next open", { skip }, async () => {
  const f = setup();
  try {
    const caps = { perRepo: 1, total: 20 };
    const g = f.group(f.site);
    const one = f.part(g, 1, 'First');
    const two = f.part(g, 2, 'Second');
    const w1 = await openSplitWorktree(f.services, g, one, caps);
    writeFileSync(path.join(w1.cwd, 'a.txt'), 'first\n');
    await assert.rejects(openSplitWorktree(f.services, g, two, caps), /^WorkforceError: Part #2 got no worktree: site already has 1 open worktrees\. Finish or cancel a task there first\.$/);
    assert.ok(!f.hasBranch('wf/split-second-100002'));

    f.end(one, 'failed'); // ended without finish (a crash): the next open closes its folder, its work committed
    const w2 = await openSplitWorktree(f.services, g, two, caps);
    assert.equal(w2.branch, 'wf/split-second-100002');
    assert.equal(splitRecordOf(f.db, one.id)?.state, 'closed');
    assert.ok(!existsSync(w1.cwd));
    assert.equal(git(f.site, ['show', `${w1.branch}:a.txt`], f.env), 'first\n');
  } finally { await f.settled(); f.cleanup(); }
});

test('a folder an earlier close or discard could not delete is removed at the next open; a discarded part stays discarded', { skip }, async () => {
  const f = setup();
  try {
    const g = f.group(f.site);
    const one = f.part(g, 1, 'Kept');
    const two = f.part(g, 2, 'Dropped');
    const w1 = await openSplitWorktree(f.services, g, one);
    const w2 = await openSplitWorktree(f.services, g, two);
    writeFileSync(path.join(w1.cwd, 'a.txt'), 'kept\n');
    await finishSplitWorktree(f.services, f.end(one));
    assert.deepEqual(await mergeSplit(f.services, f.end(two), 'discard', 'ag_ada'), { outcome: 'discarded' });
    // What a folder a process still works in leaves on Windows (git no longer lists it) – made by hand everywhere.
    for (const [split, cwd] of [[one, w1.cwd], [two, w2.cwd]] as const) {
      mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
      writeFileSync(path.join(cwd, 'node_modules', 'x.js'), '1\n');
      saveRecord(f.services, { ...splitRecordOf(f.db, split.id)!, leftover: true });
    }
    await openSplitWorktree(f.services, g, f.part(g, 3, 'Next'));
    assert.ok(!existsSync(w1.cwd) && !existsSync(w2.cwd), 'remnants removed');
    const [kept, dropped] = [splitRecordOf(f.db, one.id)!, splitRecordOf(f.db, two.id)!];
    assert.deepEqual([kept.state, kept.leftover, dropped.state, dropped.leftover], ['closed', undefined, 'discarded', undefined]);
    assert.ok(f.hasBranch(w1.branch) && !f.hasBranch(w2.branch), 'the kept branch stays, the discarded one stays gone');
  } finally { await f.settled(); f.cleanup(); }
});

test('merge refusals: a running part, a dirty parent folder, another branch, a part without changes or without a worktree', { skip }, async () => {
  const f = setup();
  try {
    const g = f.group(f.site);
    const one = f.part(g, 1, 'Change a');
    const w1 = await openSplitWorktree(f.services, g, one);
    writeFileSync(path.join(w1.cwd, 'a.txt'), 'changed\n');
    await assert.rejects(mergeSplit(f.services, one, 'merge', 'ag_ada'), /^WorkforceError: Part #1 is still running\. Merge or discard it once it has ended\.$/);
    await assert.rejects(mergeSplit(f.services, one, 'discard', 'ag_ada'), /Part #1 is still running/);
    const done = f.end(one);
    await finishSplitWorktree(f.services, done);
    const before = f.head();
    writeFileSync(path.join(f.site, 'b.txt'), 'dirty\n');
    await assert.rejects(mergeSplit(f.services, done, 'merge', 'ag_ada'), /^WorkforceError: My folder has uncommitted changes: I commit them first, then merge part #1\.$/);
    git(f.site, ['checkout', '-q', '--', 'b.txt'], f.env);
    git(f.site, ['checkout', '-q', '-b', 'experiment'], f.env);
    await assert.rejects(mergeSplit(f.services, done, 'merge', 'ag_ada'), /My folder is on 'experiment', not 'main' where part #1 started: I switch back to main, then merge\./);
    git(f.site, ['checkout', '-q', 'main'], f.env);
    assert.equal(f.head(), before);

    const two = f.part(g, 2, 'Look only');
    const w2 = await openSplitWorktree(f.services, g, two);
    const looked = f.end(two);
    assert.deepEqual(await finishSplitWorktree(f.services, looked), { stat: 'no changes' });
    assert.ok(!f.hasBranch(w2.branch), 'an empty branch is deleted');
    await assert.rejects(mergeSplit(f.services, looked, 'merge', 'ag_ada'), /^WorkforceError: No changes in part #2 to merge: I discard it\.$/);
    const three = f.end(f.part(g, 3, 'In the folder', { worktree: false }));
    await assert.rejects(mergeSplit(f.services, three, 'merge', 'ag_ada'), /^WorkforceError: Part #3 has no branch of its own: it worked in my folder\.$/);
    assert.deepEqual(await finishSplitWorktree(f.services, three), {});

    assert.deepEqual(await mergeSplit(f.services, done, 'merge', 'ag_ada'), { outcome: 'merged' }, 'the refusals changed nothing');
    assert.equal(readFileSync(path.join(f.site, 'a.txt'), 'utf8'), 'changed\n');
  } finally { await f.settled(); f.cleanup(); }
});
