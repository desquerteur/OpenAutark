// The ledger view (B-048 E1): the items in order with their marks applied – what the next native rebuild of the
// agent's session contains (E2). A kept item is its original (a tool output capped like the model sees it: one of ours at
// 24,000 characters plus a note, an engine's own at 64,000, engines/output.ts), a condensed one its condensed text with the restore stamp appended verbatim
// ({"compacted":"t17","was":"<n> tokens","restore":"context.restore"}), a hidden one is left out. Chat lines read
// as the agent sees them in context (context/render.ts); the agent's own message without own-words items is
// assistant text, every other chat line user-side; tool, skill and file items carry their call. A condensed
// line of anyone but the person (a colleague agent or person, an external contact) keeps its speaker
// ("[11:05] Ava: <condensed>"), so their condensed words never read as the person's.
// B-049 F9: a nested item (a call inside a code-mode script) is in the view, marked `nested`, with its call and output; it leaves with its hidden script.
// Owns: that mapping. Never: decides marks or reads beyond one bounded original per item (a condensed tool item
// reads only its call, not its output). A pruned tool item (the person's Forget also prunes kept ones, forget.ts) keeps its pair with
// neither its arguments nor its output: only what is left of it.

import { compactStamp, type LedgerViewItem } from '../../../shared/model/context-ledger.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import type { Message } from '../../../shared/model/chat.ts';
import { isScriptCall } from '../../engines/code-mode.ts';
import { callRow, journalRow, originalOf, toolOutput, type OriginalDeps } from './originals.ts';
import type { LedgerRow } from './store.ts';

/** Tool outputs in a rebuild: the model's own cap (tools/outputs.ts MAX_TEXT_CHARS). */
export const VIEW_OUTPUT_CHARS = 24_000;
/** An engine's own tool (a shell, a code-mode script): what the model saw of it (engines/output.ts OUTPUT_CAP). A kept item stays what it was. */
const VIEW_OWN_OUTPUT_CHARS = 64_000;
/** A chat message or own text in a rebuild (messages are capped at 6000 in context anyway). */
const VIEW_TEXT_CHARS = 24_000;

export interface ViewDeps extends OriginalDeps {
  /** The message as one chat line of the agent's context ("[11:05] Lena: …"). */
  renderMessage(message: Message, agentId: string): string;
}

/** A journaled preview of call arguments, parsed back when it is JSON. */
function argsOf(preview: unknown): unknown {
  if (typeof preview !== 'string') return preview ?? {};
  try { return JSON.parse(preview); } catch { return preview; }
}

function cutNote(itemId: string, more: number): string {
  return more > 0 ? `\n… [output cut for context: about ${Math.max(1, Math.round(more / 1024))} KB more; context.restore ${itemId} returns more]` : '';
}

/** The tool call behind a tool/skill/file row (name, args, call id) and – `withOutput` – its output as the view shows it. */
function callOf(deps: ViewDeps, row: LedgerRow, withOutput = true): { name: string; args: unknown; callId: string; output: string; own?: boolean; ok?: boolean } | undefined {
  if (!row.ref?.startsWith('item:')) return undefined;
  const result = journalRow(deps.db, row.ref.slice(5));
  if (!result) return undefined;
  const callId = typeof result.data.callId === 'string' ? result.data.callId : '';
  const call = callRow(deps.db, result.run_id, callId);
  if (row.pruned_at !== null) return { name: result.name ?? call?.name ?? 'tool', args: {}, callId, output: safe(deps, row.condensed ?? row.title) };
  const out = withOutput ? toolOutput(deps, result, call?.data.own === true ? VIEW_OWN_OUTPUT_CHARS : VIEW_OUTPUT_CHARS) : { text: '', more: 0 };
  return {
    name: result.name ?? call?.name ?? 'tool', args: argsOf(call?.data.args), callId, output: `${out.text}${cutNote(row.item_id, out.more)}`,
    ...(call?.data.own === true ? { own: true } : {}), ...(result.data.ok === false ? { ok: false } : {}),
  };
}

function messageOf(deps: ViewDeps, row: LedgerRow): Message | undefined {
  if (!row.ref?.startsWith('msg:')) return undefined;
  try { return deps.chats.message(row.ref.slice(4)); } catch { return undefined; }
}

