// Publishing a turn's final text (B-047 D4): the chat is not the agent – the run journal keeps
// everything, the chat gets what the agent publishes.
// - Tags in the final text (any engine, plain text, stripped before posting): `[[internal]]` keeps
//   it in the run journal only, `[[silent]]` (alias `[[quiet]]`) posts it without unread or
//   notification, `[[notify]]` posts it and notifies. Several tags: the most private one wins.
//   B-050 K4: `[[important]]` is a flag beside them – posted, notifies and marked important (push, red);
//   a more private tag (silent/internal) wins and drops it. The publishing line offers it for what the person
//   would surely want a push for now – a blocker, a decisive result, big news (round 3, the owner's test); B-072 (live
//   03.11.2026: a public push reported as a silent closing note): a step others now see that the agent took on its own.
// - Without a tag: a turn a person waits for (awaited: a new line from the owner, a person or a
//   bridged contact that is not quiet – never an external agent's; B-050 K4: a quiet line expects no
//   answer, so a quiet pickup 'review' turn stays internal and a quiet @mention posts quietly –, a
//   wake by answer/approval/manual/setup/report)
//   and a background turn the person must see (it asks them something, blocked the task or handed
//   it to them, works on an urgent task, or @mentions them) post and notify; B-050 K3: a message turn
//   in a room of two whose other member is an agent or an external agent posts at normal level, so the
//   answer reaches that member (chat/delivery.ts; the loop guard caps the back-and-forth, [[silent]] is
//   the closing note – it wakes nobody, the other agent picks it up when free, chat/quiet-pickup.ts); any other agent-to-agent
//   message turn, or one that @mentions a colleague, posts quietly; every other background turn
//   (retry/review/schedule/child/task/handoff) keeps its text internal.
//   B-050 Nachtrag Runde 5 (live F: 6 of 11 colleague turns were woken by quiet lines with an @mention, 4 of them
//   produced nothing): where colleagues are in the chat, the publishing line says that an @mention wakes that
//   colleague even in a [[silent]] note, so a closing note names nobody with @ (K4 itself is unchanged).
// - Safety net: on an awaited turn `[[internal]]` without any other text post of the run in that
//   chat becomes `[[silent]]` (a person who asked never gets nothing); engine files are never kept
//   internal (the journal cannot hold them) – they post quietly.
// - B-059 #42 (live B-052: answers to the owner's questions arrived silent – no push, no unread): in the person's 1:1
//   with the agent (personPair: a room of two with a person) an awaited turn that changed nothing (`changed` false:
//   no tool that changes something ran, turn-progress effectful) – a plain answer – posts `[[silent]]` with a
//   notification; `[[silent]]` stays the quiet closing note after work was done (B-050 round 3), a report wake's
//   "nothing left to tell" stays quiet (org/reports.ts), a run that already posted text there is not pushed twice, and
//   `[[internal]]` and group chats are unchanged.
// - A final text without words (a tag alone) posts and journals nothing, whatever its tag (org/reports.ts
//   relies on it). B-050 round 3: so a request done with nothing to discuss is not left without a trace, the
//   rules and the notifying publishLine ask for a short `[[silent]]` closing note instead – it stays in the
//   chat's history without unread or notification; `[[internal]]` stays log only.
// - Call turns ignore tags: the answer is spoken and posted.
// - Each turn's context names in one line where its final text goes (publishLine).
// - B-054: a run in no chat (a mail, a chat-free task, a connector event) keeps its final text with the run (shown on
//   the agent's page); its line names the ways out – tasks.create for later or a colleague, human.ask for what only
//   the person can do or decide, chat.send {to} to tell someone, nothing more for information – and that ask blocks
//   in it are shown nowhere (P8). An awaited wake (AWAITED_REASONS: the person acted on the run) adds that the
//   person may want the outcome told with chat.send {to:"human"}.
// - The final text is journaled as run item(s) kind 'note', name 'Answer', data {answer: true,
//   text, visibility, messageId?} – redacted, split into parts of ≤ ANSWER_PART_CHARS (data.part /
//   data.parts from 2 parts on, at most ANSWER_MAX_PARTS) within the journal's limits.
// - B-075 (owner 04.11.2026, first-person voice): the lines speak as the agent ("My final text …", "I end it with …");
//   the tags, cases and examples are unchanged. ON_YOUR_OWN names no person ("taken without the person"): chat.send's
//   description embeds it too, so it reads right in either voice.
// Owns: these rules. Never: posts or removes messages (agents/turn-finish.ts with ChatService does),
// decides who is woken or notified for a posted message (chat/delivery.ts).

