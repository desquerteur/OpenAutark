// "Keep agents running" (B-044, preferences.openAtLogin), the start side: <userData>/run-state.json
// says whether the app is running or was quit on purpose (the person, an update install, the system
// ending the session) and remembers unexpected ends. Every start reads it before anything else runs
// (index.ts, before desktop.ts is even loaded). Who started this process (`LaunchSource`):
//   * 'person' – the person, an update relaunch (the install helper's `--updated` start, updates/install-helper.ts,
//     carries no `--launcher`, so the 10 minutes after an update quit never hold it back), the macOS/Linux sign-in
//     item: always starts, counts an unexpected end and lifts the crash-loop cap;
//   * 'task' – the Windows task (launcher-windows.ts; `--launcher`): it fires at sign-in, after a crash or
//     hang of the app's executable (Application log events 1000/1002, 30 s later) and at the next due work
//     the person's last quit wrote – and cannot say which, so the state decides;
//   * 'unit' – the macOS LaunchAgent / Linux systemd unit (`--launcher`): a start after sign-in and a
//     restart of a unit-started app that exited with an error.
// A launcher start ('task', 'unit') goes on only when the app should be running and is not:
//   * the single-instance lock is held → index.ts quits before this file decides anything;
//   * the last state is 'running' (no deliberate quit since this boot) → an unexpected end: start in the
//     background with one quiet notice "Restarted after an unexpected close" – unless it is the 3rd
//     unexpected end within 30 minutes: then stop restarting (one notice) until the person starts the
//     app, or (Windows) a task start 30 minutes after the cap: a later sign-in or due work;
//   * an update install → not while its installer may run (10 minutes); the session ended (shutdown,
//     restart, log-off, Fast Startup: session-end.ts) or a 'running' state from before this boot → start;
//   * quit by the person → start when <userData>/next-due.json (the runtime scheduler's earliest schedule
//     or wake) is due within 10 minutes; a Windows task start also from 5 minutes after the quit on, or
//     when the quit was before this boot (a sign-in – a crash while the app was still closing fires its
//     event earlier, in the same boot, and stays quit).
// A Windows task start that goes on writes nothing and hands over (`handoff`): index.ts starts the app
// again detached as an ordinary background start, which decides as 'person' (same result), so the app
// never runs as the task's instance – re-registering or deleting the task cannot end it, and the task's
// IgnoreNew policy never swallows the crash event of a running app.
// The boot journal (runtime/repair/journal.ts) is not touched: a launcher start that quits never starts
// the runtime, one that goes on is an ordinary start – no double count.
// Owns: the run-state file, the launch decision and the quit marks. Never: imports electron (index.ts
// and desktop.ts pass values in) or registers anything with the OS (launcher-tasks.ts, launcher-windows.ts).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NEXT_DUE_FILE, RUN_STATE_FILE, type NextDue, type QuitBy, type RunState } from '../shared/model/launch.ts';

export const LAUNCHER_FLAG = '--launcher';
export const BACKGROUND_FLAG = '--background';
export const RESTARTED_FLAG = '--restarted'; // a Windows task start after an unexpected close handed over (its notice)
export const DUE_WINDOW_MS = 10 * 60_000;
export const CAP_ENDS = 3;
export const CAP_WINDOW_MS = 30 * 60_000;
export const UPDATE_GRACE_MS = 10 * 60_000;
export const QUIT_SETTLE_MS = 5 * 60_000;

export type LaunchSource = 'person' | 'task' | 'unit';
export type LaunchNotice = 'restarted' | 'capped';

export const NOTICES: Record<LaunchNotice, { title: string; body: string }> = {
  restarted: { title: 'Restarted after an unexpected close', body: '' },
  capped: { title: 'Closed unexpectedly 3 times', body: 'It will not restart by itself until you open it again.' },
};

export interface LaunchInput {
  previous: RunState | undefined;
  source: LaunchSource;
  nextDue: number | null | undefined; // <userData>/next-due.json
  now: number;
  bootAt: number; // when this system booted (a 'running' state from before it ended with the system; a quit before it: a task start is a sign-in)
  pid: number;
}

export interface LaunchDecision {
  start: boolean;
  reason: 'start' | 'unexpected' | 'capped' | 'quit' | 'updating' | 'due' | 'resume' | 'signin';
  write?: RunState; // the state to write now (none: leave the file as it is)
  notice?: LaunchNotice;
  handoff?: true; // a Windows task start that goes on: start the app again detached (it writes the state)
}

/** Where a start came from: `--launcher` is the Windows task on Windows, a launchd/systemd unit elsewhere. */
export function launchSource(platform: string, launcher: boolean): LaunchSource {
  return !launcher ? 'person' : platform === 'win32' ? 'task' : 'unit';
}

