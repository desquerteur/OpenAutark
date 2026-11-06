// Delegation and handoff between agents and modes with a portable checkpoint.
// - delegate: a subtask for another agent (in the given chat; the assignee joins it – B-078 D7: out of a 1:1 the
//   work goes to the delegator's own 1:1 with the assignee instead, the status line stays in the 1:1) or for
//   oneself in another mode (T13: in a hidden work chat per parent task and mode, '<title> ·
//   <Mode>', the agent only – reused for the next delegation in that mode; still a step of the
//   parent). The delegator's own task then waits on the child (waitingOn kind 'task', several
//   children merge); tasks/transitions.ts resumes it with the child's result, and the ladder
//   only re-checks it while it waits (ownership.ts). A child its parent does not wait on still returns
//   its result to the delegator (tasks/lifecycle.ts).
//   The source chat must be one the delegator is a current member of (sourceChat). B-054: without one (a run
//   with no chat, on a chat-free task) the child is chat-free – no member joins, no status line, the wake
//   carries only its task – and mode work gets a work chat only when there is a source chat; never out of a bounded
//   (people's) chat the delegator is not in (refused, F-52). Both take the receiver by id or by a unique agent name.
// - handoff: moves the current task to another agent or mode (to an agent: only by a current
//   member of the task's chat; a chat-free task: by an agent that may read it, tasks/access.ts). Out of a 1:1
//   (D7) the receiver joins nothing: it is woken in the giver's own 1:1 with it (chat/direct.ts workRoomFor).
// Delegating to an agent on a linked PC (MP6) lives in devices/remote-agents.ts; it reuses the
// checkpoint, the rendered note and the parent's wait from here.
// The depth limit counts across PCs (chainDepth): a task that arrived from a linked PC starts at
// the depth it arrived with, on both paths.
// B-050 group cost: delegate's result says what the colleague already has from that chat – a line to answer there
// (the task reaches it in the same turn, agents/dispatch-groups.ts rideAlong) or a turn running there now (the task
// follows it) – and that the reply comes as the delegator's new turn, so it expects one answer and waits for none.
// Owns: those two, the depth limit, the work chats, that note and the rendered Handoff note that wakes the
// receiver. Never: drags full context along (only the checkpoint), exceeds the delegation depth,
// brings anyone into a chat the delegator is not a member of, or turns a task that waits on the
// person into one that waits on a child.

import type { RuntimeServices } from '../contracts.ts';
import type { ToolContext } from '../tools/types.ts';
import type { Handoff } from '../../shared/model/knowledge.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { KvRepo } from '../store/kv.ts';
import { canReadTask } from '../tasks/access.ts';
import { workRoomFor } from '../chat/direct.ts';
import { moveTaskChat } from '../tasks/owners.ts';

export const MAX_DELEGATION_DEPTH = 3;
/** D7, in the receiver's voice: a task handed out of a 1:1 it is not in now lives in the giver's 1:1 with it. */
export const MOVED_NOTE = (giver: string): string =>
  `${giver} handed me this out of a 1:1 I am not in, so the task now lives here, in our own 1:1. When it is done, ${giver} hears of it.`;
/** The refusal at the depth limit: Codex's "Agent depth limit reached.", then what I do instead. */
export const DEPTH_LIMIT_TEXT = 'Agent depth limit reached. I solve the task myself.';

export interface DelegateInput {
  to: string; // agent id or mode key
  title: string;
  goal?: string;
  notes?: string;
  next?: string;
  doneWhen?: string;
  constraints?: string[];
  mode?: string;
  chatId?: string;
}

/** Number of ancestors of a task (0 = top level). Bounded to avoid cycles. */
export function taskDepth(services: RuntimeServices, taskId: string | undefined): number {
  let depth = 0;
  let current = taskId ? services.tasks.get(taskId) : undefined;
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id) && depth < 20) {
    seen.add(current.id);
    depth++;
    current = services.tasks.get(current.parentId);
  }
  return depth;
}

