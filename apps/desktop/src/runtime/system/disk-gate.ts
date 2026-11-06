// Low-disk gate of the dispatcher (B-059 #20): a full data volume makes every turn fail in its last database write
// and work stop without a word. Before a turn is admitted the free space of the data folder is read (fs.statfs) –
// on demand, at most once a minute, no timer. Below 1 GB no turn starts: the wakes stay queued (nothing is claimed,
// held or slot-queued) and the person gets one 'blocker' notice per low phase ("Disk almost full – agent work paused
// (<X> MB free)"; notify only emits on the bus, so it still works on a full disk). Above 1.5 GB (hysteresis) the next
// admission attempt – a new wake, a power resume, any agent's pump – resumes the whole queue (onFree).
// A volume that cannot be read (network share, odd path, no path at all) counts as unknown: never gated.
// Owns: the free-space reading, its cache, the thresholds and the one notice. Never: deletes files, claims or drops
// wakes, or arms a timer.

import { statfsSync } from 'node:fs';
import type { RuntimeServices } from '../contracts.ts';

/** Below this many free bytes no turn starts. */
export const DISK_LOW_BYTES = 1024 ** 3;
/** A low phase ends above this many free bytes. */
export const DISK_OK_BYTES = 1.5 * 1024 ** 3;
/** A reading is reused this long. */
export const DISK_CHECK_MS = 60_000;
const MB = 1024 ** 2;

/** Free bytes for this process on the volume of `dir`; undefined when it cannot be read. */
export function freeBytes(dir: string): number | undefined {
  try { const stats = statfsSync(dir); return Number(stats.bavail) * Number(stats.bsize); } catch { return undefined; }
}

export class DiskGate {
  private readonly services: () => RuntimeServices;
  private readonly onFree: () => void;
  private readonly read: (dir: string) => number | undefined;
  private low = false;
  private checkedAt = Number.NEGATIVE_INFINITY;

  /** `onFree`: a low phase ended (the dispatcher resumes its queue); `read`: the free-space probe (tests). */
  constructor(services: () => RuntimeServices, onFree: () => void, read: (dir: string) => number | undefined = freeBytes) {
    this.services = services;
    this.onFree = onFree;
    this.read = read;
  }

  /** True while no turn may start (the data volume is almost full). */
  blocked(): boolean {
    const services = this.services();
    const now = services.clock.now();
    if (now - this.checkedAt < DISK_CHECK_MS) return this.low;
    this.checkedAt = now;
    const dir = services.paths?.data;
    const free = dir ? this.read(dir) : undefined;
    const was = this.low;
    this.low = free !== undefined && (was ? free <= DISK_OK_BYTES : free < DISK_LOW_BYTES);
    if (this.low && !was) this.tell(services, free!);
    if (was && !this.low) {
      services.log.info('disk space is back; agent work resumes', { freeMb: free === undefined ? undefined : Math.floor(free / MB) });
      this.onFree();
    }
    return this.low;
  }

  private tell(services: RuntimeServices, free: number): void {
    const mb = Math.floor(free / MB);
    services.log.warn('disk almost full; agent work paused', { freeMb: mb });
    try {
      services.notifications.notify({ kind: 'blocker', title: 'Disk almost full – agent work paused', body: `${mb} MB free. Agent work continues once more space is free.` });
    } catch (error) {
      services.log.warn('disk notice failed', { error: String(error) });
    }
  }
}
