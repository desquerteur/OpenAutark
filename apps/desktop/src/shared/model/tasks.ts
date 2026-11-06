// Task model ("simplified Asana"), human to-dos with adaptive widgets, and schedules.
// Owns: shapes for tasks, steps, results/evidence, schedules.
// B-054 (owner 29.10.2026): a task is its own row; `conversationId` is the chat it was handed over in, if any
// (its anchor message); references in other chats are task messages (messages.task_id). A chat-free task keeps
// its own `spaceId` and `origin`.
// Never: a second task world – the board, the "My day" list, the PWA and the phone are queries over these rows.

import type { UiBlock } from '../blocks/catalog.ts';
import type { EstimateSource, TaskPrep, TaskWindow } from './calendar.ts';
import type { Origin } from './origin.ts';

export type TaskStatus =
  | 'open' // nobody works on it yet (team/manager will claim)
  | 'working' // an owner is actively on it
  | 'waiting' // waiting on someone/something (see waitingOn)
  | 'needs_you' // a decision/action of the human is required
  | 'blocked' // cannot continue; precise blocker recorded
  | 'done'
  | 'cancelled';

export type AssigneeKind = 'team' | 'agent' | 'human';

/** Why something lands on the human's list. Agents may not hand computer work to the human. */
export type HumanReason =
  | 'physical' // presence, recording, camera, real-world errand
  | 'identity' // ID check, legal signature, KYC
  | 'credential' // 2FA / secret only the human holds
  | 'approval' // the host's own yes (access requests) and older rows – B-078: agents decide their own (human.ask has no 'approval')
  | 'taste' // personal decision or preference
  | 'review'; // the human wants to look at a result

export type Verification = 'reported_by_human' | 'claimed_by_agent' | 'verified';

export interface Evidence {
  kind: 'file' | 'link' | 'tool' | 'check' | 'note' | 'screenshot';
  label: string;
  ref?: string; // file id, url, run item id …
}

export interface TaskResult {
  summary: string; // "Done: …"
  alsoHandled?: string[]; // proactive extras ("Also handled: …")
  evidence: Evidence[];
  followUps?: Array<{ scheduleId?: string; taskId?: string; label: string }>;
  verification: Verification;
  answer?: unknown; // structured answer from a human widget (record/choice/form …)
  /** Addition (T01): why a claimed result is not 'verified' ("Not independently checked: …",
   *  "Verifier still disagrees: …"). Shown as one muted line under the result. */
  verificationNote?: string;
  /** Addition (B-059): the agent finished it quietly (tasks.complete notify:false) – no 'Done' notice to anyone (tasks/complete.ts). */
  quiet?: true;
}

/** What the owner keeps about a task across turns (tasks/ownership.ts writes tried/stalls/nextCheckAt). */
export interface TaskLedger {
  plan?: string[]; // the steps the owner intends (tasks.update plan)
  facts?: string[]; // lines learned, kept across turns and handoffs
  tried?: Array<{ approach: string; outcome: string; at: number }>; // the latest turns (at most 20)
  stalls?: number; // turns in a row that did not move the task (the follow-up pauses double)
  lastProgressAt?: number;
  nextCheckAt?: number; // the planned follow-up (a restart keeps it)
  /** Legacy rows only (the removed escalation ladder); nothing writes it. */
  escalation?: 'none' | 'other_approach' | 'stronger_model' | 'manager' | 'human';
  doneCount?: number; // how often the person ticked off a repeating to-do (its author hears only the first)
  cancelledBy?: string; // who cancelled it
}

