// "Keep agents running" (B-044, src/main/launcher.ts): the launch decision by source – the person's start
// always starts; a macOS/Linux unit start ('unit') restarts after an unexpected end with one notice, stops
// at the 3rd within 30 minutes, leaves a deliberate quit alone unless work is due within 10 minutes and an
// update install alone, resumes a session the system ended; the Windows task ('task': sign-in, crash event,
// due work – it cannot say which) follows the same rules, also starts from 5 minutes after the person's quit
// or after a quit before this boot (a sign-in; a crash while closing stays quit) and 30 minutes after a cap,
// and hands every start that goes on over (no write: the detached ordinary start decides again – same
// result); the files (run-state.json written atomically, next-due.json read, damaged files mean "start")
// and the quit marks (the first one wins).
// Owns: these assertions only. Never: Electron, the real clock or the OS scheduler.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAP_WINDOW_MS, DUE_WINDOW_MS, NOTICES, QUIT_SETTLE_MS, RunStateMarks, UPDATE_GRACE_MS, beginLaunch, decideLaunch, launchSource, readNextDue, readRunState,
  writeRunState, type LaunchInput,
} from '../../../src/main/launcher.ts';
import type { RunState } from '../../../src/shared/model/launch.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0);
const BOOT = NOW - 5 * 60 * MIN;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-launcher-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function launch(previous: RunState | undefined, patch: Partial<LaunchInput> = {}) {
  return decideLaunch({ previous, source: 'unit', nextDue: undefined, now: NOW, bootAt: BOOT, pid: 42, ...patch });
}
const task = (previous: RunState | undefined, patch: Partial<LaunchInput> = {}) => launch(previous, { source: 'task', ...patch });
const CAPPED: RunState = { state: 'quit', by: 'launcher', at: NOW - MIN, ends: [NOW - 3 * MIN, NOW - 2 * MIN, NOW - MIN], capped: NOW - MIN };

test('the source: --launcher is the Windows task on Windows, a launchd/systemd unit elsewhere', () => {
  assert.equal(launchSource('win32', true), 'task');
  assert.equal(launchSource('darwin', true), 'unit');
  assert.equal(launchSource('linux', true), 'unit');
  assert.equal(launchSource('win32', false), 'person');
});

test('a normal start always starts, counts an unexpected end and lifts the cap', () => {
  const crashed = launch({ state: 'running', at: NOW - 10 * MIN, pid: 7 }, { source: 'person' });
  assert.deepEqual(crashed, { start: true, reason: 'start', write: { state: 'running', at: NOW, pid: 42, ends: [NOW] } });
  const capped = launch(CAPPED, { source: 'person' });
  assert.equal(capped.start, true);
  assert.equal(capped.write?.capped, undefined, 'the person opened it: the cap is gone');
  assert.equal(capped.notice, undefined, 'no "restarted" notice for a start the person made');
  assert.equal(capped.handoff, undefined);
});

test('unit: an unexpected end restarts with one quiet notice; the 3rd within 30 minutes stops it', () => {
  assert.deepEqual(launch(undefined), { start: true, reason: 'start', write: { state: 'running', at: NOW, pid: 42 } }, 'no state yet: start');
  const once = launch({ state: 'running', at: NOW - 20 * MIN, pid: 7 });
  assert.deepEqual(once, { start: true, reason: 'unexpected', write: { state: 'running', at: NOW, pid: 42, ends: [NOW] }, notice: 'restarted' });
  assert.equal(NOTICES.restarted.title, 'Restarted after an unexpected close');
  const twice = launch({ state: 'running', at: NOW - 5 * MIN, pid: 8, ends: [NOW - 20 * MIN] });
  assert.equal(twice.start, true);
  assert.deepEqual(twice.write?.ends, [NOW - 20 * MIN, NOW]);
  const third = launch({ state: 'running', at: NOW - 2 * MIN, pid: 9, ends: [NOW - 20 * MIN, NOW - 5 * MIN] });
  assert.deepEqual(third, { start: false, reason: 'capped', write: { state: 'quit', by: 'launcher', at: NOW, ends: [NOW - 20 * MIN, NOW - 5 * MIN, NOW], capped: NOW }, notice: 'capped' });
  assert.deepEqual(launch(third.write), { start: false, reason: 'capped' }, 'capped: quiet, nothing written, no second notice');
  assert.deepEqual(launch(CAPPED, { now: NOW + 2 * CAP_WINDOW_MS }), { start: false, reason: 'capped' }, 'a unit never lifts it (the sign-in item does)');
  const old = launch({ state: 'running', at: NOW - 2 * MIN, pid: 9, ends: [NOW - CAP_WINDOW_MS - MIN, NOW - 5 * MIN] });
  assert.equal(old.start, true, 'ends older than 30 minutes do not count');
  assert.deepEqual(old.write?.ends, [NOW - 5 * MIN, NOW]);
});

