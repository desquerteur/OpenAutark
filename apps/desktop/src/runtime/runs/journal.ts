// RunJournal: durable audit of agent runs and their items (tool calls, effects …).
// Owns: run lifecycle writes, per-run item sequence, idempotency keys (an item with a known
// idem_key is returned instead of duplicated, so a retried tool call never journals – or
// executes – an external effect twice), data truncation, item updates (new data fields merge
// into the old ones, so a call keeps its category when its effect is settled), crash
// reconciliation (incl. engine-native calls that never got a result, RC1), the list of runs a
// shutdown cut off (kv 'system'/'shutdownRuns', recordShutdownRuns) and the 'run.upserted' / 'run.item' events.
// B-048 E1: a tool result whose output is longer than 4,000 characters (ours: tools/journal.ts hands the whole
// text; engine-native: tool_end.output, agents/turn-attempt.ts) is kept whole in a blob (keepOutput – compose keeps
// the runs the context ledger captures, so background runs add no blobs nothing could restore) that the row names
// as data.outputBlob, with data.outputChars = the full length (always set) – the context ledger restores it from
// there (context/ledger/originals.ts). The row itself stays truncated, previews unchanged; an output the
// registry already stored as a blob (data.blobIds, over 24,000 characters) is not stored twice.
// B-057: start() stores a split run's `splitId` (runs.split_id; later saves keep it); listTopLevel leaves split runs
// out, listBySplit reads them (contracts/splits.ts declares both on RunJournal).
// B-059 #16: reconcile() keeps the crash marker (store/runs.ts CRASH_ERROR) for real crashes only – a run the graceful stop
// had cut off that was still running when the app ended gets CLOSED_ERROR (tasks/crash-repeat.ts counts crashes).
// Never: executes or retries anything. reconcile() only marks state; ownership decides.

import type { Bus } from '../bus.ts';
import type { Clock, Logger, RunJournal } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import type { Run, RunItem, RunStatus } from '../../shared/model/runs.ts';
import { CRASH_ERROR, RunItemRepo, RunRepo } from '../store/runs.ts';
import { KvRepo } from '../store/kv.ts';

/** B-059 #16: the error of a run a graceful stop cut off that was still running when the app ended – no crash. */
export const CLOSED_ERROR = 'The app was closed before this run finished.';

export interface JournalDeps {
  db: Db;
  bus: Bus;
  clock: Clock;
  /** B-048 E1: stores a tool output over 4,000 characters of run `runId` whole (a blob); its id, or undefined (not kept –
   *  compose keeps only what the context ledger captures). Absent: nothing is kept. */
  keepOutput?: (text: string, name: string, runId: string) => Promise<string | undefined>;
  log?: Logger;
}

const MAX_STRING = 4000; // per string value inside item data

/** The whole output text a tool_result carries: a string (engine-native) or a ToolOutput's text parts (ours). */
export function fullOutput(data: Record<string, unknown> | undefined): string | undefined {
  const output = data?.output;
  if (typeof output === 'string') return output;
  const content = (output as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  return content.filter((part: { type?: string; text?: unknown }) => part?.type === 'text' && typeof part.text === 'string').map((part: { text: string }) => part.text).join('\n');
}
const MAX_DATA = 32 * 1024; // whole item data JSON
const TERMINAL: readonly RunStatus[] = ['done', 'failed', 'interrupted', 'unknown'];
const KV_NS = 'system';
const SHUTDOWN_KEY = 'shutdownRuns';

/** Caps strings and arrays so one huge tool output cannot bloat the DB (big outputs belong in blobs). */
export function truncateData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} more chars]` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => truncateData(item, depth + 1));
    if (value.length > 100) items.push(`[${value.length - 100} more items]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = truncateData(item, depth + 1);
  return out;
}

function boundedData(data: Record<string, unknown>): Record<string, unknown> {
  const truncated = truncateData(data) as Record<string, unknown>;
  const size = JSON.stringify(truncated).length;
  if (size <= MAX_DATA) return truncated;
  return { truncated: true, size, preview: JSON.stringify(truncated).slice(0, MAX_STRING) };
}

