// RPC contract part (B-041): My day – the person's own input, planning, the morning briefing, handing an own to-do
// to the team and what the person handed off. Handlers: runtime/rpc/handlers/day.ts, delegating to services.day
// ('unavailable' while it is missing). Tiers: 'todo' (a To-do-only phone runs its day), day.sendToTeam 'tasks' (it
// gives work to the team). No person variants in this build. Merged into Methods by module augmentation.
// Owns: these method shapes. Never: behaviour.

import type { Briefing, DayPlanResult } from '../model/calendar.ts';
import type { TaskView } from '../model/tasks.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** 'todo': My day input – always the person's own; one plain to-do per line. `date` (YYYY-MM-DD): the day shown – typed
     *  while a later day is shown, the to-dos are for that day (Task.window.date). */
    'day.add': { params: { text: string; private?: boolean; clientId?: string; date?: string }; result: { tasks: TaskView[] } };
    /** 'todo': plans `date` (YYYY-MM-DD, profile zone); 'replan' moves only planner blocks not started yet. */
    'day.plan': { params: { date: string; mode: 'plan' | 'replan' }; result: DayPlanResult };
    /** 'todo': the morning briefing of `date`, or null when there is none. */
    'day.briefing': { params: { date: string }; result: Briefing | null };
    /** 'tasks': an own to-do goes to the team (the responsible manager decides who does it). */
    'day.sendToTeam': { params: { id: string }; result: TaskView };
    /** 'todo': open and recently done tasks the person created that others own. */
    'day.handedOff': { params: { since?: number }; result: TaskView[] };
  }
}
