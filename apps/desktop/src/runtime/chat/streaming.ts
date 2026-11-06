// The rows of runs at work on this PC (B-075: a run's status is a value in its chat). A run's row (state 'streaming')
// holds what the agent writes (its body) and what it does (meta.live: note, model · effort, the newest steps and how many
// came before). Both are written into the row – the first change after a quiet moment at once, every further one
// together after the gap (at most one write per `gapMs`) – and go out as message.updated, so every window, linked PC and
// phone renders the same row with the same built-in design. All steps of the run and its newest text are kept here for
// its end (end(): the finish writes the steps as meta.lines). A silent row (a run whose answer is kept internal) shows
// only its work: its text stays with the run until a finish posts it.
// Owns: the in-memory state of each streaming row of this PC and its throttled writes.
// Never: writes a row that is no longer streaming (finished, removed – its finish or removal takes over), anything but
// its body and meta, or a tool's output.

import type { Bus } from '../bus.ts';
import { LIVE_STEPS, type LiveMeta, type LiveStep, type Message } from '../../shared/model/chat.ts';
import type { MessageRepo } from './message-repo.ts';

/** At most one write of a streaming row per this many ms. */
export const LIVE_GAP_MS = 500;

/** What a run's row says about the route and the moment (from the dispatcher's live activity, chat/live-row.ts). */
export type LiveNote = Partial<Pick<LiveMeta, 'note' | 'model' | 'effort'>>;

interface Entry {
  /** The row as it is written next (body and meta). */
  message: Message;
  /** Every step so far (meta.live shows the newest LIVE_STEPS); a call id or a reasoning item → its index. */
  steps: LiveStep[];
  keys: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
  /** When it was last written (Date.now: a rate, not a time of the chat). */
  last: number;
}

export class StreamingRows {
  private readonly entries = new Map<string, Entry>();
  private readonly runs = new Map<string, string>(); // run id → its row
  private readonly deps: { msgs: MessageRepo; bus: Bus; written?: (message: Message) => void };
  private readonly gapMs: number;

  /** `written`: after a row was written and announced (the chat service sends the chat's summary). */
  constructor(deps: { msgs: MessageRepo; bus: Bus; written?: (message: Message) => void }, gapMs = LIVE_GAP_MS) {
    this.deps = deps;
    this.gapMs = gapMs;
  }

  begin(message: Message): void {
    this.entries.set(message.id, { message: { ...message, meta: { ...message.meta } }, steps: [], keys: new Map(), last: 0 });
    if (message.runId) this.runs.set(message.runId, message.id);
  }

  /** The run's row on this PC while it streams. */
  byRun(runId: string): string | undefined {
    return this.runs.get(runId);
  }

  append(id: string, text: string): void {
    const entry = this.entries.get(id);
    if (!entry || !text || entry.message.silent) return; // finished or unknown: late text is dropped; a silent row holds none
    entry.message.body += text;
    this.schedule(id, entry);
  }

  /** The run's note, model and effort; written only when one of them changed. */
  note(runId: string, note: LiveNote): void {
    const entry = this.ofRun(runId);
    if (!entry) return;
    const live = this.live(entry);
    const next = { ...live, ...Object.fromEntries(Object.entries(note).filter(([, value]) => typeof value === 'string' && value)) };
    if (next.note === live.note && next.model === live.model && next.effort === live.effort) return;
    entry.message.meta.live = next;
    this.schedule(entry.message.id, entry);
  }

  /** Adds or changes the run's step under `key` (a call id, a reasoning item); `change` gets the step there now. */
  step(runId: string, key: string, change: (current: LiveStep | undefined) => LiveStep | undefined): void {
    const entry = this.ofRun(runId);
    if (!entry) return;
    const index = entry.keys.get(key);
    const current = index === undefined ? undefined : entry.steps[index];
    const next = change(current);
    if (!next || JSON.stringify(next) === JSON.stringify(current)) return;
    if (index === undefined) { entry.keys.set(key, entry.steps.length); entry.steps.push(next); } else entry.steps[index] = next;
    const live = this.live(entry);
    entry.message.meta.live = { ...live, steps: entry.steps.slice(-LIVE_STEPS), more: Math.max(0, entry.steps.length - LIVE_STEPS) };
    this.schedule(entry.message.id, entry);
  }

  /** Forgets the row (its finish or removal writes it now); its steps and its newest text (written or still held back). */
  end(id: string): { steps: LiveStep[]; body: string } | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
    if (entry.message.runId && this.runs.get(entry.message.runId) === id) this.runs.delete(entry.message.runId);
    return { steps: entry.steps, body: entry.message.body };
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.end(id);
  }

  private ofRun(runId: string): Entry | undefined {
    const id = this.runs.get(runId);
    return id ? this.entries.get(id) : undefined;
  }

  private live(entry: Entry): LiveMeta {
    return entry.message.meta.live ?? { steps: [], more: 0, startedAt: entry.message.createdAt };
  }

  private schedule(id: string, entry: Entry): void {
    if (entry.timer) return;
    const wait = entry.last + this.gapMs - Date.now();
    if (wait <= 0) { this.write(id); return; }
    entry.timer = setTimeout(() => { entry.timer = undefined; this.write(id); }, wait);
    (entry.timer as { unref?: () => void }).unref?.();
  }

  private write(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.last = Date.now();
    const { message } = entry;
    if (!this.deps.msgs.writeLive(id, message.body, message.meta)) { this.end(id); return; } // finished or removed meanwhile
    const copy: Message = { ...message, meta: { ...message.meta } };
    this.deps.bus.emit('message.updated', copy);
    this.deps.written?.(copy);
  }
}
