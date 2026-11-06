// The composer's schedule mode (replaces the small "Send later" dialog): per chat, whether the composer is in it and the
// settings block's form (schedule-form.ts), kept in memory across chat navigation. "Schedule…" in the Plus menu and the
// Send button's right-click menu opens it; Esc or × leaves it. Scheduling posts the draft through messages.schedule
// (the draft's loudness and Ultra hint go along; the runtime writes the chat's quiet "Scheduled · …" line). Edit (the
// Chat details list's right-click menu) opens the mode on a scheduled message of the person: the draft shows its text
// while it is edited – what was in the field is kept aside and comes back when the mode ends – and Schedule changes it
// through schedules.update (the rule is sent only when the person changed it).
// Owns: the mode state and the two calls. Never: renders (ScheduleBar.tsx), builds specs (schedule-form.ts).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { ConversationSummary, MessageLevel } from '../../../shared/model/chat.ts';
import type { Schedule } from '../../../shared/model/tasks.ts';
import { rpc } from '../../lib/rpc.ts';
import { pushToast, toastError } from '../../lib/toasts.ts';
import { draftFor, setReply, updateDraft } from './draft.ts';
import { defaultForm, editableSchedule, formFromSpec, formKey, scheduleSpec } from './schedule-form.ts';
import type { ScheduleForm } from './schedule-form.ts';
import { mentionsIn } from './target.ts';

export interface ScheduleMode {
  form: ScheduleForm;
  /** Set while a scheduled message is edited: its id, the rule as it was opened, and the draft that was in the field. */
  edit?: { id: string; original: string; stash: { text: string; level: MessageLevel; ultra?: boolean } };
}

const modes = new Map<string, Signal<ScheduleMode | null>>();

export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The chat's mode (null = a normal composer). */
export function scheduleModeFor(conversationId: string): Signal<ScheduleMode | null> {
  let entry = modes.get(conversationId);
  if (!entry) { entry = signal<ScheduleMode | null>(null); modes.set(conversationId, entry); }
  return entry;
}

/** Switches the composer into schedule mode (nothing changes when it already is). */
export function openScheduleMode(conversationId: string, now = Date.now()): void {
  const entry = scheduleModeFor(conversationId);
  if (!entry.peek()) entry.value = { form: defaultForm(now, localZone()) };
}

/** Leaves the mode; the text of a new schedule stays in the field, an edit gives back what was there before. */
export function leaveScheduleMode(conversationId: string): void {
  const entry = scheduleModeFor(conversationId);
  const mode = entry.peek();
  if (!mode) return;
  entry.value = null;
  if (mode.edit) updateDraft(conversationId, { text: mode.edit.stash.text, level: mode.edit.stash.level, ultra: mode.edit.stash.ultra });
}

export function patchForm(conversationId: string, patch: Partial<ScheduleForm>): void {
  const entry = scheduleModeFor(conversationId);
  const mode = entry.peek();
  if (mode) entry.value = { ...mode, form: { ...mode.form, ...patch } };
}

const levelOf = (schedule: Schedule): MessageLevel => (schedule.payload.silent ? 'silent' : schedule.payload.priority === 'important' ? 'important' : 'normal');

/** Edit: the composer in schedule mode on this scheduled message; false when it cannot be edited here. */
export function editSchedule(schedule: Schedule, now = Date.now()): boolean {
  const conversationId = schedule.conversationId;
  if (!conversationId || !editableSchedule(schedule, now, localZone())) return false;
  const form = formFromSpec(schedule.spec, now, localZone());
  if (!form) return false;
  const entry = scheduleModeFor(conversationId);
  const draft = draftFor(conversationId).peek();
  const stash = entry.peek()?.edit?.stash ?? { text: draft.text, level: draft.level, ultra: draft.ultra };
  entry.value = { form, edit: { id: schedule.id, original: formKey(form), stash } };
  updateDraft(conversationId, { text: schedule.payload.body ?? schedule.title, level: levelOf(schedule), ultra: schedule.payload.ultra ? true : undefined });
  return true;
}

/**
 * Schedules the chat's draft (a new message) or saves the edited one. True when it went through; a failure says why in
 * a notice and leaves the mode and the draft as they are.
 */
export async function scheduleDraft(chat: ConversationSummary, ultra: boolean): Promise<boolean> {
  const mode = scheduleModeFor(chat.id).peek();
  if (!mode) return false;
  const draft = draftFor(chat.id).peek();
  const body = draft.text.trim();
  const built = scheduleSpec(mode.form, Date.now());
  if (!body || 'error' in built) return false;
  const mentions = mentionsIn(body, chat);
  try {
    if (mode.edit) {
      const { id, original } = mode.edit;
      await rpc.call('schedules.update', { id, body, mentions, priority: draft.level, ...(formKey(mode.form) === original ? {} : { spec: built.spec }) });
      leaveScheduleMode(chat.id);
      pushToast({ title: 'Schedule updated', tone: 'info' }, 3000);
    } else {
      await rpc.call('messages.schedule', {
        conversationId: chat.id, body, spec: built.spec, mentions,
        ...(draft.level !== 'normal' ? { priority: draft.level } : {}), ...(ultra ? { ultra: true } : {}),
      });
      scheduleModeFor(chat.id).value = null;
      updateDraft(chat.id, { text: '', level: 'normal', ultra: undefined });
      setReply(chat.id, null); // a scheduled message is not a reply
    }
    return true;
  } catch (error) {
    toastError(error, mode.edit ? 'Could not update' : 'Could not schedule');
    return false;
  }
}
