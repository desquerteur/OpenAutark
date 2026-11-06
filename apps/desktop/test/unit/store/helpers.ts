// Test helpers for the runtime data foundation: in-memory DB, recording bus, temp dirs.
// Owns: fixtures only. Never: imported by production code.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bus } from '../../../src/runtime/bus.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import type { EventName } from '../../../src/shared/api/events.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';

export function memoryDb(): Db {
  const db = new Db(':memory:');
  migrate(db);
  return db;
}

export function recordingBus(): { bus: Bus; events: Array<{ event: EventName; data: unknown }>; of: (name: EventName) => unknown[] } {
  const bus = new Bus((error) => { throw error; });
  const events: Array<{ event: EventName; data: unknown }> = [];
  bus.onAny((event, data) => events.push({ event, data }));
  return { bus, events, of: (name) => events.filter((entry) => entry.event === name).map((entry) => entry.data) };
}

export function tempDir(prefix = 'wf-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function clock(): ManualClock {
  return new ManualClock();
}

/** Absolute path of apps/desktop/resources. */
export const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
