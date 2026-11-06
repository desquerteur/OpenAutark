// Pure rules behind the task center UI (Work, 17:37 / 20:19 – shared/model/task-center.ts): the
// optional recipients of a quick task (an agent – a manager counts as one –, a manager's branch, a
// team, in the owner's composer an active person – F-52 –, and "Me": every part goes to My day –
// B-041) and their labels, the short progress/blocker line of a task row (what waits, the agent's live
// note, the next step or its latest own report line – never invented thinking), the open questions of
// a task the person can answer in its detail, whether a task message in a chat is the task itself or
// only a reference to it, and the title a pending quick post shows.
// Owns: these rules (unit-tested in test/unit/ui/task-center-model.test.ts).
// Never: imports the store, rpc or the DOM – callers pass data in, so tests run in Node.

import type { Agent } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import type { QuickTaskTarget } from '../../shared/model/task-center.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { plainPreview } from '../lib/format.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import { waitingLine } from './waiting.ts';
import { ownerOf } from './work-model.ts';

/** Where the person's own items go (B-041): the line a route, a recipient and an intake part show. */
export const TO_MY_DAY = `→ ${DESTINATIONS.day}`;

/** The person's own work (My day): theirs without an id or with their own – a colleague's carries 'per_…' (F-52). */
export function isMine(task: Pick<Task, 'assigneeKind' | 'assigneeId'>): boolean {
  return ownerOf(task).kind === 'human'; // Work's owner rule
}

// ------------------------------------------------------------------ recipients

type AgentLike = Pick<Agent, 'id' | 'name' | 'role' | 'managerId' | 'team' | 'archivedAt'>;
type PersonLike = Pick<Person, 'id' | 'name' | 'title' | 'status' | 'owner'>;

export interface Recipient { target: QuickTaskTarget; label: string; hint?: string }
export interface RecipientGroups { agents: Recipient[]; branches: Recipient[]; teams: Recipient[]; people: Recipient[] }

/** People a quick task can go to: joined ('active'), not the owner – an invited or removed person never shows. */
function reachablePeople<T extends PersonLike>(list: readonly T[]): T[] {
  return list.filter((person) => person.status === 'active' && !person.owner && person.id !== 'human');
}

/** Agents that can be addressed: not archived. */
function addressable<T extends AgentLike>(list: readonly T[]): T[] {
  return list.filter((agent) => agent.archivedAt === undefined);
}

const fold = (text: string) => text.trim().toLowerCase();

