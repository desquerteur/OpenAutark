// Who answers an agent's chat line, and when (B-050 group cost; live scenario 4: a manager read its work group five
// times in one turn waiting for its colleague, 282k input tokens). The colleagues delivery wakes for the line
// (chat/delivery.ts: the mentioned agents, in a room of two the other one) answer once the sender's turn has ended
// (agents/dispatch-groups.ts waitsFor holds a line of a running turn – an important one excepted), and a reply that
// reaches the sender wakes it as a new turn: nothing of it can reach the running turn, so reading the chat again
// there only costs tokens.
//  - chat.send: the result names the colleagues the line woke and says to end the turn – or, where other agents are
//    members, that it woke none (an agent's line reaches the agents it @mentions; in a room of two the other one) –
//    B-050 round 4: in a larger room with a decision model a normal line that @mentions nobody goes to the responder
//    pick (chat/delivery-route.ts), which answers after this note: then it says that a pick decides.
//  - chat.read: a read of the newest lines (not paging back, not one seq) that finds nothing from others after the
//    agent's own line of this run says so, with the same advice – only while a colleague is woken there.
//  - B-050 Nachtrag Runde 5 (live F: 6 of 11 colleague turns were woken by quiet lines with an @mention, e.g. "@Mira
//    agreed, thanks" as a closing note): every chat.send note adds that an @mention wakes that colleague even in a quiet
//    line or a [[silent]] note, so a closing note names nobody with @ (K4 – a quiet line wakes only explicit @mentions –
//    is unchanged).
// Owns: those notes and who counts as woken (an active agent member with a wake for that chat).
// Never: wakes or holds anyone, or speaks of a colleague's reply when none was woken (a person's normal line may be
// steered into the running turn, dispatcher.steer).

import type { Message } from '../../../shared/model/chat.ts';
import type { ToolContext } from '../types.ts';
import { authorName } from './util.ts';

// B-075 (owner 04.11.2026, first-person voice): the notes speak as the agent that reads them ("my closing note", as
// publishing.ts CLOSING_NO_MENTION).
const END_TURN = 'I end this turn now instead of waiting or reading the chat again: nothing of it reaches this turn.';
const REPLY = 'a reply comes to me as a new turn (in a group: one that @mentions me or is picked for me; in a chat of two a quiet one too, once I am free)';
/** Round 5: a closing note names nobody with @ (live F: such @mentions woke colleagues for nothing). */
const CLOSING = 'An @mention wakes that colleague even in a quiet line (level "silent") or a [[silent]] note, so my closing note names nobody with @.';

/** The chat's active agent members besides the caller. */
function colleagues(ctx: ToolContext, chatId: string): string[] {
  return ctx.services.chats.members(chatId)
    .filter((member) => member.kind === 'agent' && !member.leftAt && member.memberId !== ctx.agent.id)
    .map((member) => member.memberId);
}

/** Of `ids`, the ones with a wake for this chat (waiting, or the turn running there now): they answer there. */
function woken(ctx: ToolContext, chatId: string, ids: string[]): string[] {
  return ids.filter((id) => ctx.services.wakes.list(id).some((wake) => wake.conversationId === chatId));
}

/** Round 4: a normal line that @mentions nobody in a room of three or more goes to the responder pick when a decision model is there. */
function picked(ctx: ToolContext, chatId: string, message: Pick<Message, 'priority'> & Partial<Pick<Message, 'silent' | 'mentions'>>): boolean {
  if (message.silent || message.priority === 'important' || message.mentions?.length || !ctx.services.decisions?.available()) return false;
  return ctx.services.chats.members(chatId).filter((member) => !member.leftAt).length > 2;
}

/** "Mira", "Mira and Tom", "Mira, Tom and Ada". */
function nameList(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** chat.send: whom the line woke and what that means for this turn; undefined in a chat without other agents. */
export function sendNote(ctx: ToolContext, chatId: string, message: Pick<Message, 'priority'> & Partial<Pick<Message, 'silent' | 'mentions'>>): { woken: string[]; note: string } | undefined {
  const others = colleagues(ctx, chatId);
  if (!others.length) return undefined;
  const names = woken(ctx, chatId, others).map((id) => authorName(ctx, id));
  if (!names.length && picked(ctx, chatId, message)) return { woken: [], note: `No colleague is woken yet: a pick decides who should answer this line, or that nobody needs to – ${REPLY}. ${CLOSING} I @mention a colleague whose answer I need.` };
  if (!names.length) return { woken: [], note: `No colleague is woken by this line: an agent's line reaches the agents it @mentions (in a chat of two, the other one unless it is quiet). ${CLOSING}` };
  const when = message.priority === 'important' ? '' : ' after this turn of mine';
  return { woken: names, note: `${nameList(names)} ${names.length > 1 ? 'answer' : 'answers'}${when}; ${REPLY}. ${END_TURN} ${CLOSING}` };
}

/**
 * chat.read of the newest lines: when the agent posted in this chat during this run and nothing from others came
 * after its last such line while a colleague is woken there, the hint to end the turn; else undefined.
 */
export function readHint(ctx: ToolContext, chatId: string): string | undefined {
  if (!ctx.runId) return undefined;
  const recent = ctx.services.chats.messages(chatId, { limit: 50 });
  // Its chat.send lines of this run – not the run's own streaming answer, which is no line yet.
  const own = recent.filter((message) => message.authorId === ctx.agent.id && message.runId === ctx.runId && message.kind === 'text' && message.state !== 'streaming').at(-1);
  if (!own) return undefined;
  if (recent.some((message) => message.seq > own.seq && message.authorId !== ctx.agent.id && message.kind !== 'status' && message.state !== 'streaming')) return undefined;
  const names = woken(ctx, chatId, colleagues(ctx, chatId)).map((id) => authorName(ctx, id));
  if (!names.length) return undefined;
  return `Nothing new since my #${own.seq} of this turn. ${nameList(names)} ${names.length > 1 ? 'answer' : 'answers'} after this turn of mine; ${REPLY}. ${END_TURN}`;
}