export interface Task {
  id: string;
  conversationId?: string; // B-054: the chat it was handed over in; absent = a chat-free task (To-do area, mail, routine …)
  messageId?: string; // anchor message (kind 'task') in its chat; steps and chat-free tasks have none
  parentId?: string; // set for checklist steps / subtasks
  title: string; // the goal, short
  notes: string; // details (markdown)
  status: TaskStatus;
  assigneeKind: AssigneeKind;
  assigneeId?: string; // agent id when assigneeKind === 'agent'
  createdBy: string; // 'human' or agent id
  priority: 0 | 1 | 2; // 0 normal, 1 high, 2 urgent
  dueAt?: number;
  goal?: string; // goal ancestry: why this exists (parent goal text)
  doneWhen?: string; // acceptance criteria (checked once by the verifier, tasks/verification.ts)
  dependsOn?: string[]; // the tasks this one comes after: it waits on them, its owner is woken after the last (tasks/depends.ts)
  mode?: string; // mode the work needs (video, web, computer …)
  widget?: UiBlock; // adaptive UI for human to-dos (ask block from the catalog)
  humanReason?: HumanReason;
  /** `ids` (addition T03): every child task still waited on when there are several (kind 'task';
   *  `id` is the latest). tasks/transitions.ts resumes the task after the last one. `until`
   *  (addition INT-1): when a snoozed to-do rings again (kind 'schedule', its pending ring; set by
   *  tasks/human.ts snooze); kept in step when the person pauses, resumes or deletes that ring
   *  (tasks/timers.ts snoozeChanged); absent while it is paused or gone and on a snooze that
   *  recorded no end (shared/model/todo-later.ts). */
  waitingOn?: { kind: 'human' | 'agent' | 'external' | 'schedule' | 'task'; id?: string; ids?: string[]; reason: string; since: number; until?: number };
  result?: TaskResult;
  ledger: TaskLedger;
  attempts: number;
  sort: number;
  rev: number; // optimistic concurrency counter
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Who last gave the task its owner – assign()'s `by`, the agent itself on claim(). An agent assigner other than
   *  the owner hears once when it is done (tasks/lifecycle.ts). */
  assignedBy?: string;
  // Additions (B-041, My day – shared/model/calendar.ts; written through day.* / todos.prepare, tasks/patch-fields.ts):
  estimateMin?: number; // minutes the person needs (human to-dos)
  estimateSource?: EstimateSource;
  spentMs?: number; // accumulated focus-timer time
  timerStartedAt?: number; // focus timer running since (epoch ms)
  window?: TaskWindow; // when it can be done
  prep?: TaskPrep; // host-rendered preparation by an agent
  private?: boolean; // "Only me": no AI help, no assistant notice, hidden from agents' To-do-list read rule
  // Additions (B-054, migration 082):
  spaceId?: string; // set only on a chat-free task; a task with a chat gets its space from that chat
  origin?: Origin; // why it exists (runtime-written); absent on rows from before B-054 that had a chat
}

/** A task with its steps and progress, as rendered in chats and the board. */
export interface TaskView extends Task {
  steps: Task[];
  progress: { done: number; total: number };
  conversationTitle: string; // '' when the task has no chat
  running: boolean; // a turn is currently running for this task
}

export interface TaskFilter {
  conversationId?: string;
  status?: TaskStatus[];
  assigneeKind?: AssigneeKind;
  assigneeId?: string;
  spaceId?: string;
  search?: string;
  includeSteps?: boolean;
  limit?: number;
  /**
   * Added by R3-U2: only tasks finished (done/cancelled) at or after this epoch ms
   * (`completed_at >= ?`). Lets "Recently done" views load a small window instead of the
   * oldest finished tasks first.
   */
  completedSince?: number;
  /** Runtime only (agents' task tools, never an RPC param): only tasks this agent may read (tasks/access.ts readableSql). */
  readableBy?: string;
}

