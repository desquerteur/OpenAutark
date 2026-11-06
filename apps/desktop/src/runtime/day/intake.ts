// My day's own input (day.add – "I do this"): every non-empty line becomes the person's own chat-free to-do (origin
// 'todo-list') the way a typed to-do does (tasks/todo-draft.ts: title, notes, a plain "Done" widget) – no guessing of
// times or widgets. A clicked calendar slot gives it a block the person set (calendar.upsertBlock 'person'); typed
// while a later day is shown, it is for that day (Task.window.date). With "AI helps" on (settings.day.aiHelps, never
// for "Only me") the personal assistant hears of the new to-dos once (day/assistant.ts) – it can prepare them, and
// the person can always ask an agent in chat.
// Owns: that flow. Never: gives an item to anyone but the person, or calls a model in the request.

import { WorkforceError } from '../../shared/errors.ts';
import { DEFAULT_ESTIMATE_MIN } from '../../shared/model/calendar.ts';
import { ORIGINS } from '../../shared/model/origin.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import { localDate } from '../calendar/when.ts';
import { quickDraft } from '../tasks/todo-draft.ts';
import { wakeAssistant, type AssistantDeps } from './assistant.ts';
import { dayZone, daySettings } from './clock.ts';

export type IntakeDeps = AssistantDeps & Pick<RuntimeServices, 'settings' | 'log'> & Partial<Pick<RuntimeServices, 'calendar'>>;

/** `date`: the day My day shows (YYYY-MM-DD) – an item typed while a later day is shown is for that day. */
export interface DayAddInput { text: string; private?: boolean; clientId?: string; startAt?: number; endAt?: number; date?: string }

const MIN = 60_000;
const MAX_TEXT = 8000;
const MAX_ITEMS = 50;

export class DayIntake {
  private readonly s: IntakeDeps;
  constructor(s: IntakeDeps) { this.s = s; }

  /** Nothing runs in the background any more; kept for the day service's stop(). */
  stop(): void { /* nothing to end */ }

  async add(input: DayAddInput, by: string): Promise<{ tasks: TaskView[] }> {
    const s = this.s;
    const text = input.text.trim();
    if (!text) throw new WorkforceError('bad_request', 'Type what you want to do.');
    if (text.length > MAX_TEXT) throw new WorkforceError('bad_request', 'That is too long for My day.');
    const only = input.private === true;
    const slot = input.startAt !== undefined ? { startAt: input.startAt, endAt: input.endAt ?? input.startAt + DEFAULT_ESTIMATE_MIN * MIN } : undefined;
    const later = !slot && input.date && input.date > localDate(s.clock.now(), dayZone(s)) ? input.date : undefined;
    const lines = slot ? [text] : text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, MAX_ITEMS);
    const made = lines.map((line, index) => {
      const draft = quickDraft(s, line);
      return s.tasks.create({
        origin: ORIGINS.todoList, ...draft, assigneeKind: 'human', createdBy: by,
        ...(slot ? { estimateMin: Math.max(5, Math.round((slot.endAt - slot.startAt) / MIN)), estimateSource: 'said' as const } : {}),
        ...(later ? { window: { date: later } } : {}), ...(only ? { private: true } : {}),
        ...(input.clientId ? { clientId: `day:${input.clientId}#${index}` } : {}),
      });
    });
    if (slot && made[0]) this.block(made[0].id, slot.startAt, slot.endAt);
    if (daySettings(s).aiHelps && !only) wakeAssistant(s, by, made.map((task) => task.id), 'day:add');
    return { tasks: made.map((task) => s.tasks.get(task.id) ?? task) };
  }

  /** The person's block for a clicked slot (kept when the to-do has one already – a retry). */
  private block(taskId: string, startAt: number, endAt: number): void {
    const calendar = this.s.calendar;
    if (!calendar) return;
    try {
      if (!calendar.blocksFor([taskId]).has(taskId)) calendar.upsertBlock(taskId, startAt, Math.max(endAt, startAt + 5 * MIN), 'person');
    } catch (error) {
      this.s.log.warn('my day: no block for the clicked slot', { taskId, error: String(error) });
    }
  }
}
