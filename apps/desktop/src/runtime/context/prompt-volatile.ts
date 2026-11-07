// The VOLATILE system-prompt section: everything that changes between turns, each section under a fixed name (a resumed
// native session gets only the changed ones, agents/volatile-delta.ts). Order: now (date, time, the model the turn runs
// on), the split's own facts (B-057), "My environment now" (environment.ts), who works nearby (work-presence), this
// chat (chat-section.ts), the agent's split groups still at work, its home project and skills (agent-core/prompt.ts),
// the live team and model facts (manager mode only, setup-facts.ts), B-078 the always set – always-skills and pinned notes
// with the day they were saved under one cap (knowledge/always.ts;
// B-077: the heading names "What I have here" as the place of agreements, including for older custom SYSTEM.md files),
// the current task in detail, other open tasks (<= 10) and the agent's own schedules (<= 10). A split's turn (thread `split:<id>`) drops its main self's sections and reads the
// environment and pinned notes for its parent's chat.
// Owns: those renderings and their caps. A failing source is skipped (logged), never fatal.
// Never: state reconstructed from memory similarity - tasks and schedules come from their services; any list of what
// memory holds, or a hint of the subconscious (it shows real tool calls, agents/turn-prepare.ts).

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { RouteDecision } from '../../shared/model/providers.ts';
import type { Schedule, TaskView } from '../../shared/model/tasks.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { dueText, fullDateTime, profileZone } from './time.ts';
import { currentTaskSection } from './task-text.ts';
import { chatSection } from './chat-section.ts'; // B-050: "## This chat" (title per viewer, 1:1 or group of peers, notes)
import { setupFactsSection } from './setup-facts.ts';
import { SPLIT_SKIP, activeSplitsLine, splitFacts, splitSection } from './split-section.ts'; // B-057
import { ALWAYS_CHARS, alwaysLines, alwaysSet } from '../knowledge/always.ts';
import { hasHavePart } from '../org/system-parts.ts'; // B-077: the pinned heading names where agreements live
import { homeSection } from '../agent-core/prompt.ts'; // B-044: the home project and its skills (names + descriptions)
import { environmentNow } from './environment.ts'; // B-047 D6: the PC, readable data folder, accounts needing sign-in, what it knows
import { workNearbySection } from '../work-presence/context-line.ts'; // B-055 G (Q11): who else is changing files near this agent's work
import { personalitySection } from '../personality/prompt.ts'; // AF-006: "## My personality", read fresh each turn

/** The one cap of what always stands in the prompt (knowledge/always.ts). */
export const PINNED_CAP = ALWAYS_CHARS;
const MAX_TASKS = 10;
const MAX_SCHEDULES = 10;

export interface VolatileInput {
  agent: Agent;
  conversationId?: string;
  taskId?: string;
  /** B-054: the turn's thread (TurnPlan.thread) – its native session's key. */
  thread?: string;
  route: RouteDecision;
}

function nowSection(services: RuntimeServices, input: VolatileInput, zone: string): string {
  const { route } = input;
  let name: string | undefined;
  try { name = services.catalog.get(route.modelId)?.name; } catch { /* catalog not wired */ }
  return [`## Now`, `${fullDateTime(services.clock.now(), zone)} (${zone})`, `I run on ${name ?? route.modelId} · effort ${route.effort}.`].join('\n');
}

function pinnedSection(services: RuntimeServices, agent: Agent, zone: string, conversationId?: string, mode?: ModeInfo): string {
  // B-078 D12: one always set – the always-skills and the pinned notes (each with the day it was saved, B-044), one cap (knowledge/always.ts)
  const lines = alwaysLines(services, agent, alwaysSet(services, agent, mode, conversationId), zone);
  if (!lines.length) return '';
  // B-077 (owner 05.11.2026: the open system brings itself to its best state, nobody moves things by hand): where the
  // notes are read, the fact of where an agreement lives – so an agent sees an older pinned agreement and moves it itself.
  const have = hasHavePart(agent.instructions ?? '')
    ? ` – what ${ownerName(services)} and I settle stands in my SYSTEM.md under "What I have here"`
    : ` – I keep what ${ownerName(services)} and I settle in my SYSTEM.md under "What I have here"; I add that section when missing and move older agreements there, keeping facts in memory`;
  return [`## Pinned memory (skills and notes that always apply; I check them against the current state${have})`, ...lines].join('\n');
}

function ownerName(services: RuntimeServices): string {
  try { return services.settings.get().profile.name?.trim() || 'the person'; } catch { return 'the person'; }
}

function taskLine(task: TaskView, zone: string, now: number): string {
  const parts = [task.id, task.status];
  if (task.dueAt) parts.push(`due ${dueText(task.dueAt, zone, now)}`);
  if (task.priority > 0) parts.push(task.priority === 2 ? 'urgent' : 'high priority');
  const waiting = task.waitingOn ? ` (waiting: ${excerpt(task.waitingOn.reason, 80)})` : '';
  return `- ${parts.join(' · ')} · ${excerpt(task.title, 120)}${waiting}`;
}

function openTasksSection(services: RuntimeServices, agent: Agent, currentTaskId: string | undefined, zone: string): string {
  const open = services.tasks.openFor(agent.id);
  const ids = new Set(open.map((task) => task.id));
  // Steps and own sub-tasks of listed tasks are shown with their parent, not on their own.
  const top = open.filter((task) => task.id !== currentTaskId && !(task.parentId && (ids.has(task.parentId) || task.parentId === currentTaskId)));
  if (!top.length) return '';
  const now = services.clock.now();
  const lines = top.slice(0, MAX_TASKS).map((task) => taskLine(task, zone, now));
  if (top.length > MAX_TASKS) lines.push(`(+${top.length - MAX_TASKS} more – tasks.list)`);
  return [currentTaskId ? '## My other open tasks and promises' : '## My open tasks and promises', ...lines].join('\n');
}

