// DayService (B-041 track A2, contract §4): My day's runtime, wired by compose/calendar.ts with the late-bound
// services record. The person's own input (day/intake.ts: one plain to-do per line, the assistant hears of them),
// planning a day (day/plan.ts over calendar/planner.ts), the person's estimates and the focus timer
// (day/focus.ts – its task.upserted listener stops a finished to-do's timer and learns its time), the stored
// morning briefing (day/briefing.ts; the morning run, day/morning.ts, builds it), the work the person handed off
// and handing an own to-do to the team (day/handed-off.ts). The personal assistant is day/assistant.ts.
// start() subscribes the one listener; stop() drops it and ends the input's background passes.
// Owns: these flows. Never: completes, cancels or moves a person's to-do for an agent, or calls a model inside
// a request.

import type { Briefing, DayPlanMode, DayPlanResult, FocusAction } from '../../shared/model/calendar.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { DayService } from '../contracts/calendar.ts';
import type { HelperDeps } from './helper.ts';
import { Briefings } from './briefing.ts';
import { FocusTimer } from './focus.ts';
import { handedOff, sendToTeam } from './handed-off.ts';
import { DayIntake, type DayAddInput } from './intake.ts';
import { planFor } from './plan.ts';

export type DayDeps = Pick<RuntimeServices, 'db' | 'bus' | 'clock' | 'settings' | 'tasks' | 'chats' | 'org' | 'wakes' | 'log'>
  & Partial<Pick<RuntimeServices, 'calendar' | 'calendarSources' | 'estimates' | 'decisions' | 'subconscious' | 'scheduler' | 'dispatcher'>> & HelperDeps;

export class DayServiceImpl implements DayService {
  readonly s: DayDeps;
  readonly briefings: Briefings;
  readonly intake: DayIntake;
  readonly timer: FocusTimer;
  private offs: Array<() => void> = [];

  constructor(s: DayDeps) {
    this.s = s;
    this.briefings = new Briefings(s);
    this.intake = new DayIntake(s);
    this.timer = new FocusTimer(s);
  }

  start(): void {
    if (this.offs.length) return;
    this.offs.push(this.s.bus.on('task.upserted', (task) => this.timer.onTask(task)));
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.intake.stop();
  }

  add(input: DayAddInput, by: string): Promise<{ tasks: TaskView[] }> { return this.intake.add(input, by); }
  plan(ownerId: string, date: string, mode: DayPlanMode): Promise<DayPlanResult> { return planFor(this.s, ownerId, date, mode); }
  setEstimate(taskId: string, minutes: number, by: string): TaskView { return this.timer.setEstimate(taskId, minutes, by); }
  focus(taskId: string, action: FocusAction, by: string): TaskView { return this.timer.focus(taskId, action, by); }
  briefing(ownerId: string, date: string): Briefing | null { return this.briefings.get(ownerId, date); }
  handedOff(ownerId: string, since?: number): TaskView[] { return handedOff(this.s, ownerId, since); }
  sendToTeam(taskId: string, by: string): Promise<TaskView> { return sendToTeam(this.s, taskId, by, (task) => { this.timer.focus(task.id, 'stop', by); }); }
}
