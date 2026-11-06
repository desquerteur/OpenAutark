// Login guard 03.11. (accounts/cli.ts CLAUDE_EXIT_GRACE_MS, system/supervisor.ts releaseAfter + spawnAlone, claude/status.ts,
// claude/engine.ts): a Claude process may still be saving a refreshed sign-in after its answer – a refresh token works once,
// a kill between refresh and save left an empty login on 02.11.2026 – so none is hard-killed at once. With real stand-in
// processes (fake-claude-login.mjs) and the real supervisor: an answered probe ends by itself and is never killed; one
// that hangs is killed only after the grace; one that timed out runs on with its input open and ends by itself once it
// answered; one process per account at a time while another account runs alongside, and none starts once the app
// stops (killAll); a finished and a stopped turn are
// not killed (the stopped one still returns after 3 s), a stopped turn whose CLI hangs is killed after the grace.
// Owns: these assertions only. Never: a real Claude Code binary, a real home or sign-in (homes are unused temp paths).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../../../src/runtime/system/supervisor.ts';
import { ClaudeStatus } from '../../../src/runtime/engines/claude/status.ts';
import { ClaudeEngine } from '../../../src/runtime/engines/claude/engine.ts';
import type { Executable, ExecutableFinder } from '../../../src/runtime/accounts/executables.ts';
import { account, memoryFiles, turnInput } from './fakes.ts';

const FAKE = fileURLToPath(new URL('./fake-claude-login.mjs', import.meta.url));
const EXE: Executable = { command: process.execPath, prefixArgs: [FAKE], path: FAKE };

interface Entry { pid: number; home: string; kind: string; event: string; at: number }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(done: () => boolean, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; !done(); await sleep(50)) if (Date.now() > end) throw new Error('timed out waiting');
}

/** The real tree kill (taskkill /T /F, a POSIX process group), recorded. */
function killTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } return Promise.resolve(); }
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('exit', () => resolve());
    killer.once('error', () => resolve());
  });
}

function harness(fake: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-login-guard-'));
  const kills: Array<{ pid: number; at: number }> = [];
  const supervisor = new Supervisor({ killTree: (pid) => { kills.push({ pid, at: Date.now() }); return killTree(pid); } });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), FAKE_DIR: dir, FAKE_SAVE_MS: '1500', ...fake };
  const file = path.join(dir, 'log.jsonl');
  const entries = (): Entry[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Entry) : []);
  const started = (kind: string) => entries().filter((entry) => entry.kind === kind && entry.event === 'start');
  const at = (pid: number, event: string) => entries().find((entry) => entry.pid === pid && entry.event === event)?.at;
  const has = (pid: number, event: string) => at(pid, event) !== undefined;
  const home = (name: string) => path.join(dir, `home-${name}`);
  const acc = (name: string) => account({ id: `acc_${name}`, provider: 'claude', label: 'Claude', home: home(name) });
  const status = (options: { timeoutMs?: number; graceMs: number }) => new ClaudeStatus({ supervisor, tempDir: dir, env, timeoutMs: options.timeoutMs ?? 30_000, graceMs: options.graceMs });
  const engine = (graceMs: number) => new ClaudeEngine({
    supervisor, finder: { find: async () => EXE, clear: () => {} } as unknown as ExecutableFinder, tempDir: dir, files: memoryFiles().files, env, graceMs,
  });
  const done = async () => {
    await supervisor.killAll(); // also a stand-in started after an earlier killAll (a run without the guard)
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a process still closing its log */ }
  };
  return { dir, kills, supervisor, entries, started, at, has, home, acc, status, engine, done };
}

test('login guard: an answered probe is not killed – its input closes and it ends by itself after saving', async () => {
  const h = harness();
  try {
    const raw = await h.status({ graceMs: 30_000 }).read(EXE, h.acc('a'));
    assert.equal(raw.initAnswered, true);
    const [probe] = h.started('probe');
    assert.equal(h.has(probe.pid, 'exit'), false, 'the call returned while the process was still saving');
    await waitFor(() => h.has(probe.pid, 'exit'));
    assert.ok(h.has(probe.pid, 'input-ended'), 'its input was closed after the answer');
    assert.ok(h.has(probe.pid, 'saved'), 'it finished what it was saving');
    assert.equal(h.kills.length, 0,'no tree kill');
  } finally { await h.done(); }
});

test('login guard: a probe that hangs after its answer is killed only after the grace', async () => {
  const h = harness({ FAKE_MODE: 'hang' });
  const grace = 1500;
  try {
    const raw = await h.status({ graceMs: grace }).read(EXE, h.acc('a'));
    const answered = Date.now();
    assert.equal(raw.initAnswered, true);
    const [probe] = h.started('probe');
    await sleep(grace / 2);
    assert.equal(h.kills.length, 0,'not killed within the grace');
    assert.ok(alive(probe.pid));
    await waitFor(() => h.kills.length === 1);
    assert.equal(h.kills[0].pid, probe.pid);
    assert.ok(h.kills[0].at - answered >= grace - 100, `killed after the grace (${h.kills[0].at - answered} ms)`);
    await waitFor(() => !alive(probe.pid));
    assert.equal(h.has(probe.pid, 'saved'), false);
  } finally { await h.done(); }
});