import { HUMAN_ID } from '../../shared/ids.ts';
import type { AnswerVisibility, Member, Message } from '../../shared/model/chat.ts';
import type { WakeReason } from '../../shared/model/runs.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { externalAgentName, isExternalAgent } from '../../shared/model/external-agents.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/people.ts';
import type { TurnPlan } from './turn-types.ts';

const TAGS = /\[\[\s*(internal|silent|quiet|notify|important)\s*\]\]/gi;
const PRIVACY: Record<AnswerVisibility, number> = { notify: 0, silent: 1, internal: 2 };

export const ANSWER_ITEM = 'Answer';
export const ANSWER_PART_CHARS = 4000;
export const ANSWER_MAX_PARTS = 8;

/** Wakes a person caused or waits for (the person's answer or decision, a manual run, the setup, a manager's report). */
export const AWAITED_REASONS: ReadonlySet<WakeReason> = new Set<WakeReason>(['answer', 'approval', 'manual', 'setup', 'report']);

/**
 * Strips every publishing tag; `tag` is the most private one found. `important` (B-050 K4): [[important]]
 * without a more private tag – it counts as [[notify]] plus priority important; silent/internal drop it.
 */
export function parseVisibility(text: string): { body: string; tag?: AnswerVisibility; important?: true } {
  const seen: { tag?: AnswerVisibility; important?: boolean } = {};
  const body = text.replace(TAGS, (_match, word: string) => {
    const lower = word.toLowerCase();
    if (lower === 'important') seen.important = true;
    const found: AnswerVisibility = lower === 'quiet' ? 'silent' : lower === 'important' ? 'notify' : (lower as AnswerVisibility);
    if (!seen.tag || PRIVACY[found] > PRIVACY[seen.tag]) seen.tag = found;
    return '';
  });
  const { tag } = seen;
  return { body: tag ? body.trim() : text.trim(), ...(tag ? { tag } : {}), ...(seen.important && tag === 'notify' ? { important: true as const } : {}) };
}

/**
 * A line of a person (the owner, a person of the organisation, a bridged contact): their text or
 * answer receipt – never the agent's own, a status line, a task anchor (the task's own wakes run in
 * the background) or an external agent's (C8).
 */
export function fromPerson(message: Pick<Message, 'authorId' | 'authorKind' | 'kind'>, agentId: string): boolean {
  return message.authorId !== agentId && (message.kind === 'text' || message.kind === 'answer')
    && (message.authorKind === 'human' || (message.authorKind === 'external' && !isExternalAgent(message.authorId)));
}

/** A person's line that expects an answer: not a quiet one (B-050 K4 – the agent acts on it only when useful), unless it was said in a call (stored quiet for the talker, calls/talker.ts). */
export function awaitsAnswer(message: Pick<Message, 'authorId' | 'authorKind' | 'kind' | 'silent'> & { meta?: Pick<Message['meta'], 'call'> }, agentId: string): boolean {
  return fromPerson(message, agentId) && (!message.silent || message.meta?.call != null);
}

/** Who waits for this turn's answer: the author of the newest person's line that is not quiet, else the owner for an awaited wake or a call. */
export function waitingFor(reason: WakeReason, callId: string | undefined, unseen: readonly Pick<Message, 'authorId' | 'authorKind' | 'kind' | 'silent'>[], agentId: string): string | undefined {
  const line = unseen.filter((message) => awaitsAnswer(message, agentId)).at(-1);
  if (line) return line.authorId;
  return callId || AWAITED_REASONS.has(reason) ? HUMAN_ID : undefined;
}

type MustSeeTask = Pick<TaskView, 'steps'> & Partial<Pick<TaskView, 'priority' | 'status'>>;

/**
 * Background turns the person must see: the turn asks them something (an ask block, a mini-app
 * to-do, human.ask – `asks`) or @mentions them, the task is urgent, blocked or waits on them, or
 * it got a new open human step.
 */
export function mustSee(input: { before?: MustSeeTask; after?: MustSeeTask; asks: boolean; mentionsPerson?: boolean }): boolean {
  if (input.asks || input.mentionsPerson) return true;
  const task = input.after ?? input.before;
  if (!task) return false;
  if (task.priority === 2) return true; // urgent work is never quiet
  if (input.after?.status === 'blocked' || input.after?.status === 'needs_you') return true;
  const openHuman = (item?: Pick<TaskView, 'steps'>) => (item?.steps ?? []).filter((step) => step.assigneeKind === 'human' && step.status !== 'done' && step.status !== 'cancelled').length;
  return openHuman(input.after) > openHuman(input.before);
}

