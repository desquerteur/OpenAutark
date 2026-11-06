// delta(): the chat lines an agent has not seen yet, read straight from the canonical message
// store (no intermediate buffer). Up to 60 new lines (the newest when there are more, with a
// pointer to chat.read for the rest); the agent's own messages are skipped unless `full` or
// `includeOwn`. `full` (new native session / stateless start) adds the stored observation
// summary and the last ~30 earlier lines, under short headers that separate old from new
// (projection.ts, which also finds where that history ends in a turn input; a summary line equal
// to a header is escaped like a body line in render.ts).
// `includeOwn` (catch-up of a resumed session that missed turns in another session, e.g. on
// another engine) keeps the agent's own replies, marked with the model that wrote them, except
// `knownSeqs` (lines this session wrote itself). The agent's own streaming draft never shows, nor a colleague's silent
// live row (a background run: it holds no text).
// D15: what the agent's live voice said in a call (its own call lines a realtime session or the talker wrote,
// render.ts liveVoiceLine) always shows – "(my live voice said: …)", the newest MAX_VOICE_LINES – so the
// agent knows what the person was told and promised.
// The earlier lines follow the context ledger's marks (ledger/marks.ts: condensed with the stamp, hidden left out).
// B-058 G10: only the new lines carry image inputs (at most 8, render.ts); the earlier lines of a full projection
// never attach theirs again – a stateless engine sees an image in the turn it arrives, a new session not at all –
// and their image line says "not attached here; media.view shows it" (decision: one tool call when the agent needs
// the image again instead of every turn re-sending earlier images; turn-prepare.ts normalizes those sent).
// Owns: windowing, the total size budget and lastSeq (never past a colleague's message that is
// still streaming – a silent live row of a background run aside, whose answer comes at the end – or one whose
// attachment text is still being extracted).
// Never: advances any cursor itself.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Message } from '../../shared/model/chat.ts';
import { displayZone } from './time.ts';
import { humanLabel, liveVoiceLine, renderMessages, type RenderContext } from './render.ts';
import type { AttachmentTexts } from './attachments.ts';
import { latestObservation } from './observations.ts';
import { PROJECTION, quoteHeaders } from './projection.ts';
import { markedMessages } from './ledger/marks.ts';

export const DELTA_LIMIT = 60;
export const BACKFILL_LIMIT = 30;
/** D15: at most this many of the agent's own live-voice lines in one delta (the newest). */
export const MAX_VOICE_LINES = 12;
const TOTAL_CHARS = 48_000;
const CATCH_UP_NOTE = '(This session missed the lines below; my own replies among them were written in another session.)';

export interface DeltaResult {
  text: string;
  images: Array<{ path: string; mime: string }>;
  lastSeq: number;
}

export function renderContext(services: RuntimeServices, agentId: string): RenderContext {
  let zone: string | undefined;
  try { zone = services.settings.get().profile.timezone; } catch { zone = undefined; }
  return { services, agentId, humanName: humanLabel(services), zone: displayZone(zone), now: services.clock.now() };
}

/** Keeps the newest lines within the character budget; says how many were left out. */
function budget(lines: string[], max: number): string[] {
  let used = 0;
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    used += lines[index].length + 1;
    if (used > max && kept.length) {
      kept.unshift(`(${index + 1} older line${index === 0 ? '' : 's'} left out for space; chat.read has them)`);
      break;
    }
    kept.unshift(lines[index]);
  }
  return kept;
}

export interface DeltaInput {
  agent: Agent;
  conversationId: string;
  sinceSeq: number;
  full: boolean;
  /** Also show the agent's own messages (catch-up of a session that missed other sessions' turns). */
  includeOwn?: boolean;
  /** Seqs of own messages the native session already holds (skipped even with includeOwn). */
  knownSeqs?: number[];
}

/** An own reply from another session: the agent's earlier reply, with the model that wrote it. */
function earlierReply(message: Message): Message {
  const model = typeof message.meta.model === 'string' ? message.meta.model.trim() : '';
  return model && message.kind === 'text' ? { ...message, body: `(via ${model}) ${message.body}` } : message;
}

