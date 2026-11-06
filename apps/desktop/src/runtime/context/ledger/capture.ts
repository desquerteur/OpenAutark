// Capture into the context ledger (B-048 E1). A turn attempt names its run (agents/turn-attempt.ts →
// ledger.capture): the chat messages its input shows become m items first (the newest 60 after the last
// recorded one, as the delta shows them; the agent's own message is skipped when the run that wrote it left
// its own words in the ledger), then the run's journal items become ledger items as the journal writes them
// ('run.item'), so the order is the turn's order. Each kind has one fixed source:
//   tool_result  our calls (the registry's result, tools/journal.ts) and engine-native calls (tool_end.output,
//                turn-attempt) → t; skills.load → s; files.read → f (the call's name and args from its tool_call row)
//   reasoning    a closed block (live: false; a later authoritative text updates it) → r
//   note         the 'Answer' parts (agents/publishing.ts) and commentary updates → a; a steer note
//                ({steered: {upToSeq}}, agents/dispatch-steer.ts) → the steered chat lines as m items at that point
// Origin = the attempt's engine and model (a failover attaches again with its own). The run is let go when it
// ends ('run.upserted' with a final status). A context.restore result is condensed to its first line at once: the
// items it brought back are in place again, so a rebuild does not carry them twice – B-049 F9: not when it restored a
// nested item (a call inside a code-mode script, never replayed: the restore result is its only place in the context).
// The same for a code-mode script whose output is nearly all restores made inside it (restoredInScript).
// B-049 F9: a code-mode script call (Codex `exec`, engine-native) is a t item "exec: <the script's first line>" whose
// estimate is its source (the full length when the journal's preview is cut) plus what it printed; a call made inside a
// script keeps its own estimate – the ledger reads it as nested (store.ts), worth 0 in the live context.
// Owns: the run map (bounded), these mappings, titles and token estimates. Never: captures runs nobody attached,
// throws into the journal or the turn, or stores text beyond the title (originals stay where they are).

import type { ChatService, FileStore, LedgerRun, Logger } from '../../contracts.ts';
import type { Message } from '../../../shared/model/chat.ts';
import type { Run, RunItem } from '../../../shared/model/runs.ts';
import { ledgerTitle, type LedgerItem, type LedgerKind, type LedgerMark, type NewLedgerItem } from '../../../shared/model/context-ledger.ts';
import type { Db } from '../../db/database.ts';
import { blobIdsOf, callRow, journalRow, outputTextOf } from './originals.ts';
import type { LedgerStore } from './store.ts';
import { scriptLine } from '../../engines/rebuild-text.ts'; // B-049 F9

/** Messages recorded per turn at most (the delta's own window, context/delta.ts DELTA_LIMIT). */
export const SYNC_LIMIT = 60;
/** Outputs longer than this are kept whole in a blob (runs/journal.ts) – they count toward the retention budget. */
export const KEPT_IN_JOURNAL = 4000;
const MAX_RUNS = 200;
const FINAL: ReadonlySet<string> = new Set(['done', 'failed', 'interrupted', 'unknown']);
const ANSWER = 'Answer';
const RESTORE = 'context.restore';
/** What a script's output may hold besides its restores to count as one: the engine's envelope ("Script completed … Output:") and a short line. */
const SCRIPT_REST = 400;

export interface CaptureDeps {
  db: Db;
  store: LedgerStore;
  chats: Pick<ChatService, 'messages'>;
  files?: Pick<FileStore, 'get'>;
  record(agentId: string, conversationId: string, item: NewLedgerItem): LedgerItem;
  mark(agentId: string, conversationId: string, marks: LedgerMark[]): void;
  renderMessage(message: Message, agentId: string): string;
  log?: Logger;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function argOf(args: unknown, key: string): string {
  if (typeof args === 'string') { try { return argOf(JSON.parse(args), key); } catch { return ''; } }
  return args && typeof args === 'object' ? str((args as Record<string, unknown>)[key]) : '';
}

/** B-049 F9: a script call's source from its journaled args – also the head of a cut preview. */
function sourceOf(args: unknown): string {
  const whole = argOf(args, 'source');
  if (whole || typeof args !== 'string') return whole;
  const head = /"source":"((?:[^"\\]|\\.)*)/.exec(args)?.[1] ?? '';
  try { return JSON.parse(`"${head}"`) as string; } catch { return head.replace(/\\n/g, '\n'); }
}