export interface VisibilityInput {
  tag?: AnswerVisibility;
  awaited: boolean;
  call?: boolean;
  mustSee: boolean;
  /** The text @mentions a colleague (an agent member): it posts at least quietly. */
  addressed?: boolean;
  /** The chat is a room of two whose other member is an agent or an external agent (pairPeer). */
  pairAgent?: boolean;
  reason: WakeReason;
  /** Whether the run posted another text message into the chat (the safety net asks only when needed). */
  postedElse?: () => boolean;
  /** B-059 #42: the chat is the person's 1:1 with the agent (personPair). */
  personPair?: boolean;
  /** B-059 #42: a tool that changes something ran (turn-progress effectful); undefined: not known (no upgrade). */
  changed?: boolean;
}

/** The default without a tag: posted + notifies, posted quietly, or internal (see the header). */
export function defaultVisibility(input: Omit<VisibilityInput, 'tag' | 'postedElse'>): AnswerVisibility {
  if (input.call || input.awaited || input.mustSee) return 'notify';
  if (input.reason === 'message' && input.pairAgent) return 'notify'; // K3: the answer reaches the other member
  if (input.reason === 'message' || input.addressed) return 'silent';
  return 'internal';
}

/** The other member of a room of exactly two (active members) when it is an agent or an external agent – K3: it is addressed. */
export function pairPeer(members: readonly Pick<Member, 'memberId' | 'kind' | 'leftAt'>[], agentId: string): string | undefined {
  const active = members.filter((member) => !member.leftAt);
  if (active.length !== 2 || !active.some((member) => member.memberId === agentId)) return undefined;
  const other = active.find((member) => member.memberId !== agentId);
  return other && (other.kind === 'agent' || isExternalAgent(other.memberId)) ? other.memberId : undefined;
}

/** B-059 #42: a room of exactly two (active members) whose other member is a person (the owner or a person of the organisation) – their 1:1. */
export function personPair(members: readonly Pick<Member, 'memberId' | 'kind' | 'leftAt'>[], agentId: string): boolean {
  const active = members.filter((member) => !member.leftAt);
  return active.length === 2 && active.some((member) => member.memberId === agentId) && active.some((member) => member.memberId !== agentId && member.kind === 'human');
}

/** Where the final text goes: calls always post, an explicit tag wins (safety nets on awaited turns), else the default. */
export function resolveVisibility(input: VisibilityInput): AnswerVisibility {
  if (input.call) return 'notify';
  if (!input.tag) return defaultVisibility(input);
  if (input.tag === 'internal' && input.awaited && !(input.postedElse?.() ?? false)) return 'silent';
  // B-059 #42: a plain answer in the person's 1:1 is never quiet (see the header).
  if (input.tag === 'silent' && input.awaited && input.personPair && input.changed === false && input.reason !== 'report' && !(input.postedElse?.() ?? false)) return 'notify';
  return input.tag;
}

/** B-054: the publishing line of a run that posts in no chat (see the header). */
export const NO_CHAT_LINE = 'This run posts in no chat: my final text stays with this run (shown on my page). Work for later or for a colleague: tasks.create. '
  + 'Something only the person can do or decide: human.ask. To tell someone: chat.send {to}. Information only: nothing more. Ask blocks in this final text are shown nowhere.';
/** B-054: added for an awaited wake in no chat (the person acted on this run). */
export const ACTED_LINE = 'The person acted on this run – when the outcome matters to them, I tell them with chat.send {to:"human"}.';

/** B-072: the [[important]] example for what went out without the person (see the header); chat.send's level says it too. */
export const ON_YOUR_OWN = 'a step others now see, taken without the person – posted, sent, pushed, published, paid';

/** Round 5: the publishing line's last sentence in a chat with colleagues (K4: a quiet line wakes the agents it @mentions). */
export const CLOSING_NO_MENTION = 'An @mention wakes that colleague even in a [[silent]] note, so my closing note names nobody with @.';

/**
 * The one line of the turn's context that says where its final text goes; `peer`: the agent of a room of two that no person
 * waits in; `colleagues`: other agents are members (then CLOSING_NO_MENTION follows).
 */
