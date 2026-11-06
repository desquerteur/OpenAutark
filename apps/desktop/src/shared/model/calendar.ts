// My day's calendar (B-041, the My day concept §4–§5): the local calendar is the source,
// connected calendars (ICS, Google) are mirrors. A row is either an event (a meeting, an appointment – it has
// its own title) or a time block of a task ('todo', taskId set – it has NO title: the view reads the task, so
// task text is never copied). Rows are keyed by member (`ownerId` 'human' = the owner, or a person's per_… id)
// from day one, although this build serves the owner only. Plus the task fields My day adds (estimate,
// window, preparation) and the results of planning and the morning briefing.
// Owns: these shapes and their small limits. Never: behaviour (runtime/calendar/*, runtime/day/*), task text
// copies, or secrets (an ICS address or a refresh token lives in the vault; a source keeps only its handle).

export type CalendarEventKind = 'event' | 'todo'; // 'todo' = a time block of a task (taskId set)
export const CALENDAR_EVENT_KINDS: readonly CalendarEventKind[] = ['event', 'todo'];
/** Who placed it: 'person' = pinned (the planner never moves it), the planner, an agent, a source sync. */
export type CalendarSetBy = 'person' | 'planner' | 'agent' | 'sync';
export const CALENDAR_SET_BY: readonly CalendarSetBy[] = ['person', 'planner', 'agent', 'sync'];
/** 'cut' = ended early when its task was checked off during the block. */
export type CalendarEventState = 'planned' | 'done' | 'cut';
export const CALENDAR_EVENT_STATES: readonly CalendarEventState[] = ['planned', 'done', 'cut'];

export interface CalendarEvent {
  id: string;
  ownerId: string; // 'human' (owner) or per_… – keyed by member from day one
  kind: CalendarEventKind;
  taskId?: string;
  title?: string; // events only; todo blocks have NO title (read from the task)
  notes?: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  tz?: string;
  sourceId: string; // 'local' or a calendar_sources id
  externalId?: string;
  etag?: string;
  setBy: CalendarSetBy; // 'person' = pinned: planner never moves it
  state: CalendarEventState;
  readOnly?: boolean; // from an ICS/Google read-only source
  createdBy: string;
  rev: number;
  createdAt: number;
  updatedAt: number;
}

/** The id of the local calendar (CalendarEvent.sourceId of everything made in the app). */
export const LOCAL_SOURCE_ID = 'local';

export type CalendarSourceKind = 'ics' | 'google';
export const CALENDAR_SOURCE_KINDS: readonly CalendarSourceKind[] = ['ics', 'google'];
export type CalendarSourceStatus = 'ok' | 'error' | 'reconnect' | 'syncing';

export interface CalendarSource {
  id: string;
  ownerId: string;
  kind: CalendarSourceKind;
  label: string;
  color?: string;
  visible: boolean;
  writable: boolean;
  status: CalendarSourceStatus;
  error?: string;
  lastSyncAt?: number;
  pcDeviceId?: string; // google: the one PC that writes
}

/** A planned run of an agent's schedule inside the listed window (computed, never stored). */
export interface AgentRun {
  scheduleId: string;
  agentId: string;
  title: string;
  at: number;
}

/** calendar.list: the window's rows, the agents' runs (the optional lane), the zone all day math uses, sources not synced for > 24 h. */
export interface CalendarList {
  events: CalendarEvent[];
  agentRuns: AgentRun[];
  tz: string;
  staleSources: string[];
}

/** calendar.add: a click into a free slot with typed or dictated text ('auto': the text decides event or to-do; default to-do). */
export type CalendarAddKind = 'auto' | 'todo' | 'event';
export const CALENDAR_ADD_KINDS: readonly CalendarAddKind[] = ['auto', 'todo', 'event'];
export interface CalendarAddInput {
  text: string;
  startAt: number;
  endAt?: number;
  kind?: CalendarAddKind;
  clientId?: string;
}

// ---------------------------------------------------------------- task fields of My day

/** Where a to-do's estimate came from: said in the text > the person's correction > learned > model > the default 30 min. */
export type EstimateSource = 'said' | 'person' | 'learned' | 'model' | 'default';
export const ESTIMATE_SOURCES: readonly EstimateSource[] = ['said', 'person', 'learned', 'model', 'default'];
/** The estimate when nothing else is known (minutes). */
export const DEFAULT_ESTIMATE_MIN = 30;

/** When a to-do can be done: 'HH:MM' bounds, local weekdays (0 = Sunday), one local day 'YYYY-MM-DD' – all in the profile zone. */
export interface TaskWindow {
  notBefore?: string;
  notAfter?: string;
  days?: number[];
  date?: string;
}

/** An agent's preparation of a person's to-do (todos.prepare), shown by the host as "Prepared by …"; never a completion. */
export interface TaskPrep {
  byAgentId: string;
  note: string; // ≤ TASK_PREP_LIMITS.note
  links?: Array<{ label: string; url: string }>; // ≤ TASK_PREP_LIMITS.links
  at: number;
}
export const TASK_PREP_LIMITS = Object.freeze({ note: 600, links: 5, label: 80, url: 2000 });

// ---------------------------------------------------------------- planning and the morning briefing

export type DayPlanMode = 'plan' | 'replan';
export const DAY_PLAN_MODES: readonly DayPlanMode[] = ['plan', 'replan'];
export type FocusAction = 'start' | 'stop';
export const FOCUS_ACTIONS: readonly FocusAction[] = ['start', 'stop'];

export interface DayPlanResult {
  date: string;
  placed: string[]; // event ids
  moved: string[];
  unplanned: Array<{ taskId: string; reason: string }>;
  staleSources: string[];
}

export interface Briefing {
  ownerId: string;
  date: string;
  at: number;
  lines: string[]; // ≤3 short sentences (helper model, from titles/counts only) – may be []
  doneTaskIds: string[];
  preparedTaskIds: string[];
  waitingToStart: number;
  planned: number;
  needsYou: number;
  chats: Array<{ conversationId: string; reason: string }>; // reason ≤ BRIEFING_LIMITS.reason
  /** B-059: when the PC slept since last evening while agent work waited (runtime/day/keep-awake.ts); absent on older rows. */
  slept?: SleepSpan[];
}
/** B-059: one sleep of the PC (suspend → resume, epoch ms). */
export interface SleepSpan { from: number; to: number }
export const BRIEFING_LIMITS = Object.freeze({ lines: 3, chats: 5, reason: 80 });

// ---------------------------------------------------------------- B-078 (D20): a person's calendar on their page

/** One entry of a person's calendar as their page shows it (titles masked where they are private there). */
export interface PersonCalendarEntry { title: string; startAt: number; endAt: number; allDay?: true; kind: 'event' | 'to-do' }

/** calendar.person: what the owner sees of a person's next days – from their PC (calendar.ask) or this one. */
export interface PersonCalendar {
  /** false: no calendar of theirs is reachable now; `note` says why (offline, none connected). */
  reachable: boolean;
  note?: string;
  /** The person's zone (their PC's). */
  tz?: string;
  entries: PersonCalendarEntry[];
}

declare module '../api/methods.ts' {
  interface Methods {
    /** Owner: a person's (per_…) calendar for [from, to) (at most 14 days) – asked on their own PC when it is linked here. */
    'calendar.person': { params: { id: string; from: number; to: number }; result: PersonCalendar };
  }
}

/** A local calendar day 'YYYY-MM-DD' that exists (2026-02-30 does not). */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