export interface CreateTaskInput {
  conversationId?: string; // B-054: the chat to hand it over in; absent = a chat-free task
  origin?: Origin; // B-054: why it exists (runtime code only – never taken from an agent's or a person's input)
  spaceId?: string; // B-054: runtime only – a chat-free task's space (a quick task's chosen space); ignored with a chat
  title: string;
  notes?: string;
  steps?: string[]; // checklist lines
  assigneeKind?: AssigneeKind;
  assigneeId?: string;
  dueAt?: number;
  priority?: Task['priority'];
  doneWhen?: string;
  dependsOn?: string[];
  mode?: string;
  parentId?: string;
  widget?: UiBlock;
  humanReason?: HumanReason;
  clientId?: string;
  // Additions (B-041, My day): as on Task.
  estimateMin?: number;
  estimateSource?: EstimateSource;
  spentMs?: number;
  timerStartedAt?: number;
  window?: TaskWindow;
  prep?: TaskPrep;
  private?: boolean;
}

// ---------------------------------------------------------------- schedules

export type ScheduleKind =
  | 'message' // a visible chat message sent at the given time (as if typed then)
  | 'reminder' // an agent's own reminder: wakes the agent with a note to itself
  | 'routine' // recurring job: each fire creates a tracked task/run (e.g. answer comments)
  | 'timer'; // a human timer/reminder widget (rings on desktop/phone)

export interface ScheduleSpec {
  at?: number; // one-off epoch ms; with cron / times "not before", with everyMs the interval's anchor
  cron?: string; // 5-field cron (croner syntax)
  everyMs?: number; // fixed interval (>= 60_000 unless kind 'timer')
  times?: string[]; // B-044: clock times each local day ("09:00", "13:30"; 1–24, in `tz`) – several times a day without cron
  tz?: string; // IANA zone; default OS zone
  until?: number;
  maxRuns?: number;
  except?: string[]; // YYYY-MM-DD dates to skip
  days?: number[]; // only fire on these local weekdays (0 Sunday … 6 Saturday, in `tz`)
  window?: { from: string; to: string }; // only fire between HH:MM and HH:MM
  catchUp?: 'once' | 'all' | 'skip'; // what to do with fires missed while the PC was off
}

export interface Schedule {
  id: string;
  ownerId: string; // 'human' or agent id
  conversationId?: string;
  taskId?: string;
  kind: ScheduleKind;
  title: string; // shown as a small chip ("Answer YouTube comments · daily 18:00")
  spec: ScheduleSpec;
  payload: { body?: string; note?: string; mentions?: string[]; taskTemplate?: { title: string; notes?: string; mode?: string }; priority?: 'normal' | 'important'; silent?: boolean; ultra?: true }; // silent (B-050 K4): a quiet scheduled message; ultra (B-057): Ultra suggested for it
  nextAt?: number;
  lastAt?: number;
  runs: number;
  active: boolean;
  pausedBy?: string; // B-044: who paused it ('human' or an agent id); only the person resumes what the person paused
  createdAt: number;
}

// ---------------------------------------------------------------- mini-app to-dos (addition F01)

/**
 * The widget of a to-do an agent programmed itself (an ```app todo=true fence): it points back at
 * the fence – the message stays the only copy of the app's HTML – and is no catalog block (never
 * validated as an ask block, no "Show as…", no timer). Stored in the to-do's widget column.
 * `Task.widget` is still typed `UiBlock`; read it as a TodoWidget through
 * shared/blocks/app-todo.ts `appWidgetOf`.
 */
export interface AppTodoWidget {
  type: 'app';
  messageId: string; // the agent message that holds the fence
  index: number; // the fence's parse index (the chat's blockIndex)
  title?: string;
  permissions: string[]; // what the app may ask the person for (granted by them, once)
  expand?: boolean;
}

/** What a human to-do's widget column holds: a catalog ask block or a mini-app. */
export type TodoWidget = UiBlock | AppTodoWidget;

// ---------------------------------------------------------------- declined to-dos (addition F06)

/**
 * The answer that declines a to-do ("Can't do this…", todos.decline): exactly these keys. The cancelled to-do keeps it as `result.answer`.
 */
export interface DeclineAnswer {
  declined: true;
  reason?: string; // one line, why the person cannot or will not do it
}
