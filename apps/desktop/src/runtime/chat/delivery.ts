// DeliveryService: decides, after a message is committed, which agents get a wake and
// whether the human is notified. Everyone else simply sees the message later through their
// read cursor (context delta) – no paid turn.
// Rules (G6/P3/L6):
//  * members are equal (B-050 K3): in a room of exactly two members a message of any author – the
//    owner, a person, an agent, an external agent, a bridged contact – that is not quiet wakes the
//    other member when that one is an agent (agent ↔ agent too; the loop guard below applies).
//  * 1:1 (one agent member among people): a human message wakes that agent.
//  * group: @mentions wake the mentioned agents; a message without mentions – of any author, B-050 round 4
//    ("kein Unterschied, ob der CEO da dabei ist oder nicht") – goes through the responder pick (chat/responders.ts:
//    one agent for a person's line – B-078 D8 –, up to 2 for an agent's, or nobody when no reply is needed; never the
//    author). Without a decision backend, or when it is
//    unsure, a person's message wakes the lead and an agent's wakes nobody – the one asymmetry, a safety fallback
//    (chat/delivery-route.ts, which does the routing). Reply modes per agent (chat/reply-modes.ts): 'all' agents
//    always hear it, 'mentions'/'events' ones only when @mentioned.
//  * a message that @mentions only people (the owner, a person of the organisation, a bridged
//    contact – chat/mentions.ts isPersonMention) and no agent is addressed to them: it wakes no
//    agent, also no reply-mode 'all' one (K3).
//  * agent-authored messages pass the loop guard (two agents alternating, or a group discussion with many changes of
//    speaker, without a person's line or task progress pause agents' wakes there – chat/loop-guard.ts); they wake the
//    agents they mention, else the pick above – outside a two-member room an important one without any mention
//    addresses the other agent of a two-agent room, else the lead (T10: a chat.send message). A run's final answer marked
//    [[important]] (agents/publishing.ts) is for the person it answers: it is never urgent for an agent.
//  * external messages (chat bridges, R4 package E) are untrusted: they wake agents like a
//    human group message (1:1 / mentions / lead) but pass their own rate guard, never clear the
//    agent loop guard, never push as 'important' and never interrupt a running turn – except a
//    connector the person marked trusted (B-050 K8 e: bridges/external-rpc.ts marks its important
//    messages meta.bridge.trusted): those count as important (steer, notify) under the important brake.
//  * external agents (C8, 'ext:api:' members, bridges/external-agents.ts) talk like agents: their
//    messages wake only mentioned agents (or the other member of a room of two) through the agent
//    loop guard, which in a room with an external agent also counts the agents' own lines (no
//    agent ↔ external agent ping-pong). A
//    message that @mentions an external agent posts 'external.mention' (no engine, no turn); one
//    addressed only to external agents wakes no agent. Its 'member_removed' line revokes its token,
//    a deleted chat every token of the chat (subscribed here, at construction).
//  * priority 'important' additionally asks the dispatcher to steer/interrupt (urgent()) the woken
//    agents; the person's important message also steers every agent already running in that chat
//    (dispatcher.activity) – at once, also while the decision model still picks responders (T10).
//  * a normal message of the person (not one bridged from a messenger) reaches an addressed agent that
//    already works in this chat at its running turn's next step (dispatcher.steer, where the engine
//    can steer – 21.10. 17:09); otherwise the queued wake answers it after that turn. Never interrupts.
//    Lines with files, live/call lines, unsure dictation and lines naming other live chats are never
//    folded (agents/dispatch-steer.ts heldBack): the next turn; plain dictation is folded.
//  * important brake (T10, loop-guard.ts ImportantBrake): more than 5 important messages of one
//    agent in one chat within 10 minutes count as normal (no steering, notified as a reply), with
//    one quiet status line; the owner's own important messages are never braked. F-52: a person of
//    the organisation ('per_…') is braked with the same limits, counted over all their chats together
//    (their important lines steer and cut work of agents the owner shares – also the owner's work in
//    other chats – so spreading them over chats must not lift the limit); they keep the composer's Important level.
//  * a message of the person to an agent whose one task in that chat waits on them (needs_you,
//    or waiting on the human – tasks/transitions.ts humanWaitIn) wakes it for that task, with a
//    note, so the task can continue (T03) – never one the owner wrote in a bridged messenger (C9).
//  * crash safety (C3, F-44): before the decision model is asked, the lead gets a provisional
//    durable wake (key `pick:<chat>`, due in 15 s), so a crash or quit during the decision cannot
//    lose the message. When the decision returns, the picked agents are woken now (`chat:<chat>`)
//    and the provisional wake is withdrawn – unless another decision for that chat and lead is
//    still pending, or the lead already claimed it (then it answers as the fallback).
//  * startup (recover(), after wakes.reconcile()): the newest unanswered human or external message
//    of a chat that no agent has seen, nothing will wake for and no agent turn took up – a turn the
//    person stopped counts as answered (chat/delivery-recovery.ts) – is delivered again, without
//    notifying the person a second time.
//  * B-078: a person's line that is only a recording, while speech to text is ready, waits for its transcript (the
//    'message.updated' that brings it, or about 60 s) and is then delivered once (chat/delivery-dictation.ts).
//  * a quiet (silent) message of any author (B-047 D4, B-050 K4) wakes only the agents it
//    explicitly @mentions (a quiet reply mentions nobody by itself – the replied agent picks it up later,
//    chat/quiet-pickup.ts; the loop guard applies to agent-like
//    authors) and reaches mentioned external agents: no two-member, 1:1, lead, responder or
//    reply-mode wake, never important (no steering), never notifies the person. One that mentions
//    no agent reaches nobody now; a person's quiet lines are picked up, when they are done, by the
//    agents a normal line would address (chat/quiet-pickup.ts, called by the dispatcher) – round 3: a person's
//    quiet line that mentions nobody also tells the dispatcher (quietArrived), so an agent with no turn
//    running picks it up a little later instead of waiting for unrelated work; live run A: so does an agent's
//    quiet answer to the other agent's normal line in a room of two agents (quiet-pickup.ts quietAnswerPeer; round 5:
//    in a larger room to the newest normal line that @mentioned its author) – for that asker only, counted in the loop guard (a paused chat schedules no pickup) – round 4: within
//    seconds once that agent is free (quiet-pickup.ts QUIET_ANSWER_DELAY_MS), a person's quiet line after 2 minutes;
//  * the human is notified only for non-silent messages in chats they are in (an @mention of the
//    person – by profile name or alias, chat/mentions.ts – and priority 'important' notify as
//    'important'); agent-only rooms and rooms an agent hid from the list (chat section 'team')
//    never notify. The notification's title is the chat as the owner sees it (B-050 K2, chat/titles.ts):
//    in a room of two the author's name, with " · topic" when it has one; in a larger room "Author · chat". The chat's level and sound apply
//    centrally in notify/service.ts.
// Owns: those rules (the routing steps are chat/delivery-route.ts, the responder question is chat/responders.ts). Never: writes messages other
// than guard status lines and the brake's demotion (an important line past the brake is stored as
// normal, ChatService.demote – K4: its red badge and its push agree); never wakes for status/task/answer messages (tasks/ownership wake for
// those explicitly – the person's answer line wakes the agent that asked, tasks/answer-receipt.ts; B-076: it resets the
// agent loop guard like the person's text does).

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import '../contracts/people.ts';
import { previewText } from '../../shared/text/chat-names.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';
import type { DeliveryService } from '../contracts.ts';
import { messageLevel, type Member, type Message } from '../../shared/model/chat.ts';
import { announceMentions, mentionedExternalAgents, revokeOnChatRemoval, revokeOnRemoval } from '../bridges/external-agents.ts';
import { unansweredMessages } from './delivery-recovery.ts';
import { DeliveryRouter, type DeliveryDeps, type RouteOptions } from './delivery-route.ts';
import { ImportantBrake, type ImportantBrakeOptions } from './loop-guard.ts';
import { quietAnswerPeer, quietPickupLine } from './quiet-pickup.ts';
import { chatTitleFor } from './titles.ts';
import { DictationWait, type DictationWaitDeps } from './delivery-dictation.ts';