test("unit: a 'running' state from before this boot ended with the system – resume without a notice", () => {
  assert.deepEqual(launch({ state: 'running', at: BOOT - MIN, pid: 7 }), { start: true, reason: 'resume', write: { state: 'running', at: NOW, pid: 42 } });
  assert.deepEqual(launch({ state: 'quit', by: 'system', at: NOW - 60 * MIN }), { start: true, reason: 'resume', write: { state: 'running', at: NOW, pid: 42 } });
});

test('unit: a deliberate quit stays quit unless work is due within 10 minutes; an update install is left alone', () => {
  const quit: RunState = { state: 'quit', by: 'person', at: NOW - 30 * MIN };
  assert.deepEqual(launch(quit), { start: false, reason: 'quit' });
  assert.deepEqual(launch(quit, { nextDue: null }), { start: false, reason: 'quit' });
  assert.deepEqual(launch(quit, { nextDue: NOW + DUE_WINDOW_MS + MIN }), { start: false, reason: 'quit' });
  assert.deepEqual(launch(quit, { nextDue: NOW + DUE_WINDOW_MS }), { start: true, reason: 'due', write: { state: 'running', at: NOW, pid: 42 } });
  assert.equal(launch(quit, { nextDue: NOW - 60 * MIN }).reason, 'due', 'overdue work starts it too');
  assert.deepEqual(launch({ state: 'quit', by: 'update', at: NOW - MIN }, { nextDue: NOW }), { start: false, reason: 'updating' }, 'the installer may still run');
  assert.equal(launch({ state: 'quit', by: 'update', at: NOW - UPDATE_GRACE_MS - MIN }).reason, 'resume', 'an update that did not relaunch the app');
});

test('the install helper\'s relaunch (--updated, no --launcher) starts right after the update quit', () => {
  const justUpdated: RunState = { state: 'quit', by: 'update', at: NOW - 20_000 };
  const helper = launchSource('win32', false);
  assert.deepEqual(launch(justUpdated, { source: helper }), { start: true, reason: 'start', write: { state: 'running', at: NOW, pid: 42 } });
  assert.deepEqual(launch(justUpdated, { source: launchSource('linux', false) }).start, true);
});

test('task: every start that goes on hands over without writing; the reason and the notice are kept', () => {
  assert.deepEqual(task(undefined), { start: true, reason: 'start', handoff: true });
  assert.deepEqual(task({ state: 'running', at: NOW - 20 * MIN, pid: 7 }), { start: true, reason: 'unexpected', notice: 'restarted', handoff: true }, 'a crash event');
  assert.deepEqual(task({ state: 'quit', by: 'system', at: NOW - 60 * MIN }), { start: true, reason: 'resume', handoff: true }, 'the sign-in after a shutdown');
  const third = task({ state: 'running', at: NOW - 2 * MIN, pid: 9, ends: [NOW - 20 * MIN, NOW - 5 * MIN] });
  assert.equal(third.start, false);
  assert.equal(third.write?.capped, NOW, 'the cap is written by the task start itself');
  assert.equal(third.notice, 'capped');
  assert.equal(third.handoff, undefined);
});