/** A condensed chat line of someone else, under its speaker's header (the condensed text as its plain body). */
function condensedLine(deps: ViewDeps, row: LedgerRow, message: Message, condensed: string): string {
  try {
    const line = deps.renderMessage({ ...message, kind: 'text', body: condensed, attachments: [], meta: {}, replyTo: undefined, state: 'final' }, row.agent_id);
    return line.trim() ? line : condensed;
  } catch {
    return condensed;
  }
}

function messageLine(deps: ViewDeps, row: LedgerRow): { text: string; own: boolean } | undefined {
  const message = messageOf(deps, row);
  if (!message) return undefined;
  const own = message.authorId === row.agent_id;
  if (own) return { text: safe(deps, message.body).slice(0, VIEW_TEXT_CHARS), own };
  try { return { text: deps.renderMessage(message, row.agent_id), own }; } catch { return { text: safe(deps, message.body).slice(0, VIEW_TEXT_CHARS), own }; }
}

/** The nested items whose script (the next script call of their run) is hidden: a hidden item leaves nothing behind. */
export function goneWithScript(deps: ViewDeps, rows: readonly LedgerRow[]): Set<string> {
  const gone = new Set<string>();
  if (!rows.some((row) => row.state === 'hidden' && row.kind === 'tool')) return gone;
  const hiddenNext = new Map<string, boolean>();
  for (const row of [...rows].reverse()) {
    const run = row.run_id ?? '';
    if (Number(row.nested)) { if (hiddenNext.get(run)) gone.add(row.item_id); continue; }
    if (row.kind !== 'tool') continue;
    const name = callOf(deps, row, false)?.name;
    if (name && isScriptCall(name, row.origin_engine ?? undefined)) hiddenNext.set(run, row.state === 'hidden');
  }
  return gone;
}

/** One view entry; undefined for a hidden item. */
export function viewItem(deps: ViewDeps, row: LedgerRow): LedgerViewItem | undefined {
  if (row.state === 'hidden') return undefined;
  const origin = { ...(row.origin_engine ? { engine: row.origin_engine } : {}), ...(row.origin_model ? { model: row.origin_model } : {}) };
  const base = {
    itemId: row.item_id, kind: row.kind, origin, order: Number(row.order), ...(row.run_id ? { runId: row.run_id } : {}), state: row.state,
    ...(Number(row.nested) ? { nested: true } : {}), // B-049 F9: a call inside a code-mode script (agents/rebuild-items.ts never replays it)
  };
  const tool = row.kind === 'tool' || row.kind === 'skill' || row.kind === 'file';
  const condensed = row.state === 'condensed' && row.condensed ? safe(deps, row.condensed) : undefined;
  if (condensed) {
    const stamp = compactStamp(row.item_id, Number(row.tokens), row.pruned_at !== null); // never a way back that is gone
    const text = `${condensed}\n${stamp}`;
    if (tool) {
      const call = callOf(deps, row, false);
      return { ...base, role: 'tool', text, stamp, call: { name: call?.name ?? 'tool', args: call?.args ?? {}, callId: call?.callId ?? '', output: text, ...(call?.own ? { own: true } : {}) } };
    }
    if (row.kind !== 'message') return { ...base, role: 'assistant', text, stamp };
    const message = messageOf(deps, row);
    if (message?.authorId === row.agent_id) return { ...base, role: 'assistant', text, stamp };
    // The person's own line: its text says it is not the person's words (subconscious/context-tools.ts). Anyone
    // else's line (a colleague agent or person, an external contact, the system) keeps its speaker's header.
    const owner = message?.authorId === HUMAN_ID && message.authorKind === 'human';
    return { ...base, role: 'user', text: message && !owner ? `${condensedLine(deps, row, message, condensed)}\n${stamp}` : text, stamp };
  }
  if (tool) {
    const call = callOf(deps, row);
    const output = call?.output ?? safe(deps, row.condensed ?? row.title);
    return { ...base, role: 'tool', text: output, call: { name: call?.name ?? 'tool', args: call?.args ?? {}, callId: call?.callId ?? '', output, ...(call?.own ? { own: true } : {}), ...(call?.ok === false ? { ok: false } : {}) } };
  }
  if (row.kind === 'message') {
    const line = messageLine(deps, row);
    return { ...base, role: line?.own ? 'assistant' : 'user', text: line?.text ?? safe(deps, row.condensed ?? row.title) };
  }
  const original = originalOf(deps, row, VIEW_TEXT_CHARS);
  return { ...base, role: 'assistant', text: original.text };
}

function safe(deps: ViewDeps, text: string): string {
  try { return deps.redact(text); } catch { return text; }
}
