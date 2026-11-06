// After a crash, an update, a quit or a power loss: the work a cut-off run belonged to gets one wake note
// (INTERRUPTED_NOTE: check what the run already did, then continue – tasks/ownership.ts recover), and one start
// notice says what happened ("Updated to X · N tasks continued" or "Restarted after an interruption · …", kv 'system',
// read by system.info).
// Owns: the note text and the start notice. Never: repeats, cancels or judges an action.

import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';

export const INTERRUPTED_NOTE = 'My last run was cut off (restart or stop). I check what it already did, then continue.';
const KV = 'system';
const NOTICE_KEY = 'startNotice';
const VERSION_KEY = 'version';

export interface StartNotice { id: string; text: string; at: number }

/** The start notice for this start (undefined when nothing happened worth saying). */
export function startNotice(input: { previous?: string; version: string; interrupted: number; continued: number; at: number }): StartNotice | undefined {
  const tasks = `${input.continued} task${input.continued === 1 ? '' : 's'} continued`;
  if (input.previous && input.previous !== input.version) return { id: `start:${input.at}`, text: `Updated to ${input.version} · ${tasks}`, at: input.at };
  if (input.interrupted > 0) return { id: `start:${input.at}`, text: `Restarted after an interruption · ${tasks}`, at: input.at };
  return undefined;
}

/** Stores this start's notice (or clears the last one) and the version it ran. */
export function recordStart(s: Pick<RuntimeServices, 'db' | 'clock'>, input: { version: string; interrupted: number; continued: number }): StartNotice | undefined {
  const kv = new KvRepo(s.db);
  const now = s.clock.now();
  const notice = startNotice({ ...input, previous: kv.get<string>(KV, VERSION_KEY), at: now });
  if (notice) kv.set(KV, NOTICE_KEY, notice, now);
  else kv.delete(KV, NOTICE_KEY);
  kv.set(KV, VERSION_KEY, input.version, now);
  return notice;
}

/** The notice of the current start, for system.info. */
export function readStartNotice(s: Pick<RuntimeServices, 'db'>): StartNotice | undefined {
  try { return new KvRepo(s.db).get<StartNotice>(KV, NOTICE_KEY) ?? undefined; } catch { return undefined; }
}
