// Routing of a committed text message for chat/delivery.ts (split out of it in B-050 round 4; the rules are in its
// header): which agents it wakes, steers or reaches in their running turn, the responder pick with the lead's
// crash-safe provisional wake, the loop guards and the hand-over of a paused chat to its lead.
// Round 4 (owner: "kein Unterschied, ob der CEO da dabei ist oder nicht. Das ist halt einfach wie wenn eine KI dabei
// ist oder nicht."): waking is author-neutral. An agent's (or an external agent's) normal line in a room of three or
// more that @mentions nobody goes through the same responder pick as a person's – the author is never an option,
// reply modes apply ('all' agents hear it, only 'auto' ones are picked) – and the pick may answer that nobody needs
// to reply, for every author (chat/responders.ts NOBODY). The one asymmetry is the safety fallback: without a decision
// model, or when it is unsure or fails, a person's line wakes the lead (a person waits for an answer; a provisional
// wake keeps that across a crash), an agent's line wakes nobody (an agent's statement mostly needs no reply; no
// provisional wake). So an agent's line is asked about even when only one colleague could answer: the alternative is
// nobody, not that colleague. An agent's important line to nobody keeps T10's addressee (the other agent, else the
// lead – at once, urgent); a run's final answer is for the person it answers: through the pick, never urgent. A
// discussion of agents without a person's line or task progress ends in the loop guard (chat/loop-guard.ts: two
// alternating, or many changes of speaker in a group).
// B-078 D8: a person's line wakes one responder – the pick names one, else the lead – never several at once; the
// others read it in their context on their next turn. An agent's line may still reach two (maxResponders).
// Owns: those routing steps, the guards' counters and the decisions in flight. Never: notifies the person, decides
// what counts as important (delivery does), or writes messages other than the guard's status lines.

import { HUMAN_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Member, Message } from '../../shared/model/chat.ts';
import { isExternalAgent } from '../bridges/external-agents.ts';
import { HUMAN_WROTE_NOTE, humanWaitIn } from '../tasks/transitions.ts';
import { LoopGuard, type LoopGuardOptions } from './loop-guard.ts';
import { isPersonMention } from './mentions.ts';
import { PICKED_NOTE, pickResponders } from './responders.ts'; // C4-live: a picked agent's wake says the line is its to answer
import { replyModeSplit } from './reply-modes.ts';

export type DeliveryDeps = Pick<RuntimeServices, 'chats' | 'wakes' | 'clock'>
  & Partial<Pick<RuntimeServices, 'org' | 'decisions' | 'dispatcher' | 'notifications' | 'log' | 'tasks' | 'runs' | 'db' | 'bus' | 'people'>>; // people (F-52): colleagues' names

/** How long the lead's provisional wake waits for the decision model before it answers itself. */
export const PROVISIONAL_WAKE_MS = 15_000;

/** Coalesce keys: the normal message wake of a chat, and the lead's provisional one. */
export const chatWakeKey = (conversationId: string) => `chat:${conversationId}`;
export const provisionalWakeKey = (conversationId: string) => `pick:${conversationId}`;

export interface RouteOptions extends LoopGuardOptions { maxResponders?: number; maxExternalPerMinute?: number }

/** How a routed message reaches agents: steer them (important), and who was steered already. */
interface Urgency { urgent?: boolean; steered?: string[] }

export class DeliveryRouter {
  private readonly s: DeliveryDeps;
  private readonly guard: LoopGuard;
  /** Rate cap for external (bridged) authors; ping-pong and discussion detection are effectively off (people chat back and forth). */
  private readonly externalGuard: LoopGuard;
  private readonly maxResponders: number;
  /** Decisions in flight per `<chat>\0<lead>`: the provisional wake stays until the last one returned. */
  private readonly deciding = new Map<string, number>();

  constructor(deps: DeliveryDeps, options: RouteOptions = {}) {
    this.s = deps;
    this.guard = new LoopGuard(options);
    this.externalGuard = new LoopGuard({ maxPerMinute: options.maxExternalPerMinute ?? 10, pingPongTurns: 1000, discussionTurns: Infinity });
    this.maxResponders = options.maxResponders ?? 2;
  }

  /** Real task progress breaks agent ping-pong. */
  progress(conversationId: string): void {
    this.guard.reset(conversationId);
  }

  /** Counts an agent-like line in the loop guard; false (after the guard's status line) when agents' wakes are paused in that chat. */
  agentLine(message: Message): boolean {
    const verdict = this.guard.agentMessage(message.conversationId, message.authorId, message.createdAt);
    if (verdict === 'ok') return true;
    this.paused(message, verdict);
    return false;
  }

