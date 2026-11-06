// A run's answer reaching the chat (B-047 D4), split from chat/service.ts (B-050, to make room there):
// finished in its streaming placeholder (finishAgentMessage) or posted at the end without one
// (postAgentMessage). An answer that is no longer the chat's last message (its run's approvals, status
// lines or posts, or anyone else's line came after it began) moves to the end – a new seq, for final,
// failed and stopped alike –, so it never sits above what led to it. A quiet answer stays quiet unless
// it @mentions the person (the owner or a person of the organisation, a bridged contact) – a colleague
// it mentions is still reached (chat/delivery.ts). B-050 K4: an answer the agent marked [[important]]
// (agents/publishing.ts) carries priority 'important' – delivery's brake still applies to it.
// B-075: a run's row turns from live work into its answer – meta.live goes, meta.ms (how long the run worked) and
// meta.lines (its steps, the newest LINES_MAX) stay, so "Worked 41 s · 6 steps" and its list render from the row on
// every device; a finish that names no level keeps the row's own. A silent row (a run whose answer is kept internal) took
// a quiet seq: posted, it moves to a new one at the end like any post; failed or stopped, nothing was posted – it goes.
// A failed or stopped finish that hands back the stored text (an ended run, agents/dispatch-settle.ts) keeps the newest
// text this PC still held back.
// Owns: those writes and their announcement. Never: decides the answer's visibility or level
// (agents/turn-finish.ts does) or who is woken or notified (chat/delivery.ts).

import { newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { LINES_MAX, type LiveMeta, type LiveStep, type Message, type MessageMeta } from '../../shared/model/chat.ts';
import type { EngineFile } from '../engines/types.ts';
import { publish, removeMessage, type ChatCore } from './lifecycle.ts';
import { isPersonMention } from './mentions.ts';

/** What a run's answer carries (ChatService.finishAgentMessage / postAgentMessage). */
export interface AnswerFinal { body: string; meta?: MessageMeta; files?: EngineFile[]; silent?: boolean; priority?: Message['priority'] }

/** B-047 D4: a quiet agent message stays quiet unless it @mentions a person (the owner, a person of the organisation, a bridged contact). */
export function quietUnlessPerson(silent: boolean | undefined, mentions: readonly string[]): boolean {
  return Boolean(silent) && !mentions.some(isPersonMention);
}

/** Finishes the streaming placeholder `message` (see the header); `mentions`: who its final body @mentions. */
export function finishAgentMessage(core: ChatCore, message: Message, final: AnswerFinal & { state: Message['state'] }, mentions: string[]): Message {
  const quiet = message.state === 'streaming' && message.silent; // a silent row: its seq left the chat's place alone
  if (quiet && final.state !== 'final') { removeMessage(core, message, message.authorId); return message; }
  const ended = core.streams.end(message.id);
  const { live, ...meta } = { ...message.meta, ...(final.meta ?? {}) };
  message.body = final.state !== 'final' && ended && final.body === message.body ? ended.body : final.body;
  message.state = final.state;
  message.meta = live ? { ...meta, ...worked(core.s.clock.now(), live, ended?.steps) } : meta;
  message.mentions = mentions;
  message.silent = quietUnlessPerson(final.silent ?? message.silent, message.mentions);
  message.priority = final.priority ?? message.priority;
  core.s.db.tx(() => {
    if (quiet || core.msgs.postedAfter(message.conversationId, message.id, message.seq)) {
      message.seq = core.convs.nextSeq(message.conversationId, core.s.clock.now());
      core.msgs.moveToSeq(message.id, message.seq);
    }
    core.msgs.update(message);
    core.convs.advanceReadIfCaughtUp(message.conversationId, message.authorId, message.seq);
  });
  publish(core, message, 'message.updated', { deliver: message.state === 'final' && Boolean(message.body.trim()), files: final.files });
  return message;
}

/** B-075: what a finished run's row keeps of its live values – the time it worked and its steps (all of this PC's, else the shown ones). */
export function worked(now: number, live: LiveMeta, steps: LiveStep[] | undefined): Pick<MessageMeta, 'ms' | 'lines'> {
  const lines = (steps?.length ? steps : live.steps).slice(-LINES_MAX);
  return { ms: Math.max(0, now - live.startedAt), ...(lines.length ? { lines } : {}) };
}

/** Posts a run's final answer without a placeholder at the end of the chat; only an active member may. */
export function postAgentMessage(core: ChatCore, conversationId: string, agentId: string, runId: string, final: AnswerFinal, mentions: string[]): Message {
  if (!core.convs.members(conversationId).some(m => m.memberId === agentId && !m.leftAt)) {
    throw new WorkforceError('forbidden', 'Only members can post in this chat.', { details: { conversationId } });
  }
  const now = core.s.clock.now();
  const message: Message = {
    id: newId('msg', now), conversationId, seq: 0, authorId: agentId, authorKind: 'agent', kind: 'text', body: final.body,
    attachments: [], mentions, priority: final.priority ?? 'normal', runId, state: 'final', silent: quietUnlessPerson(final.silent, mentions), meta: final.meta ?? {}, createdAt: now,
  };
  core.s.db.tx(() => {
    message.seq = core.convs.nextSeq(conversationId, now);
    core.msgs.insert(message);
    core.convs.advanceReadIfCaughtUp(conversationId, agentId, message.seq);
  });
  publish(core, message, 'message.created', { deliver: Boolean(message.body.trim()), files: final.files });
  return message;
}