/** B-049 F9: the ids a context.restore result's first line names ("Restored t5, m12 – kept …"). */
function restoredIds(first: string): string[] {
  return (/^Restored (.+?) –/.exec(first)?.[1] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
}

export class LedgerCapture {
  private readonly deps: CaptureDeps;
  private readonly runs = new Map<string, LedgerRun>();

  constructor(deps: CaptureDeps) {
    this.deps = deps;
  }

  /** A turn attempt starts (again, after a failover: the new origin wins). */
  attach(run: LedgerRun): void {
    this.runs.delete(run.runId);
    this.runs.set(run.runId, run);
    while (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);
    run.first?.();
    this.syncMessages(run);
  }

  attached(runId: string): LedgerRun | undefined {
    return this.runs.get(runId);
  }

  /** The runs attached for this agent and chat (normally one: its running turn). */
  attachedFor(agentId: string, conversationId: string): string[] {
    return [...this.runs.values()].filter((run) => run.agentId === agentId && run.conversationId === conversationId).map((run) => run.runId);
  }

  onRun(run: Pick<Run, 'id' | 'status'>): void {
    if (FINAL.has(run.status)) this.runs.delete(run.id);
  }

  onItem(item: RunItem): void {
    const run = this.runs.get(item.runId);
    if (!run) return;
    try {
      if (item.kind === 'tool_result') this.toolResult(run, item);
      else if (item.kind === 'reasoning') this.reasoning(run, item);
      else if (item.kind === 'note') this.note(run, item);
    } catch (error) {
      this.deps.log?.warn('context ledger capture failed', { runId: item.runId, kind: item.kind, error: String(error) });
    }
  }

  /** Messages the turn shows (after the last recorded one, newest SYNC_LIMIT up to `seenSeq`). */
  syncMessages(run: LedgerRun): number {
    const { agentId, conversationId, seenSeq } = run;
    if (!seenSeq || seenSeq < 1) return 0;
    const last = this.deps.store.lastMessageSeq(agentId, conversationId) ?? 0;
    if (seenSeq <= last) return 0;
    let count = 0;
    for (const message of this.deps.chats.messages(conversationId, { beforeSeq: seenSeq + 1, limit: SYNC_LIMIT })) {
      if (message.seq <= last || message.seq > seenSeq || message.state === 'streaming') continue;
      if (message.authorId === agentId && message.runId && this.deps.store.hasOwnWords(agentId, conversationId, message.runId)) continue;
      if (this.deps.store.byRef(agentId, conversationId, `msg:${message.id}`)) continue; // moved to a new seq (B-047 D4)
      let line = '';
      try { line = this.deps.renderMessage(message, agentId); } catch { line = message.body; }
      this.deps.record(agentId, conversationId, {
        kind: 'message', seq: message.seq, runId: run.runId, ref: `msg:${message.id}`, createdAt: message.createdAt,
        title: ledgerTitle(line.replace(/^\[[^\]\n]{1,40}\]\s*/, ''), `Message #${message.seq}`), text: line,
      });
      count++;
    }
    return count;
  }

  private origin(run: LedgerRun) {
    return { engine: run.engine, model: run.model };
  }

  private toolResult(run: LedgerRun, item: RunItem): void {
    const callId = str(item.data.callId);
    const call = callRow(this.deps.db, item.runId, callId);
    const name = item.name ?? call?.name ?? 'tool';
    const kind: LedgerKind = name === 'skills.load' ? 'skill' : name === 'files.read' ? 'file' : 'tool';
    const visible = outputTextOf(item.data.output) || str(item.data.summary);
    const chars = typeof item.data.outputChars === 'number' ? item.data.outputChars : visible.length;
    const args = call?.data.args;
    const argsText = typeof args === 'string' ? args : args === undefined ? '' : JSON.stringify(args);
    const argsChars = Math.max(argsText.length, typeof call?.data.argsChars === 'number' ? call.data.argsChars : 0); // B-049 F9: a cut preview's full length
    const script = name === 'exec' && call?.data.own === true; // B-049 F9: a code-mode script (Codex)
    const what = kind === 'skill' ? `Skill ${argOf(args, 'name') || 'text'}`
      : kind === 'file' ? `File ${argOf(args, 'path') || argOf(args, 'file') || 'content'}`
      : script ? `exec: ${scriptLine(sourceOf(args)) || 'a script'}`
      : `${name}: ${str(call?.data.summary) || str(call?.data.title) || visible.split('\n')[0]}`;
    const blobs = blobIdsOf(item.data);
    const bytes = blobs.length
      ? blobs.reduce((sum, id) => sum + (this.deps.files?.get(id)?.size ?? 0), 0) || chars
      : chars > KEPT_IN_JOURNAL ? chars : 0;
    const before = this.deps.store.byRef(run.agentId, run.conversationId, `item:${item.id}`);
    const recorded = this.deps.record(run.agentId, run.conversationId, {
      kind, runId: item.runId, ref: `item:${item.id}`, origin: this.origin(run), title: ledgerTitle(what, name),
      tokens: Math.ceil(argsChars / 4) + Math.ceil(chars / 4), bytes,
    });
    const first = visible.split('\n')[0].trim();
    const nestedBack = (line: string) => restoredIds(line).some((id) => Number(this.deps.store.row(run.agentId, run.conversationId, id)?.nested));
    const back = before || item.data.ok === false ? undefined
      : name === RESTORE ? (/^Restored /.test(visible) && !nestedBack(first) ? first : undefined)
      : script ? this.restoredInScript(run, recorded.itemId, chars, nestedBack) : undefined;
    if (back) {
      this.deps.mark(run.agentId, run.conversationId, [{
        itemId: recorded.itemId, state: 'condensed', by: 'agent', reason: 'the restored items are back in place',
        condensed: `${back} They are back in place in my context.`,
      }]);
    }
  }

  /**
   * A script that did little but a restore (Codex code mode: `text(await tools.tools__call({name: "context.restore", …}))`): the first lines of
   * the restores made inside it, when they are nearly all of its output – its output holds the originals again, which are back in place too
   * (q-r2d s14, 03.11.2026: a rebuilt history held a 17,686-character file twice). Undefined otherwise.
   */
  private restoredInScript(run: LedgerRun, scriptId: string, chars: number, nestedBack: (line: string) => boolean): string | undefined {
    const rows = this.deps.store.rows(run.agentId, run.conversationId).filter((row) => row.run_id === run.runId && row.item_id !== scriptId);
    const firsts: string[] = [];
    let restored = 0;
    for (const row of [...rows].reverse()) {
      if (!Number(row.nested)) break; // the calls of this script are the nested rows right before it
      const result = row.ref?.startsWith('item:') ? journalRow(this.deps.db, row.ref.slice(5)) : undefined;
      if (result?.name !== RESTORE || result.data.ok === false) continue;
      const text = outputTextOf(result.data.output);
      const line = text.split('\n')[0].trim();
      if (!/^Restored /.test(line) || nestedBack(line)) return undefined;
      firsts.unshift(line);
      restored += typeof result.data.outputChars === 'number' ? result.data.outputChars : text.length;
    }
    return firsts.length && chars - restored <= SCRIPT_REST ? firsts.join(' ') : undefined;
  }

  private reasoning(run: LedgerRun, item: RunItem): void {
    const summary = str(item.data.summary).trim();
    if (item.data.live !== false || !summary) return;
    this.deps.record(run.agentId, run.conversationId, {
      kind: 'reasoning', runId: item.runId, ref: `item:${item.id}`, origin: this.origin(run), title: ledgerTitle(summary.split('\n')[0], 'Reasoning'), text: summary,
    });
  }

  private note(run: LedgerRun, item: RunItem): void {
    // A steer landed in the running turn (agents/dispatch-steer.ts journals {steered: {lines, upToSeq}}): those
    // lines become m items here, between the turn's items, not after the turn.
    const steered = (item.data.steered as { upToSeq?: unknown } | undefined)?.upToSeq;
    if (typeof steered === 'number' && steered > 0) {
      this.syncMessages({ ...run, seenSeq: steered });
      return;
    }
    const answer = item.name === ANSWER && item.data.answer === true;
    if (!answer && item.data.commentary !== true) return;
    const text = str(item.data.text).trim();
    if (!text) return;
    this.deps.record(run.agentId, run.conversationId, {
      kind: 'assistant', runId: item.runId, ref: `item:${item.id}`, origin: this.origin(run), title: ledgerTitle(text.split('\n')[0], answer ? 'Answer' : 'Update'), text,
    });
  }
}