/**
 * A graceful stop (dispatcher.stop, before it aborts its turns) names the runs it cuts off. They
 * end 'interrupted' by themselves, so the next start's reconcile() would not see them running;
 * this list lets it name their unknown effects all the same (RC1). Ids add up until the next
 * start; an empty list clears it (the dispatcher started again, e.g. a cancelled update restart).
 */
export function recordShutdownRuns(s: { db: Db; clock: Clock }, runIds: readonly string[]): void {
  const kv = new KvRepo(s.db);
  if (!runIds.length) { kv.delete(KV_NS, SHUTDOWN_KEY); return; }
  const before = kv.get<string[]>(KV_NS, SHUTDOWN_KEY) ?? [];
  kv.set(KV_NS, SHUTDOWN_KEY, [...new Set([...before, ...runIds])], s.clock.now());
}

/** B-057: did a graceful stop cut `runId` off (recordShutdownRuns, until the next start or reconcile)? A split cut so runs again without counting an attempt. */
export function cutByShutdown(db: Db, runId: string): boolean {
  const ids = new KvRepo(db).get<unknown>(KV_NS, SHUTDOWN_KEY);
  return Array.isArray(ids) && ids.includes(runId);
}

export class Journal implements RunJournal {
  private readonly deps: JournalDeps;
  private readonly runs: RunRepo;
  private readonly itemsRepo: RunItemRepo;
  private readonly keeping = new Set<Promise<void>>();

  constructor(deps: JournalDeps) {
    this.deps = deps;
    this.runs = new RunRepo(deps.db);
    this.itemsRepo = new RunItemRepo(deps.db);
  }

  start(input: Omit<Run, 'status' | 'startedAt'>): Run {
    if (this.runs.get(input.id)) throw new WorkforceError('conflict', 'This run already exists.', { details: { id: input.id } });
    const run: Run = { ...input, status: 'running', startedAt: this.deps.clock.now() };
    this.runs.save(run);
    const saved = this.runs.get(run.id)!;
    this.deps.bus.emit('run.upserted', saved);
    return saved;
  }

  item(runId: string, input: Omit<RunItem, 'id' | 'runId' | 'seq' | 'createdAt'>): RunItem {
    if (input.idemKey) {
      const existing = this.itemsRepo.byIdemKey(input.idemKey);
      if (existing) return existing;
    }
    if (!this.runs.get(runId)) throw new WorkforceError('not_found', 'This run does not exist.', { details: { runId } });
    const now = this.deps.clock.now();
    // B-048 E1: a long tool output is kept whole (keep below); the row knows its full length.
    const full = input.kind === 'tool_result' ? fullOutput(input.data) : undefined;
    const long = full !== undefined && full.length > MAX_STRING;
    const item: RunItem = {
      ...input,
      id: newId('ri', now),
      runId,
      seq: 0,
      data: boundedData(long ? { ...input.data, outputChars: full.length } : input.data ?? {}),
      createdAt: now,
    };
    this.deps.db.tx(() => {
      item.seq = this.itemsRepo.nextSeq(runId);
      this.itemsRepo.insert(item);
    });
    const saved = this.itemsRepo.get(item.id)!;
    this.deps.bus.emit('run.item', saved);
    const blobIds = input.data?.blobIds;
    if (long && !(Array.isArray(blobIds) && blobIds.length > 0)) this.keep(saved.id, full, input.name, runId);
    return saved;
  }

  /** B-048 E1: writes the whole output to a blob and names it on the row (data.outputBlob); best effort, never fails the item. */
  private keep(itemId: string, text: string, name: string | undefined, runId: string): void {
    const keepOutput = this.deps.keepOutput;
    if (!keepOutput) return;
    let pending: Promise<string | undefined>;
    try { pending = keepOutput(text, name ?? 'tool', runId); } catch (error) { pending = Promise.reject(error); } // decided now (the run is captured now)
    const write = pending.then((blobId) => {
      if (!blobId) return;
      // json_set, not updateItem: the row's strings are truncated already and stay as they are.
      this.deps.db.run(`UPDATE run_items SET data = json_set(data, '$.outputBlob', ?) WHERE id = ?`, [blobId, itemId]);
      const updated = this.itemsRepo.get(itemId);
      if (updated) this.deps.bus.emit('run.item', updated);
    }).catch((error: unknown) => {
      this.deps.log?.warn('tool output not kept whole', { itemId, error: String(error) });
    });
    this.keeping.add(write);
    void write.finally(() => this.keeping.delete(write));
  }