function scheduleLine(schedule: Schedule, zone: string, now: number): string {
  const when = schedule.nextAt ? `next ${dueText(schedule.nextAt, zone, now)}` : 'no next run';
  const repeat = schedule.spec.cron ? ` · cron "${schedule.spec.cron}"` : schedule.spec.everyMs ? ` · every ${Math.round(schedule.spec.everyMs / 60_000)} min` : schedule.spec.times ? ` · daily at ${schedule.spec.times.join(', ')}` : '';
  return `- ${schedule.id} · ${schedule.kind} · ${excerpt(schedule.title, 100)} · ${when}${repeat}`;
}

function schedulesSection(services: RuntimeServices, agent: Agent, zone: string): string {
  const own = services.scheduler.list({ ownerId: agent.id }).filter((schedule) => schedule.active);
  if (!own.length) return '';
  const now = services.clock.now();
  const lines = own.slice(0, MAX_SCHEDULES).map((schedule) => scheduleLine(schedule, zone, now));
  if (own.length > MAX_SCHEDULES) lines.push(`(+${own.length - MAX_SCHEDULES} more – schedules.list)`);
  return ['## My schedules (visible to the CEO; schedules.update changes one, schedules.cancel ends one)', ...lines].join('\n');
}

/** The turn's mode key, same order as turn planning (task → chat → agent default). */
function turnMode(services: RuntimeServices, agent: Agent, conversationId?: string, taskId?: string): string {
  const task = taskId ? services.tasks.get(taskId) : undefined;
  const chat = conversationId ? services.chats.get(conversationId) : undefined;
  return task?.mode || chat?.settings.mode || agent.mode;
}

/** B-047 D6: the turn's mode as ModeInfo (its tool offer names the file tools of the environment lines); undefined when unknown. */
function turnModeInfo(services: RuntimeServices, agent: Agent, conversationId?: string, taskId?: string) {
  try { return services.modes.get(turnMode(services, agent, conversationId, taskId)); } catch { return undefined; }
}

/** The team, accounts and strong models right now – only for turns in manager mode (setup-facts.ts; the rest: app.status). */
function setupSection(services: RuntimeServices, agent: Agent, conversationId?: string, taskId?: string): string {
  return turnMode(services, agent, conversationId, taskId) === 'manager' ? setupFactsSection(services) : '';
}

/** One rendered section of the volatile prompt under its fixed name ('now', 'environment', 'task' …); `failed`: its builder threw (text ''). */
export interface VolatileSection { name: string; text: string; failed?: true }

/** The volatile prompt as one string (the sections in order, a blank line apart). */
export function buildVolatile(services: RuntimeServices, input: VolatileInput): string {
  return volatileSections(services, input).filter((section) => !section.failed).map((section) => section.text).join('\n\n');
}

/**
 * The volatile prompt's non-empty sections in order, each under its fixed name (B-049 F6: a resumed native session gets
 * only the changed ones, agents/volatile-delta.ts). A section whose builder threw comes back as `failed` with no text,
 * so the delta keeps its last record instead of calling it no longer current.
 */
export function volatileSections(services: RuntimeServices, input: VolatileInput): VolatileSection[] {
  const { agent, conversationId, taskId } = input;
  const zone = profileZone(services); // the Now line's zone; saved/indexed days use the same one (knowledge/age.ts)
  const split = splitFacts(services, input.thread); // B-057: a split's turn (thread split:<id>)
  const reach = conversationId ?? split?.group?.conversationId; // B-057 S15: a split's mode and pinned notes are its parent chat's
  const modeTask = taskId ?? split?.group?.taskId; // B-057: … and its mode is its parent's (task mode → chat mode → agent default)
  const sections: Array<[string, () => string]> = [
    ['now', () => nowSection(services, input, zone)],
    ['personality', () => personalitySection(services, agent)], // AF-006: the global personality with the agent's own over it
    ['split', () => (split ? splitSection(agent, split) : '')], // B-057 S5: who it is, its part, the other parts, its rules
    ['environment', () => environmentNow(services, { agent, conversationId: reach, mode: turnModeInfo(services, agent, reach, modeTask) })], // B-047 D6 (every mode)
    ['work-nearby', () => workNearbySection(services, { agent, taskId })], // B-055 G (Q11): at most 3 lines / 300 chars, '' when no one works nearby
    ['chat', () => (conversationId ? chatSection(services, agent, conversationId) : '')],
    ['splits', () => (split ? '' : activeSplitsLine(services, agent.id, input.thread))], // B-057 R1-4: its split groups still at work on this thread
    ['home', () => homeSection(services, agent, turnMode(services, agent, reach, modeTask))], // B-044: the home project turns start in and the skills found there
    ['setup', () => setupSection(services, agent, conversationId, taskId)],
    ['pinned', () => pinnedSection(services, agent, zone, reach, turnModeInfo(services, agent, reach, modeTask))],
    ['task', () => (taskId ? currentTaskSection(services, taskId, zone) : '')],
    ['tasks', () => openTasksSection(services, agent, taskId, zone)],
    ['schedules', () => schedulesSection(services, agent, zone)],
  ];
  const out: VolatileSection[] = [];
  for (const [name, build] of sections) {
    if (split && SPLIT_SKIP.has(name)) continue; // B-057: its main self's sections
    try {
      const text = build();
      if (text.trim()) out.push({ name, text });
    } catch (error) {
      services.log?.debug('volatile prompt section skipped', { section: name, error: String(error) });
      out.push({ name, text: '', failed: true });
    }
  }
  return out;
}