export { chatWakeKey, PROVISIONAL_WAKE_MS, provisionalWakeKey, type DeliveryDeps } from './delivery-route.ts';

/** The important brake's scope for a person of the organisation: all their chats together (agents: per chat). */
const PERSON_BRAKE_SCOPE = 'people';

export class DeliveryServiceImpl implements DeliveryService {
  private readonly s: DeliveryDeps;
  /** Who a text message wakes, the responder pick and the loop guards (chat/delivery-route.ts). */
  private readonly router: DeliveryRouter;
  private readonly brake: ImportantBrake;
  private readonly dictation: DictationWait;

  constructor(deps: DictationWaitDeps, options: RouteOptions & ImportantBrakeOptions & { dictationWaitMs?: number } = {}) {
    this.s = deps;
    this.router = new DeliveryRouter(deps, options);
    this.brake = new ImportantBrake(options);
    this.dictation = new DictationWait(deps, (message) => this.deliver(message, true), options.dictationWaitMs);
    revokeOnChatRemoval(deps); // C8: whether or not an external agent is connected
  }

  onMessage(message: Message): void {
    if (this.dictation.hold(message)) return; // B-078: a bare recording waits for its transcript (chat/delivery-dictation.ts)
    this.deliver(message, true);
  }

  recover(): number {
    const messages = unansweredMessages(this.s);
    let delivered = 0;
    for (const message of messages) {
      try { this.deliver(message, false); delivered++; } catch (error) {
        this.s.log?.warn('redelivery failed', { messageId: message.id, error: String(error) });
      }
    }
    return delivered;
  }