export function buildDelta(services: RuntimeServices, texts: AttachmentTexts, input: DeltaInput): DeltaResult {
  const { agent, conversationId, sinceSeq, full } = input;
  const ctx = renderContext(services, agent.id);
  const newest = services.chats.messages(conversationId, { limit: DELTA_LIMIT });
  const fresh = newest.filter((message) => message.seq > sinceSeq);
  let lastSeq = sinceSeq;
  for (const message of fresh) lastSeq = Math.max(lastSeq, message.seq);
  // A colleague's message that is still streaming is shown as it stands, but the cursor stops
  // before it: otherwise its final text would never reach this agent (its seq is already read).
  // A silent one (a background run's live row) holds no text: posted, its answer takes a new seq at the end.
  const streaming = fresh.find((message) => message.state === 'streaming' && message.authorId !== agent.id && !message.silent);
  if (streaming) lastSeq = Math.min(lastSeq, streaming.seq - 1);

  // More unseen lines than the window: say so instead of silently dropping them.
  let skippedNote: string | undefined;
  if (fresh.length === DELTA_LIMIT && fresh.length === newest.length) {
    const first = services.chats.messages(conversationId, { afterSeq: sinceSeq, limit: 1 })[0];
    if (first && first.seq < fresh[0].seq) {
      skippedNote = `(Older unseen messages #${first.seq}–#${fresh[0].seq - 1} are not shown; if they matter, I read them with chat.read.)`;
    }
  }

  const own = (message: Message) => message.authorId === agent.id;
  const known = new Set(input.knownSeqs ?? []);
  // The agent's own message that is still streaming is this run's draft, and a silent live row only says that someone
  // works in the background – neither is context.
  const settled = fresh.filter((message) => !(message.state === 'streaming' && (own(message) || message.silent)));
  // D15: the own lines the agent's live voice said in a call (the newest few) – what the person was told.
  const voiced = new Set(settled.filter((message) => own(message) && liveVoiceLine(message)).slice(-MAX_VOICE_LINES));
  const visible = full ? settled
    : input.includeOwn ? settled.filter((message) => !own(message) || !known.has(message.seq)).map((message) => (own(message) && !liveVoiceLine(message) ? earlierReply(message) : message))
      : settled.filter((message) => !own(message) || voiced.has(message));
  const freshLines = renderMessages(ctx, visible, { texts, images: true });
  // Same for a message whose attached file text is still being extracted: the next delta
  // shows it again with the text (a native session would otherwise never receive it).
  if (freshLines.pendingSeq !== undefined) lastSeq = Math.min(lastSeq, freshLines.pendingSeq - 1);
  const newLines = skippedNote ? [skippedNote, ...freshLines.lines] : freshLines.lines;

  if (!full) {
    const lines = budget(newLines, TOTAL_CHARS);
    if (input.includeOwn && visible.some((message) => own(message) && message.kind !== 'status' && !voiced.has(message))) lines.unshift(CATCH_UP_NOTE);
    return { text: lines.join('\n'), images: freshLines.images, lastSeq };
  }

  const firstFresh = fresh[0]?.seq ?? sinceSeq + 1;
  const earlier: Message[] = sinceSeq > 0 || firstFresh > 1
    ? services.chats.messages(conversationId, { beforeSeq: Math.min(sinceSeq + 1, firstFresh), limit: BACKFILL_LIMIT })
    : [];
  const observation = latestObservation(services, conversationId, agent.id);
  const earlierLines = renderMessages(ctx, markedMessages(services, agent.id, conversationId, earlier), { texts, images: false }).lines;
  if (!observation && !earlierLines.length) {
    return { text: budget(newLines, TOTAL_CHARS).join('\n'), images: freshLines.images, lastSeq };
  }

  // New lines get most of the budget; the summary is already size-capped by compaction.
  const parts: string[] = [];
  const summary = observation ? `${PROJECTION.summary}\n${quoteHeaders(observation.body)}` : '';
  const newText = newLines.length ? `${PROJECTION.fresh}\n${budget(newLines, TOTAL_CHARS * 0.6).join('\n')}` : '';
  const earlierBudget = Math.max(4000, TOTAL_CHARS - summary.length - newText.length);
  if (summary) parts.push(summary);
  if (earlierLines.length) parts.push(`${PROJECTION.earlier}\n${budget(earlierLines, earlierBudget).join('\n')}`);
  if (newText) parts.push(newText);
  return { text: parts.join('\n\n'), images: freshLines.images, lastSeq };
}

/** Attachments of the new lines delta() would render – the same newest-60 window (for AttachmentTexts.prepare). */
export function unseenAttachments(services: RuntimeServices, input: { agentId: string; conversationId: string; sinceSeq: number }): Message['attachments'] {
  return services.chats.messages(input.conversationId, { limit: DELTA_LIMIT })
    .filter((message) => message.seq > input.sinceSeq && message.authorId !== input.agentId)
    .flatMap((message) => message.attachments);
}
