// B-044 launcher hint: <data>/next-due.json says when the earliest schedule or wake is due, so the
// OS launcher can start a closed app for scheduled work (main/launcher-windows.ts reads it on a deliberate
// quit for the Windows task's one time trigger; main/launcher.ts at a launcher start). Never a schtasks call.
// The scheduler reports on every re-arm; only a changed time is written (one small atomic write: the one
// temp file next-due.json.tmp + rename, retried briefly while a reader holds the file on Windows), writes
// are serialised and the newest value wins – no polling, no timer of its own. At runtime stop the
// scheduler settles it: the newest value is on disk and no temp file is left behind.
// Owns: that file's writing. Never: decides anything about starting (main does) or blocks the scheduler.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NEXT_DUE_FILE, type NextDue } from '../../shared/model/launch.ts';
import type { Logger } from '../contracts.ts';

export interface NextDueIo {
  write(file: string, text: string): Promise<void>;
  /** Removes a temp file a crashed write left behind. */
  discardTemp(file: string): Promise<void>;
}

const RENAME_TRIES = 3;
const tempOf = (file: string) => `${file}.tmp`;

const fileIo: NextDueIo = {
  async write(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = tempOf(file);
    await writeFile(temp, text, 'utf8');
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(temp, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (attempt < RENAME_TRIES && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
          continue;
        }
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  },
  async discardTemp(file) {
    await rm(tempOf(file), { force: true });
  },
};

/** What the scheduler reports to (scheduler.ts): each arm's earliest due time; settled at its stop. */
export interface NextDueSink {
  report(at: number | undefined): void;
  settle?(): Promise<void>;
}

export class NextDueFile implements NextDueSink {
  readonly file: string;
  private readonly io: NextDueIo;
  private readonly log?: Pick<Logger, 'warn'>;
  private written: number | null | undefined; // undefined: nothing written by this process yet
  private pending: number | null | undefined;
  private running: Promise<void> | undefined;

  constructor(dataDir: string, options: { io?: NextDueIo; log?: Pick<Logger, 'warn'> } = {}) {
    this.file = path.join(dataDir, NEXT_DUE_FILE);
    this.io = options.io ?? fileIo;
    this.log = options.log;
  }

  /** The scheduler's report: the earliest due time, or undefined when nothing is due. */
  report(at: number | undefined): void {
    const value = at === undefined ? null : Math.round(at);
    if (this.running ? this.pending === value : this.written === value) return;
    this.pending = value;
    if (!this.running) this.running = this.drain();
  }

  /** Resolves once the newest reported value is on disk (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Runtime stop (after the scheduler's last report): flushed, and no temp file left. Never rejects. */
  async settle(): Promise<void> {
    await this.flush();
    try { await this.io.discardTemp(this.file); } catch (error) { this.log?.warn('next-due temp file not removed', { error: String(error) }); }
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending !== undefined) {
        const value = this.pending;
        this.pending = undefined;
        if (value === this.written) continue;
        const content: NextDue = { at: value };
        try {
          await this.io.write(this.file, `${JSON.stringify(content)}\n`);
          this.written = value;
        } catch (error) {
          this.log?.warn('next-due file not written', { error: String(error) });
        }
      }
    } finally {
      this.running = undefined;
    }
  }
}
