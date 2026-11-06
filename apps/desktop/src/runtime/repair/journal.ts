// Start guard (23.10.2026): a small file <data>/boot.json, outside the database (which may be the
// problem), records each start of the runtime utility process. A start that fails with an
// UpgradeError (db/upgrade.ts) pins a repair problem at once; other failures and hard crashes
// (the process died before the runtime was stable, STABLE_MS after ready) count, and the start
// after MAX_ATTEMPTS of them in a row shows the repair screen ('crash_loop'). The pinned problem
// stays until the person presses Retry or restores data (clearRepair) or another app version
// starts. A clean shutdown and a stable runtime reset the count.
// Owns: the journal file, the counting and the classification of a failed start.
// Never: decides how the repair looks (repair/service.ts), keeps stack traces or secrets (one
// redacted line per error), or blocks a start when the file is unreadable (then it starts fresh).

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StartProblem, StartProblemCode } from '../../shared/model/repair.ts';
import { redactText } from '../feedback/redact.ts';
import { isUpgradeError } from '../db/upgrade.ts';

/** Failed or crashed starts in a row before the next one shows the repair screen. */
export const MAX_ATTEMPTS = 3;
/** Uptime after `ready` that counts as a good start. */
export const STABLE_MS = 60_000;

type Phase = 'starting' | 'up' | 'stable' | 'stopped' | 'repair';

interface JournalFile {
  version: string;
  attempts: number;
  phase: Phase;
  repair?: StartProblem;
  lastError?: string;
  at: number;
}

export interface JournalDeps {
  dataDir: string;
  now?: () => number;
}

/** One redacted line of an error (first line, bounded). */
export function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactText(text.split('\n')[0]).slice(0, 300);
}

export class BootJournal {
  private readonly deps: JournalDeps;
  readonly file: string;

  constructor(deps: JournalDeps) {
    this.deps = deps;
    this.file = path.join(deps.dataDir, 'boot.json');
  }

  read(): JournalFile | undefined {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<JournalFile>;
      if (typeof value.version !== 'string' || typeof value.attempts !== 'number' || typeof value.phase !== 'string') return undefined;
      return value as JournalFile;
    } catch {
      return undefined;
    }
  }

  /** The problem pinned for this version (repair mode), if any. */
  problem(version: string): StartProblem | undefined {
    const current = this.read();
    return current?.version === version ? current.repair : undefined;
  }

  /**
   * A start begins. Returns the problem to repair (pinned, or the crash loop the earlier starts
   * made) – then the runtime must not start – or the attempt number of a normal start.
   */
  begin(version: string): { problem?: StartProblem; attempt: number } {
    const previous = this.read();
    const at = this.now();
    if (!previous || previous.version !== version) {
      this.write({ version, attempts: 1, phase: 'starting', at });
      return { attempt: 1 };
    }
    if (previous.repair) return { problem: previous.repair, attempt: previous.attempts };
    // A start that never became stable and never stopped cleanly ended in a crash.
    const crashed = previous.phase === 'starting' || previous.phase === 'up';
    const attempts = crashed ? previous.attempts + 1 : 1;
    if (attempts > MAX_ATTEMPTS) {
      const problem: StartProblem = { code: 'crash_loop', version, attempts: attempts - 1, at, ...(previous.lastError ? { detail: previous.lastError } : {}) };
      this.write({ ...previous, attempts: attempts - 1, phase: 'repair', repair: problem, at });
      return { problem, attempt: attempts - 1 };
    }
    this.write({ version, attempts, phase: 'starting', at, ...(previous.lastError && crashed ? { lastError: previous.lastError } : {}) });
    return { attempt: attempts };
  }

  /**
   * The start failed with `error`. Returns the problem when the repair screen is due now: an
   * upgrade problem at once, any other failure once it was the MAX_ATTEMPTS-th in a row.
   */
  failed(error: unknown, version: string): StartProblem | undefined {
    const current = this.read();
    const at = this.now();
    const attempts = current?.version === version ? current.attempts : 1;
    const detail = errorLine(error);
    let code: StartProblemCode | undefined;
    let schema: { dataSchema?: number; appSchema?: number } = {};
    if (isUpgradeError(error)) {
      code = error.stage;
      schema = { ...(error.dataSchema !== undefined ? { dataSchema: error.dataSchema } : {}), appSchema: error.appSchema };
    } else if (attempts >= MAX_ATTEMPTS) {
      code = 'crash_loop';
    }
    if (!code) {
      this.write({ version, attempts, phase: 'starting', lastError: detail, at });
      return undefined;
    }
    const problem: StartProblem = { code, version, detail, at, ...schema, ...(code === 'crash_loop' ? { attempts } : {}) };
    this.write({ version, attempts, phase: 'repair', repair: problem, lastError: detail, at });
    return problem;
  }

  /** The runtime answered `ready`. */
  up(): void { this.mark('up'); }

  /** The runtime ran STABLE_MS after ready: the next crash counts from one again. */
  stable(): void { this.mark('stable', true); }

  /** Clean shutdown (quit, update, restart): not a crash. A pinned problem stays. */
  stopped(): void {
    const current = this.read();
    if (current?.repair) return;
    this.mark('stopped', true);
  }

  /** The person's Retry or restore: the next start runs normally. */
  clearRepair(): void {
    const current = this.read();
    this.write({ version: current?.version ?? '', attempts: 0, phase: 'stopped', at: this.now() });
  }

  private mark(phase: Phase, reset = false): void {
    const current = this.read();
    if (!current || current.repair) return;
    this.write({ ...current, phase, ...(reset ? { attempts: 0, lastError: undefined } : {}), at: this.now() });
  }

  private write(value: JournalFile): void {
    const temp = `${this.file}.part`;
    try {
      writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      renameSync(temp, this.file);
    } catch { /* best effort: a start is never blocked by its journal */ }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
}
