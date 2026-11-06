// The ledger's marks where no native rebuild applies them: a session-less engine (and a fresh session started from the full
// projection, context/delta.ts) shows its earlier chat lines as marked – a condensed message with its stamp, a hidden one left
// out – and the call that says what was condensed or hidden and how to get it back, under the name of the main AI's own tool `subconscious`
// (agents/rebuild.ts puts the same call into a rebuilt history; q-r1b2, 03.11.2026: named context.hide, a tool the main AI lacks, it went
// looking for that tool and told the person it could remove nothing). A stateless engine holds nothing between
// turns, so it also gets the subconscious's earlier calls again (carriedCalls), as a CLI session holds them, marks applied.
// Owns: applying 'm' marks to a list of messages, that call and those calls. Never: changes a stored message, or fails a turn (no
// ledger or an error = the lines as they are).

import type { RuntimeServices } from '../../contracts.ts';
import type { Message } from '../../../shared/model/chat.ts';
import { NOTE_CALL, type TraceCall } from '../../../shared/model/subconscious.ts';
import { compactStamp, kindOfId, type LedgerItem } from '../../../shared/model/context-ledger.ts';
import '../../contracts/ledger.ts';

const NOTICE_IDS = 40;
/** What a stateless engine's history carries of the subconscious's earlier calls at most, in tokens; the newest stay. */
export const CARRIED_TOKENS = 3000;
/** Calls looked at for that (each may be cut away by the budget, so more than fit). */
const CARRIED_CALLS = 30;
const CHARS_PER_TOKEN = 4;
/** context.restore is no direct tool of a turn: a main AI that looked for the name among its tools did not find it and went digging in the database (live 02.11.2026, q1). */
const RESTORE_CALL = 'tools.call {"name":"context.restore","args":{"ids":[…]}}';

type Mark = Pick<LedgerItem, 'itemId' | 'state'>;

/** The one call naming what is condensed and hidden, by id only (a hidden item's words stay out): "My context, kept small by the subconscious: condensed t17; hidden t9 – get any back with tools.call …" */
export function marksCall(marks: readonly Mark[]): TraceCall | undefined {
  const condensed = marks.filter((mark) => mark.state === 'condensed').map((mark) => mark.itemId);
  const hidden = marks.filter((mark) => mark.state === 'hidden').map((mark) => mark.itemId);
  if (!condensed.length && !hidden.length) return undefined;
  const more = (list: string[], max: number) => (list.length > max ? [...list.slice(0, max), `+${list.length - max} more`] : list);
  const parts = [condensed.length ? `condensed ${more(condensed, NOTICE_IDS).join(', ')}` : '', hidden.length ? `hidden ${more(hidden, NOTICE_IDS).join(', ')}` : ''].filter(Boolean);
  return { tool: NOTE_CALL, args: {}, output: `My context, kept small by the subconscious: ${parts.join('; ')} – get any back with ${RESTORE_CALL}.` };
}

/** The agent's marks in this chat, newest first (a long list keeps the recent ones); `only`: chat lines only. */
export function marksOf(services: RuntimeServices, agentId: string, conversationId: string, only?: 'message'): LedgerItem[] {
  try {
    return (services.ledger?.items(agentId, conversationId) ?? [])
      .filter((item) => item.state !== 'keep' && !item.nested && item.markReason !== 'deleted by its author' && !(item.state === 'hidden' && item.pruned) && (!only || item.kind === only))
      .sort((a, b) => b.order - a.order);
  } catch (error) {
    services.log.debug('ledger marks unreadable', { conversationId, error: String(error) });
    return [];
  }
}

/** `messages` with the ledger's marks applied. */
export function markedMessages(services: RuntimeServices, agentId: string, conversationId: string, messages: readonly Message[]): Message[] {
  if (!messages.length || !services.ledger) return [...messages];
  const marked = new Map<number, LedgerItem>();
  for (const item of marksOf(services, agentId, conversationId, 'message')) {
    if (kindOfId(item.itemId) === 'message' && (item.state === 'hidden' || item.condensed?.trim())) marked.set(Number(item.itemId.slice(1)), item);
  }
  if (!marked.size) return [...messages];
  const out: Message[] = [];
  for (const message of messages) {
    const item = marked.get(message.seq);
    if (!item || message.kind === 'status') { out.push(message); continue; }
    if (item.state === 'condensed') out.push({ ...message, body: `${item.condensed!.trim()}\n${compactStamp(item.itemId, item.tokens, item.pruned)}` });
  }
  return out;
}

/** The subconscious's earlier calls in this chat, as a stateless engine's next history shows them: oldest first, marks applied, without those of `runId`, the newest within CARRIED_TOKENS. */
export function carriedCalls(services: RuntimeServices, agentId: string, conversationId: string, runId: string): TraceCall[] {
  try {
    const entries = services.ledger?.traceView?.(agentId, conversationId, CARRIED_CALLS) ?? [];
    const out: TraceCall[] = [];
    let left = CARRIED_TOKENS * CHARS_PER_TOKEN;
    for (const entry of [...entries].reverse()) {
      if (!entry.call || entry.runId === runId) continue;
      const args = typeof entry.call.args === 'object' && entry.call.args !== null ? entry.call.args as Record<string, unknown> : {};
      left -= entry.call.name.length + JSON.stringify(args).length + entry.call.output.length;
      if (left < 0) break;
      out.unshift({ tool: entry.call.name, args, output: entry.call.output });
    }
    return out;
  } catch (error) {
    services.log.debug('earlier subconscious calls unreadable', { conversationId, error: String(error) });
    return [];
  }
}