export function publishLine(input: { visibility: AnswerVisibility; call: boolean; inChat: boolean; who?: string; owner: string; peer?: string; colleagues?: boolean; awaited?: boolean }): string {
  if (!input.inChat) return input.awaited ? `${NO_CHAT_LINE} ${ACTED_LINE}` : NO_CHAT_LINE;
  if (input.call) return 'My final text is spoken in the call and posted here.';
  const closing = input.peer || input.colleagues ? ` ${CLOSING_NO_MENTION}` : '';
  if (input.visibility === 'notify' && input.peer && !input.who) return `My final text: posted here and reaches ${input.peer} (it wakes them). I end it with [[silent]] when I need nothing more from them (a closing note they read when free), or [[internal]] to keep it in my run log.${closing}`;
  if (input.visibility === 'notify') return `My final text: posted here and notifies ${input.who ?? input.owner}. I end it with [[silent]] to post it without a notification (a closing note nobody waits on, not my answer to what they wrote), [[internal]] to keep it in my run log, or [[important]] when they would surely want a push now (a blocker, a decisive result, big news, ${ON_YOUR_OWN}).${closing}`;
  if (input.visibility === 'silent') return `My final text: posted here quietly (no notification). I end it with [[notify]] when ${input.owner} needs to know ([[important]] when they would surely want a push now, as for ${ON_YOUR_OWN}), or [[internal]] to keep it in my run log.${closing}`;
  return `My final text stays in my run log unless I tag it: [[silent]] posts it here quietly, [[notify]] posts it and notifies ${input.owner}. [[important]] also pushes it to them at once (what they would surely want now, as ${ON_YOUR_OWN}).${closing}`;
}

/** publishLine for a planned turn: whether it can post (a chat it is a member of), who waits, the owner's name, the agent of a room of two, colleagues there. */
export function publishNote(services: Pick<RuntimeServices, 'chats' | 'settings'> & Partial<Pick<RuntimeServices, 'people' | 'org'>>, plan: Pick<TurnPlan, 'agent' | 'conversationId' | 'callId' | 'publish' | 'waitingFor'> & Partial<Pick<TurnPlan, 'awaited'>>): string {
  let members: Member[] = [];
  try { members = plan.conversationId ? services.chats.members(plan.conversationId) : []; } catch { /* no chat: run log only */ }
  const inChat = members.some((member) => member.memberId === plan.agent.id && !member.leftAt);
  const owner = personName(services, HUMAN_ID) ?? 'the person';
  const peer = pairPeer(members, plan.agent.id);
  const peerName = peer ? (isExternalAgent(peer) ? externalAgentName(peer) : services.org?.get(peer)?.name ?? 'the other agent') : undefined;
  const colleagues = members.some((member) => member.kind === 'agent' && !member.leftAt && member.memberId !== plan.agent.id);
  return publishLine({ visibility: plan.publish ?? 'notify', call: Boolean(plan.callId), inChat, who: personName(services, plan.waitingFor), owner, ...(peerName ? { peer: peerName } : {}), ...(colleagues ? { colleagues } : {}), ...(plan.awaited ? { awaited: true } : {}) });
}

/** The final text as run item(s) 'Answer' (redacted, split within the journal's limits); never fails the turn. */
export function journalAnswer(services: Pick<RuntimeServices, 'runs' | 'secrets' | 'log'>, runId: string, text: string, visibility: AnswerVisibility, messageId?: string): void {
  if (!text.trim()) return;
  let clean = text;
  try { clean = services.secrets.redact(text); } catch { /* the chat holds the same text; the journal is local */ }
  const parts = splitAnswer(clean);
  try {
    parts.forEach((part, index) => services.runs.item(runId, {
      kind: 'note', name: ANSWER_ITEM, effectStatus: 'none',
      data: { answer: true, text: part, visibility, ...(messageId ? { messageId } : {}), ...(parts.length > 1 ? { part: index + 1, parts: parts.length } : {}) },
    }));
  } catch (error) {
    services.log?.warn('journaling the final answer failed', { runId, error: String(error) });
  }
}

/** Parts of at most ANSWER_PART_CHARS, at most ANSWER_MAX_PARTS (the last one says how much was left out). */
export function splitAnswer(text: string): string[] {
  const parts: string[] = [];
  for (let at = 0; at < text.length && parts.length < ANSWER_MAX_PARTS; at += ANSWER_PART_CHARS) parts.push(text.slice(at, at + ANSWER_PART_CHARS));
  const left = text.length - ANSWER_PART_CHARS * ANSWER_MAX_PARTS;
  if (left > 0) {
    const note = `… [${left} more chars]`;
    parts[parts.length - 1] = `${parts[parts.length - 1].slice(0, ANSWER_PART_CHARS - note.length)}${note}`;
  }
  return parts;
}

/** A name for the person in the publishing line: the owner's profile name, a person's name, a bridged contact's label. */
export function personName(services: Pick<RuntimeServices, 'settings'> & Partial<Pick<RuntimeServices, 'people'>>, id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (id === HUMAN_ID) {
    try { return services.settings.get().profile?.name?.trim() || 'the person'; } catch { return 'the person'; }
  }
  if (isPersonId(id)) return services.people?.nameOf(id) ?? 'my colleague';
  if (id.startsWith('ext:')) return id.split(':').pop() || 'the contact';
  return undefined;
}