/** kv namespace where a task delegated from a linked PC keeps the depth it arrived with (devices/remote-inbox.ts writes it). */
export const ARRIVED_DEPTH_KV = 'remote.inbox.task';

/** B-059: kv namespace where older top-level tasks keep the depth they were created at (read only; nothing writes it any more). */
export const TASK_DEPTH_KV = 'tasks.chain_depth';

/** Delegation depth across PCs: local ancestors plus the depth the root task arrived with from a linked PC (or an older row's TASK_DEPTH_KV). */
export function chainDepth(services: RuntimeServices, taskId: string | undefined): number {
  let root = taskId ? services.tasks.get(taskId) : undefined;
  const seen = new Set<string>();
  while (root?.parentId && !seen.has(root.id) && seen.size < 20) {
    seen.add(root.id);
    const up = services.tasks.get(root.parentId);
    if (!up) break;
    root = up;
  }
  let inherited = 0;
  const kv = (ns: string) => (root ? new KvRepo(services.db).get<{ depth?: number }>(ns, root.id)?.depth : undefined);
  try { inherited = Math.max(kv(ARRIVED_DEPTH_KV) ?? 0, kv(TASK_DEPTH_KV) ?? 0); } catch { /* no kv: local only */ } // B-059: a hand-on raises an arrived depth
  return taskDepth(services, taskId) + (Number.isInteger(inherited) && inherited > 0 ? inherited : 0);
}

export function renderHandoff(from: Agent, handoff: Handoff): string {
  const lines = [`Handoff from ${from.name} (${from.id}).`, `Goal: ${handoff.goal}`];
  if (handoff.verified.length) lines.push(`Done so far:\n${handoff.verified.map((item) => `- ${item}`).join('\n')}`);
  if (handoff.open.length) lines.push(`Open:\n${handoff.open.map((item) => `- ${item}`).join('\n')}`);
  if (handoff.next) lines.push(`Next step: ${handoff.next}`);
  if (handoff.constraints?.length) lines.push(`Constraints:\n${handoff.constraints.map((item) => `- ${item}`).join('\n')}`);
  if (handoff.artifacts.length) lines.push(`Artifacts:\n${handoff.artifacts.map((item) => `- ${item.label}: ${item.ref}`).join('\n')}`);
  return lines.join('\n');
}

export function checkpoint(ctx: ToolContext, input: { goal: string; next?: string; constraints?: string[] }): Handoff {
  let base: Handoff = { goal: input.goal, verified: [], open: [], next: input.next ?? '', artifacts: [] };
  try { base = ctx.services.context.checkpoint({ agentId: ctx.agent.id, taskId: ctx.taskId, conversationId: ctx.conversationId }); } catch { /* fall back to the given fields */ }
  return {
    ...base,
    goal: input.goal || base.goal,
    next: input.next ?? base.next,
    constraints: [...(base.constraints ?? []), ...(input.constraints ?? [])],
  };
}

function isModeKey(services: RuntimeServices, key: string): boolean {
  try { return services.modes.list().some((mode) => mode.key === key); } catch { return false; }
}

function modeName(services: RuntimeServices, key: string): string {
  try { return services.modes.list().find((mode) => mode.key === key)?.name ?? key; } catch { return key; }
}

/**
 * The hidden work chat of a mode sub-thread: the chat of an earlier step of `parent` in that mode
 * (outside the parent's chat, archived or not – C2), else a new one – '<title> · <Mode>', the agent
 * only, in the source chat's space, hidden from the list (Team activity) and in that mode.
 */
