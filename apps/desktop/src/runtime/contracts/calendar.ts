// B-041 My day: the calendar, its connected sources, the day service and the learned estimates as optional
// members of RuntimeServices (merged by module augmentation, like the other late additions in this folder).
// Implemented by runtime/calendar/service.ts (A1), runtime/calendar/sources/index.ts (G), runtime/day/service.ts
// and runtime/day/estimates.ts (A2); wired in compose/calendar.ts. Missing = not wired (fakes): the RPC handlers
// answer 'unavailable', other callers skip.
// Owns: these interfaces and the member declarations. Never: behaviour.

import type {
  Briefing, CalendarAddInput, CalendarEvent, CalendarList, CalendarSetBy, CalendarSource, DayPlanMode, DayPlanResult, EstimateSource, FocusAction,
} from '../../shared/model/calendar.ts';
import type { TaskView } from '../../shared/model/tasks.ts';

export interface CalendarService {
  /** `agentId`: only that agent's runs (no rows), capped for it alone. */
  list(ownerId: string, from: number, to: number, agentId?: string): CalendarList;
  add(input: CalendarAddInput, by: string): Promise<{ event: CalendarEvent; task?: TaskView }>;
  /** Planner/agents: the one block of a task (created or moved; never over a person-set block – the service refuses).
   *  `by`: who placed it (an agent's id on the row's createdBy; default the system or the person by setBy). */
  upsertBlock(taskId: string, startAt: number, endAt: number, setBy: CalendarSetBy, by?: string): CalendarEvent;
  /** A move made on `rev` ('conflict' when the row changed since); the row becomes setBy 'person'. */
  move(id: string, startAt: number, endAt: number, rev: number, by: string): CalendarEvent;
  remove(id: string, by: string): void;
  /** The block of each task that has one (batched, like routeBriefs). */
  blocksFor(taskIds: string[]): Map<string, CalendarEvent>;
  /** Busy spans of a member in [from, to): events and person-set blocks (the planner's gaps). */
  busy(ownerId: string, from: number, to: number): Array<{ startAt: number; endAt: number }>;
  /** Sources mirror hook: every local change of a row (or its removal). Returns the unsubscribe. */
  onLocalChange(listener: (event: CalendarEvent | { removed: string }) => void): () => void;
}

export interface CalendarSources {
  list(ownerId: string): CalendarSource[];
  /** The owner's calendars and every room's (owner room:…), for Settings › Calendar. */
  listWithRooms(ownerId: string): CalendarSource[];
  /** `room` (B-078, D20): a room:… id (calendar/members.ts roomId) – the calendar then belongs to that room, not to `by`. */
  addIcs(input: { url: string; label?: string; room?: string }, by: string): Promise<CalendarSource>;
  update(id: string, patch: { label?: string; visible?: boolean; color?: string }, by: string): CalendarSource;
  remove(id: string, by: string): Promise<void>;
  /** One source now, or every source; `reason` for the log ('start', 'resume', 'plan', 'button' …). */
  sync(id?: string, reason?: string): Promise<CalendarSource[]>;
  /** `waiting`: a consent is open in the browser; `error`: the last connect failure (a user-safe sentence). */
  google(): { configured: boolean; connected: boolean; sourceId?: string; waiting?: boolean; error?: string };
  connectGoogle(clientId?: string): Promise<{ authUrl: string }>;
}

export interface DayService {
  add(input: { text: string; private?: boolean; clientId?: string; startAt?: number; endAt?: number; date?: string }, by: string): Promise<{ tasks: TaskView[] }>;
  plan(ownerId: string, date: string, mode: DayPlanMode): Promise<DayPlanResult>;
  setEstimate(taskId: string, minutes: number, by: string): TaskView;
  focus(taskId: string, action: FocusAction, by: string): TaskView;
  briefing(ownerId: string, date: string): Briefing | null;
  handedOff(ownerId: string, since?: number): TaskView[];
  sendToTeam(taskId: string, by: string): Promise<TaskView>;
}

export interface Estimates {
  /** said > the person's correction > mean of ≥ 2 actuals > model > 30 (DEFAULT_ESTIMATE_MIN). */
  estimateFor(input: { ownerId: string; title: string; key?: string; saidMin?: number; modelMin?: number }): { minutes: number; source: EstimateSource };
  learn(ownerId: string, title: string, minutes: number, kind: 'person' | 'actual', key?: string): void;
  /** The short canonical key of a to-do title ("küche aufräumen") – hashed before it is stored, never stored as text. */
  keyOf(title: string): string;
}

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** B-041: the members' local calendar (rows, task blocks); missing = not wired (fakes). */
    calendar?: CalendarService;
    /** B-041: connected calendars (ICS, Google); missing = not wired. */
    calendarSources?: CalendarSources;
    /** B-041: My day – own input, planning, focus timer, briefing, handed-off work; missing = not wired. */
    day?: DayService;
    /** B-041: learned time estimates (counters only, no task text); missing = not wired. */
    estimates?: Estimates;
  }
}
