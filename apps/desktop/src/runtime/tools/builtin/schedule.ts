// Schedule tools: agents think ahead – visible scheduled posts, private reminders and
// recurring routines (e.g. "answer YouTube comments in 24 h, then weekly ×4"). A scheduled
// message has a level like chat.send (B-050 K4/K10: 'important' – posted as important, T11 `urgent`
// stays as its older name –, or 'silent': in the history without unread or notification, payload.silent;
// schedules/fire.ts posts it so). B-044: one `when` shape
// for all of them ({ once } or { repeat: every | times | cron … }, schedules/when.ts), times without
// a zone in the profile time zone, schedules.update (pause, resume, new when, words, a routine's notes or level; a schedule the
// person paused stays paused until the person resumes it – the scheduler refuses) and every result
// echoes the rule and the next runs so the agent can check itself. The quiet "Scheduled"
// chat line comes from the scheduler (schedules/fire.ts announceCreated), once. B-054: only a scheduled message
// is posted in a chat; a routine is handed over in the run's chat or chatId when the agent is in it (util.ts chatIfAny),
// else its tasks are chat-free; reminders stay chat-free.
// Owns: schedules.message, schedules.remind, schedules.routine, schedules.update, schedules.list,
// schedules.cancel. Never: changes or cancels schedules of others it does not manage (or the
// person's); never creates hidden recurring work (every schedule is listed and cancellable by the human).

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json, text } from '../types.ts';
import type { Schedule } from '../../../shared/model/tasks.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { MessageLevel } from '../../../shared/model/chat.ts';
import { chatIfAny, clip, defineTool, internal, readChat, resolveChat } from './util.ts';
import { previewTimes } from '../../schedules/preview.ts';
import { WHEN_SCHEMA, isoIn, ruleWords, specFromWhen, type WhenArgs } from '../../schedules/when.ts';

interface When { when: WhenArgs }

const LEVEL = { type: 'string', enum: ['normal', 'important', 'silent'] };

/** A scheduled message's payload fields for `level` (else the older `urgent`): priority 'important', or silent; none for normal. */
function loudness(level: MessageLevel | undefined, urgent?: boolean): Pick<Schedule['payload'], 'priority' | 'silent'> {
  const chosen = level ?? (urgent ? 'important' : 'normal');
  return chosen === 'important' ? { priority: 'important' } : chosen === 'silent' ? { silent: true } : {};
}

function profileZone(ctx: ToolContext): string | undefined {
  return ctx.services.settings.get().profile.timezone || undefined;
}

/** The tool's `when` → a spec (or an error line), in the profile zone. */
function specOf(args: When, ctx: ToolContext) {
  return specFromWhen(args.when, ctx.services.clock.now(), profileZone(ctx));
}

/** What every result echoes: id, rule, state and the next three runs as the scheduler takes them. */
function summary(schedule: Schedule, ctx: ToolContext) {
  let next: string[] = [];
  if (schedule.active && schedule.nextAt !== undefined) {
    const spec = schedule.spec.everyMs !== undefined && schedule.spec.at === undefined ? { ...schedule.spec, at: schedule.nextAt } : schedule.spec;
    try {
      next = previewTimes(spec, ctx.services.clock.now(), { runs: schedule.runs }).map((at) => isoIn(at, schedule.spec.tz));
    } catch { next = [isoIn(schedule.nextAt, schedule.spec.tz)]; }
  }
  return { ok: true, scheduleId: schedule.id, kind: schedule.kind, active: schedule.active, ...(schedule.pausedBy === HUMAN_ID ? { pausedBy: 'person' } : {}), rule: ruleWords(schedule.spec), next };
}

function describeSchedule(schedule: Schedule, ctx: ToolContext): string {
  const important = schedule.payload.silent ? ', silent' : schedule.payload.priority === 'important' ? ', important' : '';
  const next = schedule.nextAt !== undefined && schedule.active ? ` · next ${isoIn(schedule.nextAt, schedule.spec.tz)}` : '';
  const owner = schedule.ownerId === ctx.agent.id ? '' : ` · of ${ctx.services.org.get(schedule.ownerId)?.name ?? schedule.ownerId}`;
  // B-072: a routine's words are its task notes too – a manager tidying a rule must see where it stands
  const notes = schedule.kind === 'routine' && schedule.payload.taskTemplate?.notes ? `\n  notes: ${clip(schedule.payload.taskTemplate.notes, 400)}` : '';
  return `${schedule.id} [${schedule.kind}${important}${schedule.active ? '' : schedule.pausedBy === HUMAN_ID ? ', paused by the person' : ', paused'}] ${schedule.title} · ${ruleWords(schedule.spec)}${next}${owner}${notes}`;
}