function workChat(services: RuntimeServices, agent: Agent, parent: Task | undefined, mode: string, title: string, sourceId: string): string {
  for (const step of parent ? services.tasks.get(parent.id)?.steps ?? [] : []) {
    if (step.mode !== mode || !step.conversationId || step.conversationId === parent!.conversationId) continue;
    if (services.chats.get(step.conversationId)) return step.conversationId; // archived counts too (C2); removed: a new one
  }
  let spaceId: string | undefined;
  try { spaceId = services.chats.summary(sourceId).spaceId; } catch { /* the agent's own space */ }
  const chat = services.chats.create({
    title: `${excerpt(parent?.title ?? title, 80)} · ${modeName(services, mode)}`, agentIds: [agent.id], humans: false, createdBy: agent.id, spaceId, lead: agent.id,
  });
  services.chats.update(chat.id, { settings: { hiddenFromList: true, mode } }, agent.id);
  return chat.id;
}

/** The delegator's own task waits on the new child (a wait on the person is never replaced); `who` does the child. */
export function waitOnChild(services: RuntimeServices, agent: Agent, parent: Task | undefined, child: Pick<Task, 'id' | 'title'>, who: string): void {
  if (!parent || parent.assigneeKind !== 'agent' || parent.assigneeId !== agent.id) return;
  const waitsOnChildren = parent.status === 'waiting' && parent.waitingOn?.kind === 'task';
  if (parent.status !== 'open' && parent.status !== 'working' && !waitsOnChildren) return;
  services.tasks.update(parent.id, {
    status: 'waiting',
    waitingOn: { kind: 'task', id: child.id, reason: excerpt(`Waiting for ${who}: ${child.title}`, 200), since: services.clock.now() },
  }, agent.id);
}

const isCurrentMember = (services: RuntimeServices, conversationId: string, agentId: string) =>
  services.chats.members(conversationId).some((member) => member.memberId === agentId && !member.leftAt);

/**
 * The chat a delegation starts from, checked before anything happens. A given chatId must exist (an archived
 * chat counts like any other, C2) and the delegator must be a current member (like every chat tool). Otherwise
 * the run's chat, else the parent task's – each only when it exists and the delegator is a current member there.
 * B-054: undefined when there is none – the child is chat-free. Delegating never brings an agent (or the
 * delegator) into a chat it is not in.
 */
export function sourceChat(ctx: ToolContext, parent: Pick<Task, 'conversationId'> | undefined, chatId: string | undefined): string | undefined {
  if (chatId) {
    if (!ctx.services.chats.get(chatId)) throw new WorkforceError('not_found', `Chat ${chatId} not found.`);
    if (!isCurrentMember(ctx.services, chatId, ctx.agent.id)) throw new WorkforceError('forbidden', `I am not a member of chat ${chatId}.`);
    return chatId;
  }
  for (const id of [ctx.conversationId, parent?.conversationId]) {
    if (id && ctx.services.chats.get(id) && isCurrentMember(ctx.services, id, ctx.agent.id)) return id;
  }
  return undefined;
}

/**
 * The agent `to` names: its id, else (B-054 fix N1, as chat.send {to} does) a unique active agent name, case ignored –
 * the full name or a first name only one agent has. Undefined: none, or more than one.
 */
function agentNamed(services: RuntimeServices, to: string): Agent | undefined {
  const byId = services.org.get(to);
  if (byId) return byId;
  const wanted = to.trim().toLowerCase();
  if (!wanted) return undefined;
  const active = services.org.list().filter((agent) => agent.archivedAt === undefined);
  const exact = active.filter((agent) => agent.name.trim().toLowerCase() === wanted);
  const fits = exact.length ? exact : active.filter((agent) => agent.name.trim().toLowerCase().split(/\s+/)[0] === wanted);
  return fits.length === 1 ? fits[0] : undefined;
}

const unknownTarget = (to: string) => `No agent or mode "${to}" – agents.list has the agent ids.`;

/**
 * B-050 group cost: what a colleague already has from this chat when a task arrives – a waiting line to answer
 * (both reach it in one turn) or a turn running there now (the task follows it); undefined: nothing.
 */
