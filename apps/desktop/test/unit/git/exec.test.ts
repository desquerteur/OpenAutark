// GitRunner: the git lookup that never takes a git from the workspace or a relative PATH entry, the flags, env and
// folder of a call, the timeout kill and the output cap (fake spawn), a timed-out probe that throws
// instead of answering "no", `git --version` that is asked again after a failure, the per-repo
// queue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { GitRunner, type GitChild, type GitSpawn } from '../../../src/runtime/git/exec.ts';


const ROOT = path.resolve('wf-exec-root');
const paths = { data: path.join(ROOT, 'data'), workspace: path.join(ROOT, 'workspace'), temp: path.join(ROOT, 'tmp') };

test('resolve() never takes a git from a PATH entry inside the workspace or from a relative entry', () => {
  const planted = path.join(paths.workspace, 'bin');
  const real = path.join(ROOT, 'tools', 'git', 'cmd');
  const seen: string[] = [];
  const isFile = (file: string) => { seen.push(file); return true; };
  const win = new GitRunner({ paths, platform: process.platform, isFile, env: { PATH: [planted, '.', 'bin', `"${real}"`].join(path.delimiter) } });
  const found = win.resolve();
  assert.equal(found, path.join(real, process.platform === 'win32' ? 'git.exe' : 'git'));
  assert.ok(!seen.some((file) => file.startsWith(planted) || !path.isAbsolute(file)), seen.join(' | '));
  const none = new GitRunner({ paths, isFile, env: { PATH: [planted, path.join(paths.workspace, 'x', 'y')].join(path.delimiter) } });
  assert.equal(none.resolve(), undefined);
});

class FakeChild extends EventEmitter implements GitChild {
  pid = undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: Array<NodeJS.Signals | number | undefined> = [];
  kill(signal?: NodeJS.Signals | number): boolean { this.killed.push(signal); queueMicrotask(() => this.emit('close', null)); return true; }
}

function fakeRunner(behave: (child: FakeChild, args: string[]) => void) {
  const calls: Array<{ command: string; args: string[]; options: Parameters<GitSpawn>[2] }> = [];
  const children: FakeChild[] = [];
  const spawn: GitSpawn = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options });
    children.push(child);
    setImmediate(() => behave(child, args));
    return child;
  };
  const runner = new GitRunner({ paths, spawn, platform: 'linux', isFile: () => true, env: { PATH: '/usr/bin', HOME: '/h' } });
  return { runner, calls, children };
}

test('a call runs git by path without a shell, in the temp folder, non-interactive, with its flags', async () => {
  const { runner, calls } = fakeRunner((child) => { child.stdout.end('ok\n'); child.emit('close', 0); });
  const result = await runner.run('/repo', ['status'], { identity: { name: 'Ada (Workforce)', email: 'ag@agents.workforce.invalid' } });
  assert.deepEqual([result.code, result.stdout, result.timedOut], [0, 'ok\n', false]);
  const { command, args, options } = calls[0];
  assert.equal(command, '/usr/bin/git');
  assert.deepEqual(args.slice(-3), ['-C', '/repo', 'status']);
  for (const flag of ['submodule.recurse=false', 'user.name=Ada (Workforce)']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[0], '--no-pager');
  assert.deepEqual([options.shell, options.cwd, options.windowsHide], [false, paths.temp, true]);
  assert.deepEqual([options.env.GIT_PAGER, options.env.GIT_EDITOR, options.env.GIT_AUTHOR_NAME], ['cat', ':', 'Ada (Workforce)']);
});

test('a call that hangs is killed at its timeout; output beyond the cap is cut', async () => {
  const hang = fakeRunner(() => { /* never closes by itself */ });
  const slow = await hang.runner.run('/repo', ['status'], { timeoutMs: 30 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.code, null);
  assert.equal(hang.children[0].killed.length, 1);
  const big = fakeRunner((child) => { child.stdout.write('x'.repeat(5000)); child.stdout.end('y'.repeat(5000)); setImmediate(() => child.emit('close', 0)); });
  const capped = await big.runner.run('/repo', ['diff'], { maxBytes: 4096 });
  assert.equal(capped.stdout.length, 4096);
  assert.equal(capped.truncated, true);
});

test('a timed-out probe throws timeout; git --version is asked again after a failure, an answer is kept', async () => {
  const hang = fakeRunner(() => { /* never closes by itself */ });
  await assert.rejects(hang.runner.probe('/repo', ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 30 }), (error: Error & { code?: string }) => error.code === 'timeout');
  let answer = false;
  const flaky = fakeRunner((child, args) => {
    if (args[0] === '--version' && answer) child.stdout.end('git version 2.55.0\n');
    child.emit('close', args[0] === '--version' && answer ? 0 : 1);
  });
  assert.deepEqual(await flaky.runner.version(), { ok: false, text: '' });
  answer = true;
  assert.deepEqual(await flaky.runner.version(), { ok: true, text: 'git version 2.55.0' }, 'the failure was not cached');
  answer = false;
  assert.deepEqual(await flaky.runner.version(), { ok: true, text: 'git version 2.55.0' }, 'the answer is cached');
  assert.equal(flaky.calls.filter((call) => call.args[0] === '--version').length, 2);
  const lfs = fakeRunner((child) => child.emit('close', 0));
  await lfs.runner.run('/repo', ['worktree', 'add', 'x', 'y'], { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
  assert.equal(lfs.calls[0].options.env.GIT_LFS_SKIP_SMUDGE, '1');
});

test('serial runs one operation per repository at a time; a failure does not block the next', async () => {
  const { runner } = fakeRunner((child) => child.emit('close', 0));
  const order: string[] = [];
  const op = (name: string, fail = false) => async () => { order.push(`${name}:start`); await new Promise((r) => setTimeout(r, 5)); order.push(`${name}:end`); if (fail) throw new Error(name); return name; };
  const results = await Promise.allSettled([runner.serial('/a', op('one', true)), runner.serial('/a', op('two')), runner.serial('/b', op('other'))]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.ok(order.indexOf('one:end') < order.indexOf('two:start'), order.join(' '));
  assert.ok(order.indexOf('other:start') < order.indexOf('one:end'), 'another repo is not queued behind it');
});