/** The same rule as cancel: the agent's own schedules or those of agents it manages – never the person's. */
function mayChange(schedule: Schedule, ctx: ToolContext): boolean {
  return schedule.ownerId === ctx.agent.id || (schedule.ownerId !== HUMAN_ID && ctx.services.org.canManage(ctx.agent.id, schedule.ownerId));
}

const scheduleMessage = defineTool<When & { chatId?: string; text: string; mentions?: string[]; title?: string; level?: MessageLevel; urgent?: boolean }>({
  name: 'schedules.message',
  description: 'Post a message into a chat later (once or recurring), exactly as if written then. level as in chat.send: "important" (a push: what the person would surely want to hear at once) or "silent" (in the history without unread or notification; only mentioned members are reached). urgent: older name of level "important".',
  inputSchema: { type: 'object', properties: { chatId: { type: 'string' }, text: { type: 'string', minLength: 1 }, mentions: { type: 'array', items: { type: 'string' } }, title: { type: 'string', maxLength: 120 }, level: LEVEL, urgent: { type: 'boolean' }, when: WHEN_SCHEMA }, required: ['text', 'when'], additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal(`Schedule a message: ${clip(args.text, 60)}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const conversationId = resolveChat(ctx, args.chatId);
    const spec = specOf(args, ctx);
    if (typeof spec === 'string') return failure(spec);
    const schedule = ctx.services.scheduler.create({ ownerId: ctx.agent.id, conversationId, taskId: ctx.taskId, kind: 'message', title: args.title ?? clip(args.text, 60), spec, payload: { body: args.text, mentions: args.mentions, ...loudness(args.level, args.urgent) } });
    return json(summary(schedule, ctx));
  },
});

const remindMe = defineTool<When & { note: string; taskId?: string; chatId?: string }>({
  name: 'schedules.remind',
  description: 'Private reminder: at that time I get a turn with my own note (no chat post).',
  inputSchema: { type: 'object', properties: { note: { type: 'string', minLength: 1, maxLength: 4000 }, taskId: { type: 'string' }, chatId: { type: 'string' }, when: WHEN_SCHEMA }, required: ['note', 'when'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`Reminder: ${clip(args.note, 60)}`),
  async run(args, ctx) {
    const spec = specOf(args, ctx);
    if (typeof spec === 'string') return failure(spec);
    const conversationId = args.chatId ? resolveChat(ctx, args.chatId) : ctx.conversationId;
    const schedule = ctx.services.scheduler.create({ ownerId: ctx.agent.id, conversationId, taskId: args.taskId ?? ctx.taskId, kind: 'reminder', title: clip(args.note, 60), spec, payload: { note: args.note } });
    return json(summary(schedule, ctx));
  },
});

const TASK_SCHEMA = {
  type: 'object', required: ['title'], additionalProperties: false, // bounded like tasks.create (fire.ts bounds stored ones again)
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 300 }, notes: { type: 'string', maxLength: 20_000 }, mode: { type: 'string', maxLength: 60 },
    steps: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 }, maxItems: 50 },
  },
};

const createRoutine = defineTool<When & { title: string; task: { title: string; notes?: string; mode?: string; steps?: string[] }; chatId?: string }>({
  name: 'schedules.routine',
  description: 'Recurring or one-off follow-up job; each firing creates a tracked task for me (e.g. answer comments daily for 4 weeks). Needs no chat: its tasks are handed over in this run\'s chat or chatId, else they stand on their own.',
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, chatId: { type: 'string' }, task: TASK_SCHEMA, when: WHEN_SCHEMA },
    required: ['title', 'task', 'when'], additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => internal(`Routine: ${clip(args.title, 60)}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const conversationId = chatIfAny(ctx, args.chatId); // B-054: undefined – each firing creates a chat-free task
    const spec = specOf(args, ctx);
    if (typeof spec === 'string') return failure(spec);
    const schedule = ctx.services.scheduler.create({ ownerId: ctx.agent.id, ...(conversationId ? { conversationId } : {}), taskId: ctx.taskId, kind: 'routine', title: args.title, spec, payload: { taskTemplate: args.task } });
    return json(summary(schedule, ctx));
  },
});

const updateSchedule = defineTool<{ scheduleId: string; paused?: boolean; when?: WhenArgs; text?: string; notes?: string; title?: string; level?: MessageLevel }>({
  name: 'schedules.update',
  description: 'Change one of my schedules (or one of an agent I manage): paused true/false pauses or resumes it (one the person paused only they resume), when sets new timing, text the words (message text, reminder note, routine task title), notes a routine task\'s notes (all of them, "" clears), level a scheduled message\'s level.',
  inputSchema: {
    type: 'object',
    properties: { scheduleId: { type: 'string' }, paused: { type: 'boolean' }, when: WHEN_SCHEMA, text: { type: 'string', minLength: 1, maxLength: 4000 }, notes: { type: 'string', maxLength: 20_000 }, title: { type: 'string', minLength: 1, maxLength: 120 }, level: LEVEL },
    required: ['scheduleId'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Change schedule ${args.scheduleId}`, args.scheduleId),
  async run(args, ctx) {
    const schedule = ctx.services.scheduler.get(args.scheduleId);
    if (!schedule) return failure('Schedule not found.');
    if (!mayChange(schedule, ctx)) return failure('Only the owner or its manager can change this schedule.');
    if (args.paused === undefined && !args.when && args.text === undefined && args.notes === undefined && args.title === undefined && !args.level) return failure('Give paused, when, text, notes, title or level.');
    if (args.level && schedule.kind !== 'message') return failure('Only a scheduled message has a level.');
    if (args.notes !== undefined && schedule.kind !== 'routine') return failure('Only a routine has task notes; a message or reminder changes with text.');
    const patch: Parameters<ToolContext['services']['scheduler']['update']>[1] = {};
    if (args.when) {
      const spec = specOf({ when: args.when }, ctx);
      if (typeof spec === 'string') return failure(spec);
      patch.spec = spec;
    }
    if (args.text !== undefined) {
      if (schedule.kind === 'message') patch.payload = { body: args.text };
      else if (schedule.kind === 'reminder') patch.payload = { note: args.text };
      else if (schedule.kind === 'routine') patch.payload = { taskTemplate: { ...(schedule.payload.taskTemplate ?? { title: schedule.title }), title: clip(args.text, 300) } };
      else return failure('A timer has no text to change.');
      if (schedule.kind !== 'routine' && args.title === undefined) patch.title = clip(args.text, 60);
    }
    if (args.notes !== undefined) {
      const template = { ...(patch.payload?.taskTemplate ?? schedule.payload.taskTemplate ?? { title: schedule.title }) };
      if (args.notes) template.notes = args.notes; else delete template.notes;
      patch.payload = { ...patch.payload, taskTemplate: template };
    }
    if (args.level) patch.payload = { ...patch.payload, priority: undefined, silent: undefined, ...loudness(args.level) }; // the old level goes
    if (args.title !== undefined) patch.title = args.title;
    if (args.paused !== undefined) patch.active = !args.paused;
    try {
      return json(summary(ctx.services.scheduler.update(schedule.id, patch, ctx.agent.id), ctx));
    } catch (error) {
      if (error instanceof WorkforceError) return failure(error.message); // e.g. a schedule the person paused
      throw error;
    }
  },
});

const listSchedules = defineTool<{ chatId?: string; mine?: boolean }>({
  name: 'schedules.list',
  description: 'List scheduled messages, reminders and routines: of a chat (chatId), only mine (mine=true), else mine and those of the agents I manage – with a routine\'s task notes.',
  inputSchema: { type: 'object', properties: { chatId: { type: 'string' }, mine: { type: 'boolean' } }, additionalProperties: false },
  category: 'read',
  describe: () => internal('List schedules'),
  async run(args, ctx) {
    if (args.chatId) resolveChat(ctx, args.chatId, { read: true });
    const schedules = args.chatId ? ctx.services.scheduler.list({ conversationId: args.chatId, ownerId: args.mine ? ctx.agent.id : undefined })
      : args.mine ? ctx.services.scheduler.list({ ownerId: ctx.agent.id })
        : ctx.services.scheduler.list().filter((schedule) => mayChange(schedule, ctx)); // B-072: a manager sees its team's
    return text(schedules.length ? schedules.map((schedule) => describeSchedule(schedule, ctx)).join('\n') : 'No schedules.');
  },
});

const cancelSchedule = defineTool<{ scheduleId: string }>({
  name: 'schedules.cancel',
  description: 'Cancel one of my schedules (or one of an agent I manage).',
  inputSchema: { type: 'object', properties: { scheduleId: { type: 'string' } }, required: ['scheduleId'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`Cancel schedule ${args.scheduleId}`, args.scheduleId),
  async run(args, ctx) {
    const schedule = ctx.services.scheduler.get(args.scheduleId);
    if (!schedule) return failure('Schedule not found.');
    if (!mayChange(schedule, ctx)) return failure('Only the owner or its manager can cancel this schedule.');
    ctx.services.scheduler.remove(schedule.id);
    return json({ ok: true });
  },
});

export const scheduleTools: ToolDef[] = [scheduleMessage, remindMe, createRoutine, updateSchedule, listSchedules, cancelSchedule];