/** Everyone below `managerId` (reports of reports too, cycles ignored). */
function branchSize(managerId: string, list: readonly AgentLike[]): number {
  const seen = new Set<string>([managerId]);
  const queue = [managerId];
  while (queue.length) {
    const boss = queue.shift()!;
    for (const agent of list) {
      if (agent.managerId === boss && !seen.has(agent.id)) { seen.add(agent.id); queue.push(agent.id); }
    }
  }
  return seen.size - 1;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Me" (B-041): the person's own post – the split puts every part on My day (shared/model/task-center.ts). */
export const ME_TARGET: QuickTaskTarget = { kind: 'me', id: HUMAN_ID };
export const ME_RECIPIENT: Recipient = { target: ME_TARGET, label: 'Me', hint: TO_MY_DAY };

/**
 * The recipient menu: agents by name, managers with reports as branches, team names (Agent.team) as
 * teams, and the active people of `people` (only the owner's composer passes them – F-52).
 */
export function recipientGroups(list: readonly AgentLike[], people: readonly PersonLike[] = []): RecipientGroups {
  const active = addressable(list).sort((a, b) => a.name.localeCompare(b.name));
  const agents = active.map((agent): Recipient => ({ target: { kind: 'agent', id: agent.id }, label: agent.name, ...(agent.role ? { hint: agent.role } : {}) }));
  const branches = active
    .map((agent) => ({ agent, size: branchSize(agent.id, active) }))
    .filter((entry) => entry.size > 0)
    .map(({ agent, size }): Recipient => ({ target: { kind: 'branch', id: agent.id }, label: agent.name, hint: count(size, 'agent', 'agents') }));
  const teams = new Map<string, { name: string; size: number }>();
  for (const agent of active) {
    const name = agent.team?.trim();
    if (!name) continue;
    const entry = teams.get(fold(name));
    if (!entry) teams.set(fold(name), { name, size: 1 });
    else {
      entry.size++;
      if (/^\p{Lu}/u.test(name) && !/^\p{Lu}/u.test(entry.name)) entry.name = name; // "Video" over "video"
    }
  }
  return {
    agents, branches,
    teams: [...teams.values()].sort((a, b) => a.name.localeCompare(b.name))
      .map((team): Recipient => ({ target: { kind: 'team', id: team.name }, label: team.name, hint: count(team.size, 'agent', 'agents') })),
    people: reachablePeople(people).sort((a, b) => a.name.localeCompare(b.name))
      .map((person): Recipient => ({ target: { kind: 'person', id: person.id }, label: person.name, ...(person.title ? { hint: person.title } : {}) })),
  };
}

/** The chip text of a recipient: 'Auto', 'Me', the agent, "Mara's branch", "Marketing team", the person; undefined when it no longer exists. */
export function targetLabel(target: QuickTaskTarget | undefined, list: readonly AgentLike[], people: readonly PersonLike[] = []): string | undefined {
  if (!target) return 'Auto';
  if (target.kind === 'me') return target.id === HUMAN_ID ? ME_RECIPIENT.label : undefined;
  if (target.kind === 'person') return reachablePeople(people).find((person) => person.id === target.id)?.name;
  const active = addressable(list);
  if (target.kind === 'team') {
    const team = active.find((agent) => agent.team && fold(agent.team) === fold(target.id))?.team?.trim();
    if (!team) return undefined;
    return /\bteam$/i.test(team) ? team : `${team} team`;
  }
  const agent = active.find((entry) => entry.id === target.id);
  if (!agent) return undefined;
  if (target.kind === 'branch') return branchSize(agent.id, active) > 0 ? `${agent.name}'s branch` : undefined;
  return agent.name;
}

export function sameTarget(a: QuickTaskTarget | undefined, b: QuickTaskTarget | undefined): boolean {
  return a === b || (!!a && !!b && a.kind === b.kind && fold(a.id) === fold(b.id));
}

// ------------------------------------------------------------------ progress line

type NameOf = (agentId: string) => string;

/** No owner yet (its manager has not placed it, or it waits for other tasks first). */
export function isUnassigned(task: Pick<Task, 'assigneeKind' | 'status' | 'parentId'>): boolean {
  return !task.parentId && task.assigneeKind === 'team' && (task.status === 'open' || task.status === 'waiting');
}

/** The agent's latest own report line (tasks.update fact), without the verifier's notes. */
function latestReport(task: Pick<Task, 'ledger'>): string | undefined {
  const facts = task.ledger?.facts ?? [];
  for (let index = facts.length - 1; index >= 0; index--) {
    if (!/^Verifier:/i.test(facts[index])) return facts[index];
  }
  return undefined;
}

/**
 * The short readable line of a task row: what it waits on or why it is blocked, the owner's live
 * note while a turn runs, the next open step, else the
 * owner's latest report line. Null when there is nothing true to say.
 */
export function progressLine(task: Pick<TaskView, 'assigneeKind' | 'assigneeId' | 'status' | 'waitingOn' | 'steps' | 'ledger' | 'running' | 'result' | 'parentId'>, context: { note?: string; nameOf: NameOf }): string | null {
  if (task.status === 'done' || task.status === 'cancelled') return task.result?.summary ? plainPreview(task.result.summary, 90) : null;
  const waiting = waitingLine(task, context.nameOf);
  if (waiting) return waiting;
  if (task.running && context.note?.trim()) return plainPreview(context.note, 90);
  const next = task.steps?.slice().sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt)
    .find((step) => step.status !== 'done' && step.status !== 'cancelled');
  if (next) return `Next: ${plainPreview(next.title, 80)}`;
  const report = latestReport(task);
  return report ? plainPreview(report, 90) : null;
}

// ------------------------------------------------------------------ questions for the person

/**
 * Open questions of a task the person answers right in its detail: its unfinished human steps
 * with a catalog widget (a choice, a form, a confirm …). Mini-app to-dos stay on the My day list
 * (their sandboxed frame lives there).
 */
export function openQuestions<T extends Pick<Task, 'assigneeKind' | 'status' | 'widget' | 'sort' | 'createdAt'>>(steps: readonly T[]): T[] {
  // A mini-app to-do's widget is stored as a UiBlock with type 'app' (shared/model/tasks.ts).
  return steps.filter((step) => step.assigneeKind === 'human' && step.status !== 'done' && step.status !== 'cancelled'
    && !!step.widget && String(step.widget.type) !== 'app').sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
}

// ------------------------------------------------------------------ task messages and posts

/**
 * A task message in a chat is the task itself (its anchor: the full card) or only a reference to
 * a task that lives on its own (B-054: handed over in another chat, or in none – a chat-free task
 * shared here has no anchor at all). A reference shows title, owner and live status and links
 * there; never a copy.
 */
export function isReference(message: Pick<Message, 'id'>, task: Pick<Task, 'messageId' | 'parentId'>): boolean {
  return !task.parentId && task.messageId !== message.id;
}

/** The title a quick post shows until the runtime answers (the runtime's rule: first line, else the first file, cut at 120). */
export function postTitle(text: string, fileNames: readonly string[] = []): string {
  const first = text.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return excerpt(first || fileNames[0] || 'Files', 120);
}
