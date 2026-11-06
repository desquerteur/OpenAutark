// compact(): keeps an agent's active context small in endless chats. Everything except the last ~30 messages the agent
// has seen becomes one written working state (knowledge kind 'observation', scope 'conversation'): the cheap model
// writes it from the earlier state and the new older messages (resources/prompts/compaction.md – goals, decisions,
// facts, constraints, open items, next step); without a model the earlier state plus the newest older lines that fit
// stay as they are. The previous observation is expired through `correct` (bi-temporal history). Returns the seed for
// a new native session: the state + the last ~30 messages.
// Owns: segment selection, the summary input, its size caps and the stored row. Never: deletes chat messages (the
// visible chat is never compacted).

import type { RuntimeServices } from '../contracts.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { StructuredRunner } from '../decision/types.ts';
import { authorName, neutralize, redactText, renderMessages } from './render.ts';
import { markedMessages } from './ledger/marks.ts';
import { renderContext } from './delta.ts';
import { stampText } from './time.ts';
import { COMPACTION_TAG, coveredSeq, latestObservation, observationSource, observationTitle } from './observations.ts';
import type { PromptTemplates } from './templates.ts';

export const KEEP_RECENT = 30;
/** One older message in the summary input is clipped to this many characters. */
const LINE_CHARS = 600;
const SUMMARY_CAP = 6000;
const SUMMARY_INPUT = 24_000;
const PAGE = 500;
const MAX_SEGMENT = 5000;
const LLM_TIMEOUT_MS = 60_000;

/** "#n [time] Name: text" for one older message ('' for an empty one). */
function summaryLine(ctx: ReturnType<typeof renderContext>, message: Message): string {
  const raw = message.kind === 'status' ? message.meta.status?.text ?? message.body : message.kind === 'answer' ? message.meta.answer?.summary ?? message.body : message.body;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const who = authorName({ ...ctx, agentId: '' }, message); // no "(me)": another agent of the chat may read the row
  return `#${message.seq} [${stampText(message.createdAt, ctx.zone, ctx.now)}] ${who}: ${neutralize(text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text)}`;
}

/** The newest lines within `max` characters (oldest first). */
function newestWithin(lines: readonly string[], max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (used + lines[index].length + 1 > max) break;
    used += lines[index].length + 1;
    out.unshift(lines[index]);
  }
  return out;
}

export interface CompactDeps {
  templates: PromptTemplates;
  runner?: () => StructuredRunner | undefined;
}

/** The written state from the earlier one and the new lines; undefined without a model or on any failure. */
async function writtenState(services: RuntimeServices, deps: CompactDeps, previous: string, lines: string[]): Promise<string | undefined> {
  const runner = deps.runner?.();
  if (!runner) return undefined;
  try {
    const prompt = [previous ? `Earlier state:\n${previous}` : '', `Messages (oldest first; #n = message number):\n${newestWithin(lines, SUMMARY_INPUT).join('\n')}`].filter(Boolean).join('\n\n');
    const result = await runner({ purpose: 'compact', system: deps.templates.get('compaction'), prompt: redactText(services, prompt), signal: AbortSignal.timeout(LLM_TIMEOUT_MS) });
    const text = result.text.trim();
    return text ? text.slice(0, SUMMARY_CAP) : undefined;
  } catch (error) {
    services.log.debug('compaction summary failed; the older lines stay as they are', { error: String(error) });
    return undefined;
  }
}

/** Without a model: the earlier state, then the newest older lines that still fit. */
function plainState(previous: string, lines: string[]): string {
  const kept = previous.slice(-Math.floor(SUMMARY_CAP / 2));
  return [kept, ...newestWithin(lines, SUMMARY_CAP - kept.length)].filter(Boolean).join('\n');
}

export async function compactConversation(services: RuntimeServices, deps: CompactDeps, input: { agentId: string; conversationId: string }): Promise<string> {
  const { agentId, conversationId } = input;
  const conversation = services.chats.get(conversationId);
  if (!conversation) return '';
  const member = services.chats.members(conversationId).find((item) => item.memberId === agentId && !item.leftAt);
  // Only what the agent has seen: newer lines arrive through delta() after the rebase.
  const cursor = member ? Math.min(member.readSeq, conversation.lastSeq) : conversation.lastSeq;
  const ctx = renderContext(services, agentId);
  const recent = cursor > 0 ? services.chats.messages(conversationId, { beforeSeq: cursor + 1, limit: KEEP_RECENT }) : [];
  const boundary = recent[0]?.seq ?? cursor + 1; // messages below this seq go into the state

  const previous = latestObservation(services, conversationId, agentId, { ownOnly: true });
  let after = Math.max(coveredSeq(previous), 0);
  const lines: string[] = [];
  let lastSeq = after;
  let seen = 0;
  while (after < boundary - 1 && seen < MAX_SEGMENT) {
    const page = services.chats.messages(conversationId, { afterSeq: after, limit: PAGE }).filter((message) => message.seq < boundary);
    if (!page.length) break;
    lastSeq = page[page.length - 1].seq;
    for (const message of markedMessages(services, agentId, conversationId, page)) { // what the subconscious hid never comes back through the summary
      const line = summaryLine(ctx, message);
      if (line) lines.push(line);
    }
    seen += page.length;
    after = page[page.length - 1].seq;
  }

  let observationBody = previous?.body ?? '';
  if (lines.length) {
    const earlier = previous?.body ?? '';
    observationBody = redactText(services, (await writtenState(services, deps, earlier, lines)) ?? plainState(earlier, lines));
    const title = observationTitle(lastSeq);
    let stored = false;
    if (previous) {
      try { services.knowledge.correct(previous.id, { title, body: observationBody }, agentId); stored = true; } catch (error) {
        services.log.debug('observation correct failed; saving a new one', { error: String(error) });
      }
    }
    if (!stored) {
      services.knowledge.save({
        scope: 'conversation', scopeId: conversationId, kind: 'observation', title, body: observationBody, createdBy: agentId,
        source: observationSource(conversationId), confidence: 0.8, tags: [COMPACTION_TAG],
      });
    }
  }

  const parts: string[] = [];
  if (observationBody) parts.push(`Context summary (generated by the runtime from older messages of this chat; not a user message):\n${observationBody}`);
  const rendered = renderMessages(ctx, markedMessages(services, agentId, conversationId, recent), { images: false }).lines;
  if (rendered.length) parts.push(`Recent messages:\n${rendered.join('\n')}`);
  return redactText(services, parts.join('\n\n'));
}