  /** Blob writes of long outputs still running (tests, an orderly stop). */
  async settled(): Promise<void> {
    while (this.keeping.size) await Promise.all([...this.keeping]);
  }

  /** `data` merges into the item's data (a field given again wins); fields not named are kept. */
  updateItem(id: string, patch: Partial<Pick<RunItem, 'data' | 'effectStatus'>>): void {
    const item = this.itemsRepo.get(id);
    if (!item) throw new WorkforceError('not_found', 'This run item does not exist.');
    this.itemsRepo.update(id, { data: patch.data === undefined ? undefined : boundedData({ ...item.data, ...patch.data }), effectStatus: patch.effectStatus });
    this.deps.bus.emit('run.item', this.itemsRepo.get(id)!);
  }

  finish(runId: string, patch: Partial<Run>): Run {
    const run = this.runs.get(runId);
    if (!run) throw new WorkforceError('not_found', 'This run does not exist.', { details: { runId } });
    const next: Run = { ...run, ...patch, id: run.id, agentId: run.agentId, trigger: run.trigger, startedAt: run.startedAt };
    if (!patch.status) next.status = 'done';
    if (TERMINAL.includes(next.status) && next.endedAt === undefined) next.endedAt = this.deps.clock.now();
    if (next.error) next.error = next.error.slice(0, 300);
    if (next.summary) next.summary = next.summary.slice(0, 300);
    this.runs.save(next);
    const saved = this.runs.get(runId)!;
    this.deps.bus.emit('run.upserted', saved);
    return saved;
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  list(agentId: string, limit = 50): Run[] {
    return this.runs.listByAgent(agentId, Math.max(1, Math.min(500, limit)));
  }

  /** B-057: like list, without the runs of splits (the agent's own turns). */
  listTopLevel(agentId: string, limit = 50): Run[] {
    return this.runs.listByAgent(agentId, Math.max(1, Math.min(500, limit)), { topLevel: true });
  }

  /** B-057: the runs of these splits, oldest first. */
  listBySplit(splitIds: readonly string[]): Run[] {
    return this.runs.listBySplit(splitIds);
  }

  items(runId: string): RunItem[] {
    return this.itemsRepo.list(runId);
  }

  /**
   * After a crash, update or power loss: runs still 'running' become 'interrupted'; pending
   * effects and engine-native calls without a result in them become 'unknown' (RC1). The runs a
   * graceful stop cut off (recordShutdownRuns; already closed, unless they finished 'done') are
   * treated alike. Returns how many runs this call interrupted and, for the recovery notes
   * (tasks/recover-notes.ts), the ids of both; the shutdown list is consumed (idempotent).
   */
  reconcile(): { interrupted: number; unknownEffects: number; runIds: string[] } {
    const now = this.deps.clock.now();
    const { ids, cut, unknown } = this.deps.db.tx(() => {
      const interrupted = this.runs.interruptRunning(now);
      const kv = new KvRepo(this.deps.db);
      const listed = kv.get<string[]>(KV_NS, SHUTDOWN_KEY) ?? [];
      // B-059 #16: a run the graceful stop cut off that had not closed when the app ended is no crash (tasks/crash-repeat.ts).
      for (const id of interrupted.filter((item) => listed.includes(item))) this.deps.db.run('UPDATE runs SET error = ? WHERE id = ? AND error = ?', [CLOSED_ERROR, id, CRASH_ERROR]);
      const stopped = listed.filter((id) => {
        const status = typeof id === 'string' && !interrupted.includes(id) ? this.runs.get(id)?.status : undefined;
        return status !== undefined && status !== 'done';
      });
      kv.delete(KV_NS, SHUTDOWN_KEY);
      const all = [...interrupted, ...new Set(stopped)];
      return { ids: interrupted, cut: all, unknown: [...this.itemsRepo.markPendingUnknown(), ...this.itemsRepo.markOwnUnknown(all)] };
    });
    for (const id of ids) this.deps.bus.emit('run.upserted', this.runs.get(id)!);
    for (const item of unknown) this.deps.bus.emit('run.item', item);
    return { interrupted: ids.length, unknownEffects: unknown.length, runIds: cut };
  }
}
