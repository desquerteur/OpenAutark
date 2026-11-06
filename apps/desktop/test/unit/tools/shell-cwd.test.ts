// B-061: where a command runs without `cwd` – shell.exec and secrets.run use the folder of a split part (its own
// worktree, else its group's: ToolContext.split.cwd), else the workspace; an explicit cwd still wins.
// Owns: these assertions only. Never: a real shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { commandCwd, fileTools, type ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';

const workspace = path.resolve('/wf-test/workspace');
const worktree = path.resolve('/wf-test/workspace/.worktrees/repo-ab12cd/split');

const ctx = (split?: Pick<SplitTurn, 'cwd'>): ToolContext => ({
  agent: { id: 'ag_a', name: 'Ada' } as ToolContext['agent'], runId: 'run_1', mode: 'coding', signal: new AbortController().signal, status() {},
  services: { paths: { workspace, data: path.resolve('/wf-test/data') }, secrets: { redact: (value: string) => value } } as unknown as RuntimeServices,
  ...(split ? { split: split as SplitTurn } : {}),
});

test('commandCwd: an explicit folder wins, else the split part\'s own folder, else the workspace', () => {
  assert.equal(commandCwd(ctx(), undefined), workspace, 'no split: the workspace');
  assert.equal(commandCwd(ctx(), '  '), workspace, 'blank counts as none');
  assert.equal(commandCwd(ctx({ cwd: worktree }), undefined), worktree, 'a worktree part: its worktree');
  assert.equal(commandCwd(ctx({ cwd: worktree }), ''), worktree);
  assert.equal(commandCwd(ctx({}), undefined), workspace, 'a split without a folder: the workspace');
  assert.equal(commandCwd(ctx({ cwd: worktree }), 'other'), path.join(workspace, 'other'), 'cwd given: relative to the workspace as before');
  assert.equal(commandCwd(ctx({ cwd: worktree }), path.resolve('/elsewhere')), path.resolve('/elsewhere'));
});

test('shell.exec without cwd runs in the worktree of a split part', async () => {
  const folders: string[] = [];
  const shell: ShellSpawn = (_command, options) => {
    folders.push(String(options.cwd));
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: null, kill: () => true });
    setImmediate(() => child.emit('close', 0));
    return child as unknown as ReturnType<ShellSpawn>;
  };
  const exec = fileTools({ shell }).find((tool) => tool.name === 'shell.exec')!;
  await exec.run({ command: 'git status' }, ctx({ cwd: worktree }));
  await exec.run({ command: 'git status' }, ctx());
  await exec.run({ command: 'git status', cwd: 'repo' }, ctx({ cwd: worktree }));
  assert.deepEqual(folders, [worktree, workspace, path.join(workspace, 'repo')]);
});
