// The agents' lane of My day's calendar (B-041 track A1, settings.day.agentLane – "jede KI selber so einen Bereich"):
// the planned runs of the agents' active schedules (routines, scheduled posts, reminders) inside a window, computed
// from each spec with schedules/spec.ts firesBetween (clock `times` too, B-044) – never stored. A schedule of a chat the owner does not see (a
// people's own chat, F-52) stays out; the person's own timers are to-dos, not agent runs. Capped per schedule and
// per window, so an hourly routine over a month stays a short list; asked for one agent (the agent page), the window
// cap counts only its runs, so other agents' busy routines never push its later runs out.
// Owns: that projection. Never: changes a schedule, or shows one of a chat hidden from the owner.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import type { AgentRun } from '../../shared/model/calendar.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { RuntimeServices } from '../contracts.ts';
import { firesBetween } from '../schedules/spec.ts';

/** At most this many runs of one schedule, and of the whole window. */
export const AGENT_RUN_LIMITS = Object.freeze({ perSchedule: 50, perWindow: 200 });

const AGENT_KINDS = new Set(['routine', 'message', 'reminder']);

/** The runs of the agents' schedules in [from, to), by time (see the header). */
export function agentRuns(s: Partial<Pick<RuntimeServices, 'scheduler' | 'chats' | 'org'>>, from: number, to: number, onlyAgent?: string): AgentRun[] {
  if (!s.scheduler) return [];
  const out: AgentRun[] = [];
  for (const schedule of s.scheduler.list()) {
    const agentId = schedule.ownerId;
    if (!schedule.active || !AGENT_KINDS.has(schedule.kind) || agentId === HUMAN_ID || agentId === SYSTEM_ID || isPersonId(agentId)) continue;
    if (onlyAgent !== undefined && agentId !== onlyAgent) continue;
    const agent = s.org?.get(agentId);
    if (s.org && (!agent || agent.archivedAt !== undefined)) continue;
    // An interval stored without an anchor (older agent schedules) runs from its next run, as the scheduler takes it.
    const spec = schedule.spec.everyMs !== undefined && schedule.spec.at === undefined && schedule.nextAt !== undefined ? { ...schedule.spec, at: schedule.nextAt } : schedule.spec;
    for (const at of firesBetween(spec, from - 1, to - 1, AGENT_RUN_LIMITS.perSchedule)) {
      out.push({ scheduleId: schedule.id, agentId, title: schedule.title, at });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.scheduleId.localeCompare(b.scheduleId)).slice(0, AGENT_RUN_LIMITS.perWindow);
}