function alongWith(services: RuntimeServices, assignee: Agent, conversationId: string): string | undefined {
  let wakes: ReturnType<RuntimeServices['wakes']['list']>;
  try { wakes = services.wakes.list(assignee.id).filter((wake) => wake.conversationId === conversationId); } catch { return undefined; }
  const reply = 'Their reply comes to me as a new turn: I end mine instead of waiting.';
  if (wakes.some((wake) => wake.claimedAt === undefined && wake.reason === 'message' && !wake.taskId)) {
    return `${assignee.name} already has a line of this chat to answer: this task reaches them in the same turn. ${reply}`;
  }
  if (wakes.some((wake) => wake.claimedAt !== undefined)) {
    return `${assignee.name} is working in this chat right now; this task follows that turn (if a reply there already does it, they finish it with that). ${reply}`;
  }
  return undefined;
}

/** Creates a subtask for another agent (or for oneself in another mode) and wakes it. */
export function delegate(ctx: ToolContext, input: DelegateInput): { taskId: string; to: string; mode?: string; chatId?: string; note?: string } {
  const services = ctx.services;
  if (chainDepth(services, ctx.taskId) >= MAX_DELEGATION_DEPTH) throw new WorkforceError('forbidden', DEPTH_LIMIT_TEXT);
  const parent = ctx.taskId ? services.tasks.get(ctx.taskId) : undefined;
  const sourceId = sourceChat(ctx, parent, input.chatId);

  const target = agentNamed(services, input.to);
  const modeOnly = !target && isModeKey(services, input.to);
  if (!target && !modeOnly) throw new WorkforceError('not_found', unknownTarget(input.to));
  const assignee = target ?? ctx.agent;
  const mode = modeOnly ? input.to : input.mode;
  if (target && target.archivedAt) throw new WorkforceError('conflict', `${target.name} is archived.`);

  // Agent-to-agent work stays in the given chat (out of a 1:1: our own 1:1, D7); mode work of oneself gets its own
  // work chat – both only when there is a source chat (B-054: else the child is chat-free).
  const conversationId = !sourceId ? undefined : modeOnly ? workChat(services, assignee, parent, input.to, input.title, sourceId) : workRoomFor(services, sourceId, ctx.agent.id, assignee.id);
  // The delegator is a member of the source chat (sourceChat), so it may bring the assignee in.
  if (conversationId && !isCurrentMember(services, conversationId, assignee.id)) {
    services.chats.setMembers(conversationId, { add: [assignee.id] }, ctx.agent.id);
  }
  const handoff = checkpoint(ctx, { goal: input.goal ?? input.title, next: input.next, constraints: input.constraints });
  const note = renderHandoff(ctx.agent, handoff);
  const task = services.tasks.create({
    ...(conversationId ? { conversationId } : {}), title: input.title, notes: [input.notes, note].filter(Boolean).join('\n\n'),
    assigneeKind: 'agent', assigneeId: assignee.id, parentId: ctx.taskId, doneWhen: input.doneWhen, mode,
    createdBy: ctx.agent.id, ...(ctx.origin ? { origin: ctx.origin } : {}),
  });
  waitOnChild(services, ctx.agent, parent, task, assignee.id === ctx.agent.id ? 'its own work' : assignee.name);
  const along = assignee.id === ctx.agent.id || !conversationId ? undefined : alongWith(services, assignee, conversationId); // before its own wake
  services.wakes.wake({ agentId: assignee.id, reason: 'handoff', ...(conversationId ? { conversationId } : {}), taskId: task.id, note, coalesceKey: `handoff:${task.id}` });
  const workChatId = conversationId !== sourceId ? conversationId : undefined;
  if (!sourceId) return { taskId: task.id, to: assignee.id, mode }; // B-054: a chat-free child – no status line anywhere
  try {
    // The line goes where the person follows the work (the source chat), naming the work chat.
    services.chats.status(sourceId, {
      type: modeOnly ? 'mode_switched' : 'handoff',
      text: modeOnly ? `${ctx.agent.name} · ${input.to}` : `${ctx.agent.name} → ${assignee.name}`,
      details: { taskId: task.id, from: ctx.agent.id, to: assignee.id, mode, ...(workChatId ? { chatId: workChatId } : {}) },
    }, { authorId: ctx.agent.id, taskId: task.id });
  } catch { /* cosmetic */ }
  return { taskId: task.id, to: assignee.id, mode, ...(workChatId ? { chatId: workChatId } : {}), ...(along ? { note: along } : {}) };
}