  // ------------------------------------------------------------- internals

  private deliver(message: Message, notify: boolean): void {
    if (message.kind === 'status') {
      // Real task progress breaks agent ping-pong.
      if (message.meta.status?.type.startsWith('task_')) this.router.progress(message.conversationId);
      revokeOnRemoval(this.s, message); // C8: a removed external agent's token
      return;
    }
    if (message.state === 'streaming') return;
    if (message.kind === 'answer' && message.authorKind === 'human') this.router.progress(message.conversationId); // B-076: a person's click is their line – it ends agent ping-pong
    if (notify && quietPickupLine(message)) this.quietArrived(message); // K4 round 3: wakes nobody now (no mention)
    else if (notify && message.silent) this.quietAnswer(message); // a colleague's quiet answer to an agent's question
    if (message.silent && message.kind !== 'text') return;
    const members = this.s.chats.members(message.conversationId);
    const external = mentionedExternalAgents(message, members);
    // K4: a quiet message (any author) wakes only the agents it mentions – one that mentions none reaches nobody (no loop-guard count either).
    if (message.silent && !external.length && !message.mentions.some(id => id !== message.authorId && members.some(m => m.memberId === id && m.kind === 'agent'))) return;
    const important = this.important(message);
    // The durable wake first: a failing notification must never cost the answer. A quiet message
    // (B-047 D4) reaches the agents it mentions but never notifies the person.
    try { this.router.route(message, members, important, external); } finally {
      if (notify) { if (!message.silent) this.notifyHuman(message, members, important); announceMentions(this.s, message, external); }
    }
  }

  /** Whether the message counts as important: never a quiet one (K4) or an untrusted external author's; an agent's, a person's or a trusted connector's past the brake not. */
  private important(message: Message): boolean {
    if (messageLevel(message) !== 'important') return false;
    const external = message.authorKind === 'external';
    if (external && !trustedExternal(message)) return false;
    const person = message.authorKind === 'human' && isPersonId(message.authorId); // F-52: not the owner
    if ((message.authorKind !== 'agent' && !person && !external) || message.kind !== 'text') return true;
    const verdict = this.brake.important(person ? PERSON_BRAKE_SCOPE : message.conversationId, message.authorId, message.createdAt);
    if (verdict === 'braking') this.braked(message);
    if (verdict !== 'ok') this.demote(message); // stored as normal: the red badge agrees with the push it does not get
    return verdict === 'ok';
  }

