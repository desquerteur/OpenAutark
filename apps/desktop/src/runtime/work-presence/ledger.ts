// B-055 G (WORK-PRESENCE, Q11): the work ledger – in memory, who touched which file when (edit | write | read), which
// agents' turns are running now, and the "also changed while I worked on it" notes a finished turn leaves.
// One entry per file, agent and kind (the newest): a turn's overlap needs only "did someone else change the file
// after my turn started", which the newest entry answers. Entries older than TTL_MS go (unless their turn still
// runs), at most MAX_FILES files (the least recently touched go first); pruning runs on writes, never on a timer.
// Overlap (at the end of agent A's turn): A changed file F in that turn, and another agent B changed F after the turn
// started → A's next turn gets "B also changed F while I worked on it". B's own turn end decides B's note the same
// way, so each side hears of it exactly when the other's change fell inside its turn.
// Owns: entries, running turns, notes and their bounds. Never: reads files, persists anything or decides a refusal.

import type { FileRef } from './paths.ts';
import type { WorkKind } from './touches.ts';

export const TTL_MS = 2 * 60 * 60_000;
/** "Working nearby" shows changes this recent, or of a turn that is still running. */
export const RECENT_MS = 10 * 60_000;
export const MAX_FILES = 5_000;
const MAX_NOTES = 5;
const PRUNE_EVERY = 64;

export interface WorkEntry extends FileRef {
  agentId: string;
  agentName: string;
  runId: string;
  conversationId?: string;
  taskId?: string;
  kind: WorkKind;
  at: number;
}

export interface RunningTurn {
  runId: string;
  agentId: string;
  startedAt: number;
  conversationId?: string;
  taskId?: string;
  /** The folder the turn works in (git/records.ts turnCwd), when known. */
  cwd?: string;
}

/** Another agent changed a file while this agent's turn worked on it. */
export interface OverlapNote extends FileRef {
  byAgentId: string;
  byName: string;
  at: number;
}

const changes = (kind: WorkKind) => kind !== 'read';

export class WorkLedger {
  private readonly now: () => number;
  private readonly files = new Map<string, Map<string, WorkEntry>>(); // key → `${agentId}|${kind}` → entry
  private readonly turns = new Map<string, RunningTurn>();
  private readonly notes = new Map<string, OverlapNote[]>();
  private writes = 0;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Records a touch (the newest per file, agent and kind wins; an older one is ignored). */
  record(entry: WorkEntry): void {
    const slot = `${entry.agentId}|${entry.kind}`;
    const byAgent = this.files.get(entry.key) ?? new Map<string, WorkEntry>();
    const known = byAgent.get(slot);
    if (known && known.at > entry.at) return;
    byAgent.set(slot, entry);
    this.files.delete(entry.key); // most recently touched last (the bound drops from the front)
    this.files.set(entry.key, byAgent);
    if (++this.writes % PRUNE_EVERY === 0) this.prune();
    while (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value!);
  }

  turnStarted(turn: RunningTurn): void {
    this.turns.set(turn.runId, { ...this.turns.get(turn.runId), ...turn });
  }

  turn(runId: string): RunningTurn | undefined {
    return this.turns.get(runId);
  }

  isRunning(runId: string): boolean {
    return this.turns.has(runId);
  }

  /** The running turns of an agent. */
  runningOf(agentId: string): RunningTurn[] {
    return [...this.turns.values()].filter((turn) => turn.agentId === agentId);
  }

  /** A turn ended: it is no longer running, and its agent gets a note for each file another agent changed during it. */
  turnEnded(runId: string): OverlapNote[] {
    const turn = this.turns.get(runId);
    this.turns.delete(runId);
    if (!turn) return [];
    const found: OverlapNote[] = [];
    for (const byAgent of this.files.values()) {
      const mine = [...byAgent.values()].some((entry) => entry.runId === runId && entry.agentId === turn.agentId && changes(entry.kind));
      if (!mine) continue;
      const other = [...byAgent.values()].filter((entry) => entry.agentId !== turn.agentId && changes(entry.kind) && entry.at >= turn.startedAt)
        .sort((a, b) => b.at - a.at)[0];
      if (other) found.push({ key: other.key, file: other.file, byAgentId: other.agentId, byName: other.agentName, at: other.at });
    }
    if (found.length) {
      const kept = (this.notes.get(turn.agentId) ?? []).filter((note) => !found.some((next) => next.key === note.key && next.byAgentId === note.byAgentId));
      this.notes.set(turn.agentId, [...found, ...kept].slice(0, MAX_NOTES));
    }
    return found;
  }

  /** The agent's pending notes, newest first – taken: each is said once (in its next turn). */
  takeNotes(agentId: string): OverlapNote[] {
    const notes = this.notes.get(agentId) ?? [];
    this.notes.delete(agentId);
    const since = this.now() - TTL_MS;
    return notes.filter((note) => note.at >= since).sort((a, b) => b.at - a.at);
  }

  /** Entries still current: within the TTL, or of a turn that still runs. */
  private live(entry: WorkEntry, since: number): boolean {
    return entry.at >= since || this.turns.has(entry.runId);
  }

  /** The files an agent touched (any kind) within the TTL. */
  touchedBy(agentId: string): WorkEntry[] {
    const since = this.now() - TTL_MS;
    const out: WorkEntry[] = [];
    for (const byAgent of this.files.values()) for (const entry of byAgent.values()) if (entry.agentId === agentId && this.live(entry, since)) out.push(entry);
    return out;
  }

  /** Changes by agents other than `agentId` from the last RECENT_MS or of a running turn, newest first. */
  recentChanges(exceptAgentId?: string): WorkEntry[] {
    const since = this.now() - RECENT_MS;
    const out: WorkEntry[] = [];
    for (const byAgent of this.files.values()) {
      for (const entry of byAgent.values()) {
        if (entry.agentId !== exceptAgentId && changes(entry.kind) && this.live(entry, since)) out.push(entry);
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * The newest change of a file by an agent other than `exceptAgentId` after `after` – or by a turn that still runs
   * (an engine journals a call before it applies it, so a running turn's row may be older than what it changes).
   */
  changedBy(key: string, exceptAgentId: string, after: number): WorkEntry | undefined {
    const byAgent = this.files.get(key);
    if (!byAgent) return undefined;
    return [...byAgent.values()].filter((entry) => entry.agentId !== exceptAgentId && changes(entry.kind) && (entry.at > after || this.turns.has(entry.runId)))
      .sort((a, b) => b.at - a.at)[0];
  }

  /** Drops entries past the TTL whose turn ended, and notes past it. */
  prune(): void {
    const since = this.now() - TTL_MS;
    for (const [key, byAgent] of this.files) {
      for (const [slot, entry] of byAgent) if (!this.live(entry, since)) byAgent.delete(slot);
      if (!byAgent.size) this.files.delete(key);
    }
    for (const [agentId, notes] of this.notes) {
      const kept = notes.filter((note) => note.at >= since);
      if (kept.length) this.notes.set(agentId, kept); else this.notes.delete(agentId);
    }
  }

  /** How many files the ledger holds (tests, diagnostics). */
  get size(): number {
    return this.files.size;
  }
}