  route(message: Message, members: Member[], important: boolean, external: string[]): void {
    if (message.kind !== 'text') return; // task anchors and answer receipts wake explicitly
    const agents = members.filter(m => m.kind === 'agent' && m.memberId !== message.authorId).map(m => m.memberId);
    const agentLike = message.authorKind === 'agent' || isExternalAgent(message.authorId); // C8
    if (agentLike && (agents.length || members.some(m => isExternalAgent(m.memberId) && m.memberId !== message.authorId)) && !this.agentLine(message)) return;
    if (!agents.length) return;
    const mentioned = message.mentions.filter(id => agents.includes(id));

    if (agentLike) {
      // K3: in a room of two the other member (an agent here) is addressed; K4: a quiet message reaches only those it mentions.
      const pair = !message.silent && members.length === 2 && members.some(m => m.memberId === message.authorId);
      if (pair || mentioned.length || message.silent) { this.wakeAll(message, pair ? agents : mentioned, { urgent: important }); return; }
      // T10: an important chat.send line to nobody in particular – the other agent, else the lead, at once.
      if (important && !message.mentions.length && !external.length && !runAnswer(message)) {
        this.wakeAll(message, this.addressee(message.conversationId, agents), { urgent: true });
        return;
      }
    } else {
      if (message.authorKind === 'external') {
        const verdict = this.externalGuard.agentMessage(message.conversationId, message.authorId, message.createdAt);
        if (verdict !== 'ok') { this.paused(message, verdict); return; }
      }
      if (message.authorKind === 'human') { this.guard.reset(message.conversationId); this.externalGuard.reset(message.conversationId); }
    }
    if (!mentioned.length && external.length) return; // C8: only external agents are addressed – they hear external.mention
    // K3: addressed only to people (the owner, a colleague, a bridged contact) – no agent is woken or steered.
    if (!mentioned.length && message.mentions.some(id => id !== message.authorId && isPersonMention(id))) return;

    // Round 4: from here on every author is routed alike – only an agent's line falls back to nobody and is never urgent.
    const urgent = important && !agentLike;
    // The person's important message also steers whoever already works in this chat (T10) – before
    // a decision is made, else after the addressed agents were woken.
    const steer = important && message.authorKind === 'human';
    // Reply modes (chat/reply-modes.ts): 'all' agents hear it; only 'auto' ones are picked; none → nobody else.
    const split = mentioned.length ? undefined : replyModeSplit(this.s.chats, message.conversationId, agents);
    if (split) this.wakeAll(message, split.always, { urgent });
    const pickable = split?.pickable ?? agents;
    const always = split?.always ?? []; // already woken (urgent when important): never steered twice
    if (!pickable.length) { if (steer) this.steerRunning(message, agents, always); return; }
    const lead = agentLike ? undefined : this.fallback(message.conversationId, pickable);
    if (!mentioned.length && (agentLike || pickable.length > 1) && this.s.decisions?.available()) {
      const steered = steer ? this.steerRunning(message, agents, always) : [];
      this.decide(message, pickable, lead, { urgent, steered });
      return;
    }
    const addressed = mentioned.length ? mentioned : lead !== undefined ? [lead] : []; // no decision model: an agent's line wakes nobody
    this.wakeAll(message, addressed, { urgent });
    if (steer) this.steerRunning(message, agents, [...addressed, ...always]);
  }

  /** The lead of the chat when it is one of `agents`, else the first of them. */
  private fallback(conversationId: string, agents: string[]): string {
    const lead = this.s.chats.lead(conversationId);
    return lead && agents.includes(lead) ? lead : agents[0];
  }

  /** An agent's important message to nobody in particular: the other agent of a two-agent room, else the lead (never the author). */
  private addressee(conversationId: string, agents: string[]): string[] {
    if (agents.length === 1) return agents;
    const lead = this.s.chats.lead(conversationId);
    return lead && agents.includes(lead) ? [lead] : [];
  }

  /** Steers (dispatcher.urgent) the chat's agents – except `asked` – whose running turn is in this chat; returns them. */
  private steerRunning(message: Message, agents: string[], asked: string[]): string[] {
    const dispatcher = this.s.dispatcher;
    if (typeof dispatcher?.activity !== 'function') return [];
    let running: string[];
    try {
      running = dispatcher.activity()
        .filter(run => !run.split && run.conversationId === message.conversationId && agents.includes(run.agentId) && !asked.includes(run.agentId)) // B-057: never a split's lane
        .map(run => run.agentId);
    } catch (error) {
      this.s.log?.warn('running turns unknown', { conversationId: message.conversationId, error: String(error) });
      return [];
    }
    for (const agentId of running) this.urge(agentId, message.conversationId);
    return running;
  }