  /** K4 round 3: a person's quiet line – the chat's agents with no turn running pick it up a little later (dispatcher.quietArrived). */
  private quietArrived(message: Message): void {
    try {
      const agents = this.s.chats.members(message.conversationId).filter(m => m.kind === 'agent' && !m.leftAt).map(m => m.memberId);
      if (agents.length) this.s.dispatcher?.quietArrived?.(agents);
    } catch (error) {
      this.s.log?.warn('quiet pickup on arrival failed', { messageId: message.id, error: String(error) });
    }
  }

  /**
   * Live run A: an agent's quiet answer to the other agent's normal line in a room of two (round 5: to an agent's normal
   * @question in a larger room) – that asker picks it up when free (quietAnswerPeer), through the loop guard; round 4: QUIET_ANSWER_DELAY_MS after it arrived (quiet-pickup.ts), not 2 minutes.
   */
  private quietAnswer(message: Message): void {
    try {
      const peer = quietAnswerPeer(this.s.chats, message);
      if (!peer || !this.router.agentLine(message)) return;
      this.s.dispatcher?.quietArrived?.([peer]);
    } catch (error) {
      this.s.log?.warn('quiet answer pickup failed', { messageId: message.id, error: String(error) });
    }
  }

  /** The first important message over the brake: one quiet line says that they count as normal now. */
  private demote(message: Message): void {
    try { this.s.chats.demote?.(message.id); } catch (error) {
      this.s.log?.warn('demoting a braked important message failed', { messageId: message.id, error: String(error) });
    }
  }

  private braked(message: Message): void {
    const name = isPersonId(message.authorId) ? this.s.people?.nameOf(message.authorId) ?? 'a colleague' : this.s.org?.get(message.authorId)?.name ?? message.authorId;
    this.s.log?.warn('important brake', { conversationId: message.conversationId, authorId: message.authorId });
    try {
      this.s.chats.status(message.conversationId, {
        type: 'note', text: `Important messages from ${name} count as normal for now: more than ${this.brake.max} in ${Math.round(this.brake.windowMs / 60_000)} minutes`,
        details: { guard: 'important', authorId: message.authorId },
      });
    } catch (error) {
      this.s.log?.warn('important brake line failed', { messageId: message.id, error: String(error) });
    }
  }

  private notifyHuman(message: Message, members: Member[], isImportant: boolean): void {
    const notifications = this.s.notifications;
    if (!notifications || message.authorId === HUMAN_ID || message.authorId === SYSTEM_ID) return;
    if (!members.some(m => m.memberId === HUMAN_ID)) return; // agent-only room
    try {
      const chat = this.s.chats.get(message.conversationId);
      if (chat && chatSection({ settings: chat.settings, members }) === 'team') return; // muted under Team activity
      const external = message.authorKind === 'external';
      const important = isImportant || (!external && message.mentions.includes(HUMAN_ID));
      // External ids end with their display label ('ext:tg:<id>:<name> (Telegram)').
      const author = external ? message.authorId.split(':').pop() ?? message.authorId
        : isPersonId(message.authorId) ? this.s.people?.nameOf(message.authorId) ?? 'Colleague' : this.s.org?.get(message.authorId)?.name ?? message.authorId; // F-52
      // K2: the chat as the owner sees it – in a room of two it starts with the author's name ("Tom · Video schneiden"), so it is the title.
      const room = chatTitleFor(this.s, message.conversationId, HUMAN_ID);
      notifications.notify({
        kind: important ? 'important' : 'reply',
        title: members.length > 2 ? (room ? `${author} · ${room}` : author) : (room || author),
        body: previewText(message.body, message.attachments, 160),
        conversationId: message.conversationId,
        taskId: message.taskId,
      });
    } catch (error) {
      this.s.log?.warn('message notification failed', { messageId: message.id, error: String(error) });
    }
  }
}

/** B-050 K8 (e): a connector's message that bridges/external-rpc.ts marked trusted (only a trusted token's important one). */
function trustedExternal(message: Message): boolean {
  return message.authorKind === 'external' && (message.meta.bridge as { trusted?: unknown } | undefined)?.trusted === true;
}
