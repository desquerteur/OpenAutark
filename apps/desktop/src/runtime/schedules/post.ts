// What a person's scheduled post stores (messages.schedule, schedules.update – T11): a chat
// message (kind 'message': body, @mentions, its level – 'important', or B-050 K4 'silent': posted
// quietly, payload.silent) or, with "Post as task", a routine whose
// every firing posts a team task built like a typed /task – first line = title, "- " lines =
// checklist steps, the rest = notes. 'important' then makes the task High priority (fire.ts); a
// task post is never silent.
// Rewording keeps the kind: only the person's own message and task posts can be reworded.
// A task post keeps tasks.create's limits (refused when scheduled); a stored template – also an
// agent's raw routine `task` – is bounded again when it fires (boundedTemplate).
// Owns: body → { kind, title, payload }, the payload of a reworded post and the template bounds.
// Never: computes times, creates schedules or tasks, or rewords an agent's schedule.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { Schedule } from '../../shared/model/tasks.ts';

/** The level of a scheduled post (B-050 K4: the three message levels). */
export type PostPriority = 'normal' | 'important' | 'silent';
export const POST_PRIORITIES: readonly PostPriority[] = ['normal', 'important', 'silent'];

/** The stored task template plus checklist steps (T11; the shared payload type has no steps yet). */
export type TaskTemplate = NonNullable<Schedule['payload']['taskTemplate']> & { steps?: string[] };
type Payload = Schedule['payload'];

const STEP = /^\s*(?:[-*]|\d+[.)]|\[ \])\s+(.+)$/;
/** tasks.create's RPC limits (rpc/handlers/tasks.ts). */
export const TASK_LIMITS = { title: 300, notes: 50_000, steps: 100, step: 300, mode: 60 } as const;

/** Text → task template, as the composer's /task reads it (first non-empty line is the title). */
export function taskTemplateFrom(body: string): TaskTemplate {
  const lines = body.split(/\r?\n/);
  const first = Math.max(0, lines.findIndex((line) => line.trim()));
  const steps: string[] = [];
  const notes: string[] = [];
  for (const line of lines.slice(first + 1)) {
    const step = STEP.exec(line);
    if (step) steps.push(step[1].trim());
    else notes.push(line);
  }
  const template: TaskTemplate = { title: (lines[first] ?? '').trim() };
  const rest = notes.join('\n').trim();
  if (rest) template.notes = rest;
  if (steps.length) template.steps = steps;
  return template;
}

/** A new post of the person: a message, or (asTask) a routine posting a team task each time. */
export function scheduledPost(body: string, options: { mentions?: string[]; priority?: PostPriority; asTask?: boolean; ultra?: boolean } = {}): {
  kind: 'message' | 'routine'; title: string; payload: Payload;
} {
  const important = options.priority === 'important';
  if (options.asTask) {
    if (options.priority === 'silent') throw new WorkforceError('bad_request', 'A task post cannot be silent.', { details: { param: 'priority' } });
    const taskTemplate = withinLimits(taskTemplateFrom(body));
    const payload: Payload = { body, taskTemplate };
    if (important) payload.priority = 'important';
    return { kind: 'routine', title: excerpt(taskTemplate.title, 60), payload };
  }
  const payload: Payload = options.mentions?.length ? { body, mentions: options.mentions } : { body };
  if (important) payload.priority = 'important';
  if (options.priority === 'silent') payload.silent = true;
  if (options.ultra) payload.ultra = true; // B-057: Ultra suggested for this message (a rewording keeps it: the scheduler merges key by key)
  return { kind: 'message', title: excerpt(body, 60), payload };
}

/**
 * The title and payload patch of a reworded post. The scheduler merges payloads key by key, so
 * every key this owns is set (undefined drops it from the stored JSON).
 */
export function rewordPost(schedule: Schedule, change: { body?: string; priority?: PostPriority; mentions?: string[] }): { title: string; payload: Payload } {
  if (schedule.ownerId !== HUMAN_ID) {
    throw new WorkforceError('forbidden', 'Only your own scheduled posts can be reworded; the agent changes its own.', { details: { scheduleId: schedule.id } });
  }
  if (schedule.kind !== 'message' && schedule.kind !== 'routine') {
    throw new WorkforceError('bad_request', 'Only scheduled messages and task posts have a text to change.', { details: { scheduleId: schedule.id, kind: schedule.kind } });
  }
  const stored = schedule.payload;
  const body = change.body ?? stored.body ?? stored.taskTemplate?.title ?? schedule.title;
  const priority = change.priority ?? (stored.silent ? 'silent' : stored.priority);
  const next = scheduledPost(body, { mentions: change.mentions ?? stored.mentions, priority, asTask: schedule.kind === 'routine' });
  const payload: Payload = { ...next.payload, priority: priority === 'important' ? 'important' : undefined, silent: priority === 'silent' ? true : undefined };
  if (schedule.kind === 'message') payload.mentions = next.payload.mentions;
  else if (stored.taskTemplate?.mode) payload.taskTemplate = { ...next.payload.taskTemplate!, mode: stored.taskTemplate.mode };
  return { title: next.title, payload };
}

/** A task post the person schedules: refused (with the limit) where tasks.create would refuse it. */
function withinLimits(template: TaskTemplate): TaskTemplate {
  const refuse = (message: string, param: string) => { throw new WorkforceError('bad_request', message, { details: { param } }); };
  if (!template.title) refuse('A task post needs a title on its first line.', 'body');
  if (template.title.length > TASK_LIMITS.title) refuse(`The task title (first line) can have at most ${TASK_LIMITS.title} characters.`, 'body');
  if ((template.notes?.length ?? 0) > TASK_LIMITS.notes) refuse(`The task notes can have at most ${TASK_LIMITS.notes} characters.`, 'body');
  const steps = template.steps ?? [];
  if (steps.length > TASK_LIMITS.steps) refuse(`A task can have at most ${TASK_LIMITS.steps} checklist steps.`, 'body');
  if (steps.some((step) => step.length > TASK_LIMITS.step)) refuse(`Each checklist step can have at most ${TASK_LIMITS.step} characters.`, 'body');
  return template;
}

/**
 * A stored template made safe to create a task from at every run: only strings, cut to
 * tasks.create's limits, steps only as an array of non-empty strings (at most 100).
 */
export function boundedTemplate(raw: unknown, fallbackTitle: string): TaskTemplate {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const str = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
  const template: TaskTemplate = { title: str(o.title, TASK_LIMITS.title) ?? (fallbackTitle.trim().slice(0, TASK_LIMITS.title) || 'Routine') };
  const notes = typeof o.notes === 'string' ? o.notes.slice(0, TASK_LIMITS.notes) : undefined;
  if (notes) template.notes = notes;
  const mode = str(o.mode, TASK_LIMITS.mode);
  if (mode) template.mode = mode;
  const steps = Array.isArray(o.steps)
    ? o.steps.map((step) => str(step, TASK_LIMITS.step)).filter((step): step is string => step !== undefined).slice(0, TASK_LIMITS.steps)
    : [];
  if (steps.length) template.steps = steps;
  return template;
}