/** The pure decision (see the header). */
export function decideLaunch(input: LaunchInput): LaunchDecision {
  const decision = decide(input);
  if (input.source !== 'task' || !decision.start) return decision;
  const { start, reason, notice } = decision; // no write: the detached start decides again and writes
  return { start, reason, ...(notice ? { notice } : {}), handoff: true };
}

function decide(input: LaunchInput): LaunchDecision {
  const { previous, now } = input;
  const recent = (previous?.ends ?? []).filter((at) => Number.isFinite(at) && now - at >= 0 && now - at < CAP_WINDOW_MS);
  const unexpected = previous?.state === 'running' && previous.at >= input.bootAt;
  const ends = unexpected ? [...recent, now].slice(-CAP_ENDS) : recent;
  const running: RunState = { state: 'running', at: now, pid: input.pid, ...(ends.length ? { ends } : {}) };
  if (input.source === 'person' || !previous) return { start: true, reason: 'start', write: running };
  if (previous.capped !== undefined) {
    if (input.source === 'task' && now - previous.capped >= CAP_WINDOW_MS) return { start: true, reason: 'signin', write: running };
    return { start: false, reason: 'capped' };
  }
  if (unexpected) {
    if (ends.length >= CAP_ENDS) return { start: false, reason: 'capped', write: { state: 'quit', by: 'launcher', at: now, ends, capped: now }, notice: 'capped' };
    return { start: true, reason: 'unexpected', write: running, notice: 'restarted' };
  }
  if (previous.state === 'running') return { start: true, reason: 'resume', write: running }; // ended with the system before this boot
  if (previous.by === 'update' && now - previous.at < UPDATE_GRACE_MS) return { start: false, reason: 'updating' };
  if (previous.by === 'update' || previous.by === 'system') return { start: true, reason: 'resume', write: running };
  if (typeof input.nextDue === 'number' && input.nextDue <= now + DUE_WINDOW_MS) return { start: true, reason: 'due', write: running };
  if (input.source === 'task' && (now - previous.at >= QUIT_SETTLE_MS || previous.at < input.bootAt)) return { start: true, reason: 'signin', write: running };
  return { start: false, reason: 'quit' };
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** The stored run state, or undefined when missing or unreadable. */
export function readRunState(dataDir: string): RunState | undefined {
  const value = readJson(path.join(dataDir, RUN_STATE_FILE)) as Partial<RunState> | undefined;
  if (!value || (value.state !== 'running' && value.state !== 'quit') || typeof value.at !== 'number') return undefined;
  return value as RunState;
}

/** The runtime's next due time, or null / undefined. */
export function readNextDue(dataDir: string): number | null | undefined {
  const value = readJson(path.join(dataDir, NEXT_DUE_FILE)) as Partial<NextDue> | undefined;
  return typeof value?.at === 'number' || value?.at === null ? value.at : undefined;
}

/** Small atomic write (temp file + rename); never throws (a missing file only means "start"). */
export function writeRunState(dataDir: string, state: RunState, log?: (line: string) => void): void {
  const file = path.join(dataDir, RUN_STATE_FILE);
  try {
    mkdirSync(dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    log?.(`run state not written: ${(error as Error)?.message ?? 'error'}`);
  }
}

/** Reads both files, decides and writes the new state (index.ts, before anything else starts). */
export function beginLaunch(input: Omit<LaunchInput, 'previous' | 'nextDue'> & { dataDir: string }): LaunchDecision {
  const decision = decideLaunch({ ...input, previous: readRunState(input.dataDir), nextDue: readNextDue(input.dataDir) });
  if (decision.write) writeRunState(input.dataDir, decision.write);
  return decision;
}

/**
 * The quit marks of one process: the first deliberate quit wins (an ending session's 'system' is
 * not turned into 'person' by the quit that follows it; an update's quit stays 'update').
 */
export class RunStateMarks {
  private readonly dataDir: string;
  private readonly log?: (line: string) => void;
  private readonly now: () => number;
  private first: QuitBy | undefined;

  constructor(dataDir: string, log?: (line: string) => void, now: () => number = Date.now) {
    this.dataDir = dataDir;
    this.log = log;
    this.now = now;
  }

  /** The first quit mark of this process (none yet: undefined). */
  get by(): QuitBy | undefined {
    return this.first;
  }

  quit(by: QuitBy): void {
    if (this.first) return;
    this.first = by;
    const previous = readRunState(this.dataDir);
    writeRunState(this.dataDir, { state: 'quit', by, at: this.now(), ...(previous?.ends?.length ? { ends: previous.ends } : {}) }, this.log);
  }
}