  /**
   * The decision path: the picked agents are woken when the pick returns, nobody when it says no reply is needed. A
   * person's line (`lead` set) gives the lead a provisional wake now and falls back to it; an agent's line to nobody.
   */
  private decide(message: Message, agents: string[], lead: string | undefined, urgency: Urgency): void {
    const key = lead === undefined ? undefined : `${message.conversationId}\u0000${lead}`;
    if (lead !== undefined && key !== undefined) {
      this.wakeAll(message, [lead], { dueAt: this.s.clock.now() + PROVISIONAL_WAKE_MS, coalesceKey: provisionalWakeKey(message.conversationId) });
      this.deciding.set(key, (this.deciding.get(key) ?? 0) + 1);
    }
    const settle = (picked: string[] | 'nobody') => {
      let left = 0;
      if (key !== undefined) {
        left = (this.deciding.get(key) ?? 1) - 1;
        if (left > 0) this.deciding.set(key, left);
        else this.deciding.delete(key);
      }
      try {
        this.wakeAll(message, picked === 'nobody' ? [] : picked.length ? picked : lead !== undefined ? [lead] : [], { ...urgency, ...(picked !== 'nobody' && picked.length ? { note: PICKED_NOTE } : {}) });
      } finally {
        if (lead !== undefined && left <= 0) this.s.wakes.cancelKey?.(lead, provisionalWakeKey(message.conversationId));
      }
    };
    pickResponders(this.s, message, agents, lead !== undefined ? 1 : this.maxResponders) // D8: a person's line: one
      .then(settle, () => settle([]))
      .catch((error: unknown) => this.s.log?.warn('responder delivery failed', { messageId: message.id, error: String(error) }));
  }

  private wakeAll(message: Message, agentIds: string[], options: Urgency & { dueAt?: number; coalesceKey?: string; note?: string } = {}): void {
    for (const agentId of agentIds) {
      const waiting = message.authorKind === 'human' ? this.waitingTask(message.conversationId, agentId, message.authorId) : undefined;
      this.s.wakes.wake({
        agentId, reason: 'message', conversationId: message.conversationId, coalesceKey: options.coalesceKey ?? chatWakeKey(message.conversationId),
        ...(options.dueAt !== undefined ? { dueAt: options.dueAt } : {}),
        ...(waiting ? { taskId: waiting, note: HUMAN_WROTE_NOTE } : options.note ? { note: options.note } : {}),
      });
    }
    // A provisional wake never interrupts; external authors do only when trusted (else never important); a steered agent was asked already.
    if (options.dueAt !== undefined) return;
    if (!options.urgent) {
      if (message.authorKind === 'human') for (const agentId of agentIds) this.fold(agentId, message.conversationId);
      return;
    }
    for (const agentId of agentIds) if (!options.steered?.includes(agentId)) this.urge(agentId, message.conversationId);
  }

  /** The person's normal message reaches the agent's running turn in this chat at its next step (dispatcher.steer). */
  private fold(agentId: string, conversationId: string): void {
    const dispatcher = this.s.dispatcher;
    if (typeof dispatcher?.steer !== 'function') return;
    dispatcher.steer(agentId, conversationId).catch(error => {
      this.s.log?.warn('message fold failed', { agentId, error: String(error) });
    });
  }

  private urge(agentId: string, conversationId: string): void {
    this.s.dispatcher?.urgent(agentId, conversationId).catch(error => {
      this.s.log?.warn('urgent delivery failed', { agentId, error: String(error) });
    });
  }

  /**
   * The agent's one task here waiting on the human – F-52: only when the writer is the one it waits
   * on (the owner, or the person its wait names); a colleague's words never settle the owner's wait.
   */
  private waitingTask(conversationId: string, agentId: string, authorId: string): string | undefined {
    if (!this.s.tasks) return undefined;
    try {
      const task = humanWaitIn(this.s.tasks, conversationId, agentId);
      return task && (authorId === HUMAN_ID ? !isPersonId(task.waitingOn?.id) : task.waitingOn?.id === authorId) ? task.id : undefined;
    } catch (error) {
      this.s.log?.warn('looking up the waiting task failed', { conversationId, agentId, error: String(error) });
      return undefined;
    }
  }

  private paused(message: Message, verdict: 'rate' | 'ping_pong' | 'paused'): void {
    if (verdict === 'paused') return; // status line was posted when the pause began
    const text = verdict === 'rate' ? 'Agent replies paused: message rate limit' : 'Agent replies paused: back-and-forth without progress';
    this.s.log?.warn('loop guard paused chat', { conversationId: message.conversationId, verdict });
    this.s.chats.status(message.conversationId, { type: 'note', text, details: { guard: verdict } });
    // A loop (two alternating, or a group discussion): hand the situation to the lead, unless the lead took part in it.
    if (verdict !== 'ping_pong') return;
    const lead = this.s.chats.lead(message.conversationId);
    if (lead && !this.guard.pair(message.conversationId).includes(lead)) {
      this.s.wakes.wake({ agentId: lead, reason: 'review', conversationId: message.conversationId, note: text, coalesceKey: `guard:${message.conversationId}` });
    }
  }
}

/** A run's final answer (turn-finish posts it with the run's id) – not a chat.send post of the run (meta.sentDuringRun). */
function runAnswer(message: Message): boolean {
  return message.authorKind === 'agent' && message.runId !== undefined && message.meta.sentDuringRun !== true;
}