test('login guard: a probe that timed out keeps its input and runs on; once it answers, it ends by itself', async () => {
  const h = harness({ FAKE_MODE: 'slow', FAKE_ANSWER_MS: '2500' });
  try {
    const raw = await h.status({ timeoutMs: 800, graceMs: 30_000 }).read(EXE, h.acc('a'));
    assert.equal(raw.initAnswered, false, 'no answer in time: unknown');
    await waitFor(() => h.started('probe').length === 1);
    const [probe] = h.started('probe');
    assert.equal(h.has(probe.pid, 'input-ended'), false, 'its input stays open: it may be waiting on a refresh');
    await waitFor(() => h.has(probe.pid, 'exit'));
    assert.ok(h.has(probe.pid, 'input-ended') && h.has(probe.pid, 'saved'), 'the late answer closed its input; it saved and quit');
    assert.ok(h.at(probe.pid, 'input-ended')! >= (h.at(probe.pid, 'answered') ?? Infinity), 'its input was closed only after its late answer, not at the timeout');
    assert.equal(h.kills.length, 0);
  } finally { await h.done(); }
});

test('login guard: one Claude process per account at a time (three readings queue up); another account runs alongside', async () => {
  const h = harness();
  try {
    const status = h.status({ graceMs: 30_000 });
    const readings = await Promise.all([status.read(EXE, h.acc('a')), status.read(EXE, h.acc('a')), status.read(EXE, h.acc('a')), status.read(EXE, h.acc('b'))]);
    assert.ok(readings.every((raw) => raw.initAnswered));
    await waitFor(() => h.started('probe').every((entry) => h.has(entry.pid, 'exit')));
    const runs = (name: string) => h.started('probe').filter((entry) => entry.home === h.home(name)).map((entry) => ({ start: entry.at, exit: h.at(entry.pid, 'exit')! })).sort((x, y) => x.start - y.start);
    const a = runs('a');
    assert.equal(a.length, 3);
    for (let i = 1; i < a.length; i++) assert.ok(a[i].start >= a[i - 1].exit, `process ${i + 1} of the account started only once process ${i} was gone`);
    assert.ok(runs('b')[0].start < a[0].exit, 'another account is not held up');
    assert.equal(h.kills.length, 0);
  } finally { await h.done(); }
});

test('login guard: a reading still waiting for its account starts no process once the app stops (killAll)', async () => {
  const h = harness({ FAKE_MODE: 'hang' });
  try {
    const status = h.status({ graceMs: 30_000 });
    assert.equal((await status.read(EXE, h.acc('a'))).initAnswered, true);
    const waiting = status.read(EXE, h.acc('a')); // waits: the first probe hangs on after its answer
    await sleep(300);
    assert.equal(h.started('probe').length, 1);
    await h.supervisor.killAll(); // the shutdown's process step
    assert.deepEqual(await waiting, {}, 'no reading: nothing was started');
    await sleep(500);
    assert.equal(h.started('probe').length, 1, 'no process started after the stop (the exit would kill it hard)');
  } finally { await h.done(); }
});

test('login guard: a finished turn is not killed – its input closes and the CLI ends by itself', async () => {
  const h = harness({ FAKE_TURN: 'answer' });
  try {
    const t = turnInput({ model: 'claude-opus-5-5', account: h.acc('a'), cwd: h.dir });
    const result = await h.engine(30_000).run(t.input);
    assert.equal(result.stop, 'done');
    const [turn] = h.started('turn');
    await waitFor(() => h.has(turn.pid, 'exit'));
    assert.ok(h.has(turn.pid, 'input-ended') && h.has(turn.pid, 'saved'));
    assert.equal(h.kills.length, 0,'no tree kill after the result');
  } finally { await h.done(); }
});

test('login guard: a stopped turn returns after 3 s, but its CLI is not killed and ends by itself (late lines dropped)', async () => {
  const h = harness({ FAKE_INTERRUPT_MS: '4500' }); // the interrupt waits on a refresh in flight
  try {
    const controller = new AbortController();
    const t = turnInput({ model: 'claude-opus-5-5', account: h.acc('a'), cwd: h.dir, signal: controller.signal });
    const running = h.engine(30_000).run(t.input);
    await waitFor(() => t.events.some((event: { type?: string }) => event.type === 'text'));
    const [turn] = h.started('turn');
    const stopped = Date.now();
    controller.abort();
    const result = await running;
    assert.equal(result.stop, 'interrupted');
    assert.ok(Date.now() - stopped < 8000, 'the stopped turn returns soon');
    assert.equal(h.kills.length, 0,'no kill at the stop');
    assert.ok(alive(turn.pid) && !h.has(turn.pid, 'exit'), 'its CLI still runs');
    const seen = t.events.length;
    await waitFor(() => h.has(turn.pid, 'exit'));
    assert.ok(h.has(turn.pid, 'saved'), 'it finished and quit by itself');
    assert.equal(h.kills.length, 0);
    assert.equal(t.events.length, seen, 'what the CLI printed after the turn returned is not part of it');
  } finally { await h.done(); }
});

test('login guard: a stopped turn whose CLI hangs is killed after the grace, not before', async () => {
  const h = harness({ FAKE_MODE: 'hang', FAKE_INTERRUPT_MS: '600000' });
  const grace = 1500;
  try {
    const controller = new AbortController();
    const t = turnInput({ model: 'claude-opus-5-5', account: h.acc('a'), cwd: h.dir, signal: controller.signal });
    const running = h.engine(grace).run(t.input);
    await waitFor(() => t.events.some((event: { type?: string }) => event.type === 'text'));
    const [turn] = h.started('turn');
    controller.abort();
    assert.equal((await running).stop, 'interrupted');
    const returned = Date.now();
    assert.equal(h.kills.length, 0);
    await waitFor(() => h.kills.length === 1);
    assert.equal(h.kills[0].pid, turn.pid);
    assert.ok(h.kills[0].at - returned >= grace - 100, `killed after the grace (${h.kills[0].at - returned} ms)`);
    await waitFor(() => !alive(turn.pid));
  } finally { await h.done(); }
});