/** Moves the current task to another agent or mode; the receiver continues from the checkpoint. */
export function handoff(ctx: ToolContext, input: { to: string; next?: string; note?: string }): { taskId: string; to: string; mode?: string } {
  const services = ctx.services;
  if (!ctx.taskId) throw new WorkforceError('bad_request', 'handoff moves the current task; this run has none: I delegate.');
  const task = services.tasks.get(ctx.taskId);
  if (!task) throw new WorkforceError('not_found', 'Task not found.');
  const target = agentNamed(services, input.to);
  const modeOnly = !target && isModeKey(services, input.to);
  if (!target && !modeOnly) throw new WorkforceError('not_found', unknownTarget(input.to));
  const state = checkpoint(ctx, { goal: task.title, next: input.next });
  const receiver = target ?? ctx.agent;
  const chatId = task.conversationId;
  let wakeIn = chatId; // D7: out of a 1:1 the receiver works in our own 1:1
  if (target) {
    if (chatId) {
      // Only a current member brings the receiver into the task's chat (owners.ts mayBringIn).
      if (!isCurrentMember(services, chatId, ctx.agent.id)) throw new WorkforceError('forbidden', `I am not a member of chat ${chatId}.`);
      wakeIn = workRoomFor(services, chatId, ctx.agent.id, target.id);
      if (wakeIn === chatId && !isCurrentMember(services, chatId, target.id)) services.chats.setMembers(chatId, { add: [target.id] }, ctx.agent.id);
      // The task goes with the receiver into our 1:1, so assign's wake, later wakes and its answers land where it is a
      // member; the status line below stays in the 1:1 it came from and names our room.
      else if (wakeIn && wakeIn !== chatId) moveTaskChat(services, task.id, wakeIn);
    } else if (!canReadTask(services, ctx.agent.id, task)) {
      throw new WorkforceError('not_found', 'Task not found.'); // B-054: a chat-free task – whoever may read it hands it on
    }
    services.tasks.assign(task.id, { kind: 'agent', id: target.id }, ctx.agent.id);
  } else {
    services.tasks.update(task.id, { mode: input.to }, ctx.agent.id);
  }
  const moved = wakeIn !== chatId ? MOVED_NOTE(ctx.agent.name) : undefined;
  const note = [renderHandoff(ctx.agent, state), input.note, moved].filter(Boolean).join('\n\n');
  // B-048 E4.3: the giver's model wish in its chat goes with the task (a recommendation for the receiver).
  services.wakes.wake({ agentId: receiver.id, reason: 'handoff', ...(wakeIn ? { conversationId: wakeIn } : {}), taskId: task.id, note, coalesceKey: `handoff:${task.id}` });
  if (!chatId) return { taskId: task.id, to: receiver.id, mode: modeOnly ? input.to : undefined }; // B-054: no status line
  try {
    services.chats.status(chatId, {
      type: modeOnly ? 'mode_switched' : 'handoff',
      text: modeOnly ? `${ctx.agent.name} · ${input.to}` : `${ctx.agent.name} → ${receiver.name}`,
      details: { taskId: task.id, from: ctx.agent.id, to: receiver.id, mode: modeOnly ? input.to : undefined, ...(wakeIn !== chatId ? { chatId: wakeIn } : {}) },
    }, { authorId: ctx.agent.id, taskId: task.id });
  } catch { /* cosmetic */ }
  return { taskId: task.id, to: receiver.id, mode: modeOnly ? input.to : undefined };
}