test("task: the person's quit – a crash while closing stays quit, a sign-in later or due work starts", () => {
  const quit = (ago: number): RunState => ({ state: 'quit', by: 'person', at: NOW - ago });
  assert.deepEqual(task(quit(MIN)), { start: false, reason: 'quit' }, "the closing app's crash event (30 s after it) changes nothing");
  assert.deepEqual(task(quit(QUIT_SETTLE_MS - 1)), { start: false, reason: 'quit' });
  assert.deepEqual(task(quit(QUIT_SETTLE_MS)), { start: true, reason: 'signin', handoff: true }, 'a sign-in: "Keep agents running"');
  assert.deepEqual(task(quit(2 * MIN), { bootAt: NOW - MIN }), { start: true, reason: 'signin', handoff: true }, 'quit, restarted the PC, signed in within 5 minutes');
  assert.deepEqual(launch(quit(2 * MIN), { bootAt: NOW - MIN }), { start: false, reason: 'quit' }, 'a unit start (the login item signs in there) stays quit');
  assert.deepEqual(task(quit(MIN), { nextDue: NOW + MIN }), { start: true, reason: 'due', handoff: true }, 'the time trigger the quit wrote');
  assert.deepEqual(task({ state: 'quit', by: 'update', at: NOW - MIN }), { start: false, reason: 'updating' });
});

test('task: a cap holds for 30 minutes, then a task start (a later sign-in, due work) lifts it', () => {
  assert.deepEqual(task(CAPPED, { now: NOW + 10 * MIN }), { start: false, reason: 'capped' });
  assert.deepEqual(task(CAPPED, { now: CAPPED.capped! + CAP_WINDOW_MS }), { start: true, reason: 'signin', handoff: true });
  const detached = launch(CAPPED, { source: 'person', now: CAPPED.capped! + CAP_WINDOW_MS });
  assert.equal(detached.write?.capped, undefined, 'the detached ordinary start writes the state without the cap');
});

test('files: run-state written atomically and read back; damaged or missing files mean "start"', () => {
  const dir = path.join(tmp, 'files');
  assert.equal(readRunState(dir), undefined);
  assert.equal(readNextDue(dir), undefined);
  writeRunState(dir, { state: 'running', at: NOW, pid: 5 });
  assert.deepEqual(readRunState(dir), { state: 'running', at: NOW, pid: 5 });
  assert.deepEqual(readdirSync(dir), ['run-state.json'], 'no temp file left');
  writeFileSync(path.join(dir, 'run-state.json'), '{"state":"maybe"');
  assert.equal(readRunState(dir), undefined);
  writeFileSync(path.join(dir, 'next-due.json'), JSON.stringify({ at: NOW + MIN }));
  assert.equal(readNextDue(dir), NOW + MIN);
  writeFileSync(path.join(dir, 'next-due.json'), JSON.stringify({ at: null }));
  assert.equal(readNextDue(dir), null);
  writeFileSync(path.join(dir, 'next-due.json'), 'x');
  assert.equal(readNextDue(dir), undefined);
});

test('beginLaunch reads both files, decides and writes (not for a handoff); the quit marks keep the first quit', () => {
  const dir = path.join(tmp, 'begin');
  writeRunState(dir, { state: 'quit', by: 'person', at: NOW - 30 * MIN });
  writeFileSync(path.join(dir, 'next-due.json'), JSON.stringify({ at: NOW + 5 * MIN }));
  assert.equal(beginLaunch({ dataDir: dir, source: 'task', now: NOW, bootAt: BOOT, pid: 10 }).handoff, true);
  assert.deepEqual(readRunState(dir), { state: 'quit', by: 'person', at: NOW - 30 * MIN }, 'the handoff writes nothing');
  assert.equal(beginLaunch({ dataDir: dir, source: 'unit', now: NOW, bootAt: BOOT, pid: 11 }).reason, 'due');
  assert.deepEqual(readRunState(dir), { state: 'running', at: NOW, pid: 11 });
  const marks = new RunStateMarks(dir, undefined, () => NOW + MIN);
  assert.equal(marks.by, undefined);
  marks.quit('system');
  marks.quit('person');
  assert.equal(marks.by, 'system', 'the first mark: no due start is written for an ending session');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'run-state.json'), 'utf8')), { state: 'quit', by: 'system', at: NOW + MIN });
  writeRunState(dir, { state: 'running', at: NOW, pid: 12, ends: [NOW - MIN] });
  new RunStateMarks(dir, undefined, () => NOW + 2 * MIN).quit('update');
  assert.deepEqual(readRunState(dir), { state: 'quit', by: 'update', at: NOW + 2 * MIN, ends: [NOW - MIN] }, 'the ends are kept for the cap');
  const lines: string[] = [];
  writeRunState(path.join(dir, 'run-state.json', 'nested'), { state: 'running', at: NOW }, (line) => lines.push(line));
  assert.equal(lines.length, 1, 'a failed write is logged, never thrown');
});
