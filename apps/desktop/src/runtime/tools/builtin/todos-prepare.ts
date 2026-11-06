// todos.prepare (B-041): an agent – the person's assistant above all – prepares one of the person's to-dos so their
// part takes minutes: a short note (opening hours, what to bring, the next step), up to 5 links and when it can be
// done (Task.window, the planner's input). The host renders it as "Prepared by …" (Task.prep, plain text – never
// markup); a newer preparation replaces the older one. A window the person set stays theirs (only the agent that set
// the current preparation's window may change it).
// Owns: this tool. Never: writes anything but prep and window, or treats a note as an instruction.

import { isLocalDate, type TaskPrep, type TaskWindow } from '../../../shared/model/calendar.ts';
import type { TaskView } from '../../../shared/model/tasks.ts';
import { canReadTask } from '../../tasks/access.ts';
import type { ToolDef, ToolOutput } from '../types.ts';
import { failure, json } from '../types.ts';
import { defineTool, internal } from './util.ts';

export const PREP_NOTE_CHARS = 600;
export const PREP_LINKS = 5;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

type WindowArgs = { notBefore?: string; notAfter?: string; days?: number[]; date?: string };

/** The window as stored, or the reason it is invalid. */
export function windowOf(args: WindowArgs): TaskWindow | string {
  const out: TaskWindow = {};
  for (const key of ['notBefore', 'notAfter'] as const) {
    const value = args[key]?.trim();
    if (value === undefined || value === '') continue;
    if (!CLOCK.test(value)) return `${key} must be a time like "09:30".`;
    out[key] = value;
  }
  if (out.notBefore && out.notAfter && out.notBefore >= out.notAfter) return 'notBefore must be earlier than notAfter.';
  if (args.days?.length) out.days = [...new Set(args.days)].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
  if (args.days?.length && !out.days?.length) return 'days are 0 (Sunday) to 6 (Saturday).';
  if (args.date) {
    if (!isLocalDate(args.date)) return 'date must be a day like "2026-10-27".';
    out.date = args.date;
  }
  return Object.keys(out).length ? out : 'An empty window says nothing; leave it out.';
}

/** The links as stored (http/https only, trimmed labels), or the reason one is invalid. */
export function linksOf(links: Array<{ label: string; url: string }>): TaskPrep['links'] | string {
  const out: NonNullable<TaskPrep['links']> = [];
  for (const link of links) {
    let url: URL;
    try { url = new URL(link.url.trim()); } catch { return `Not a link: ${link.url.slice(0, 80)}`; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Links must start with https:// or http://.';
    if (url.username || url.password) return 'Links must not carry a user name or password.';
    out.push({ label: link.label.replace(/\s+/g, ' ').trim().slice(0, 80) || url.hostname, url: url.toString() });
  }
  return out;
}

const prepareTodo = defineTool<{ taskId: string; note: string; links?: Array<{ label: string; url: string }>; window?: WindowArgs }>({
  name: 'todos.prepare',
  description: 'Prepare one of the person\'s to-dos so their part takes minutes: a short note (opening hours, what to bring, the next step), '
    + 'up to 5 links and when it can be done (window: notBefore/notAfter "HH:MM", days 0=Sunday…6, date "YYYY-MM-DD" – e.g. the opening hours). '
    + 'Shown on the to-do as "Prepared by <my name>"; a newer preparation replaces mine. It never completes, moves or reassigns the to-do: the person does it.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', minLength: 1, maxLength: 100 },
      note: { type: 'string', minLength: 1, maxLength: PREP_NOTE_CHARS },
      links: {
        type: 'array', maxItems: PREP_LINKS,
        items: { type: 'object', properties: { label: { type: 'string', maxLength: 80 }, url: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['label', 'url'], additionalProperties: false },
      },
      window: {
        type: 'object', additionalProperties: false,
        properties: { notBefore: { type: 'string' }, notAfter: { type: 'string' }, days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, maxItems: 7 }, date: { type: 'string' } },
      },
    },
    required: ['taskId', 'note'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Prepare to-do ${args.taskId}`, args.taskId),
  async run(args, ctx) {
    const task = ctx.services.tasks.get(args.taskId);
    if (!task || !canReadTask(ctx.services, ctx.agent.id, task)) return failure(`Task ${args.taskId} not found.`);
    const refused = refusal(task);
    if (refused) return refused;
    const note = args.note.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, PREP_NOTE_CHARS);
    if (!note) return failure('The note is empty.');
    const links = linksOf((args.links ?? []).slice(0, PREP_LINKS));
    if (typeof links === 'string') return failure(links);
    const window = args.window ? windowOf(args.window) : undefined;
    if (typeof window === 'string') return failure(window);
    // A window the person set stays theirs; the agent behind the current preparation may correct its own.
    const mayWindow = window !== undefined && (!task.window || task.prep?.byAgentId === ctx.agent.id);
    const prep: TaskPrep = { byAgentId: ctx.agent.id, note, ...(links?.length ? { links } : {}), at: ctx.services.clock.now() };
    const view = ctx.services.tasks.update(task.id, { prep, ...(mayWindow ? { window } : {}) }, ctx.agent.id);
    return json({ ok: true, taskId: view.id, prepared: true, ...(window && !mayWindow ? { window: 'kept – the person set it' } : {}) });
  },
});

/** Why this task cannot be prepared; undefined when it can. */
function refusal(task: TaskView): ToolOutput | undefined {
  if (task.assigneeKind !== 'human') return failure(`Task ${task.id} is not a to-do of the person. Work on it with the task tools instead.`);
  if (task.status === 'done' || task.status === 'cancelled') return failure(`Task ${task.id} is finished already.`);
  return undefined;
}

export const todosPrepareTools: ToolDef[] = [prepareTodo];
