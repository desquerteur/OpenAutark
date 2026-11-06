// Schedules known to the UI (follow-up chips under task results, an agent's own schedules): loaded once on
// demand with `schedules.list`, then kept fresh by schedule events. ONE menu per schedule (scheduleMenu: Pause
// or Resume, Cancel) for every place a schedule is drawn.
// Owns: the schedules signal, the pause/resume/cancel actions and that menu. Never: polls or fires schedules
// itself (the runtime scheduler owns timing).

import { signal } from '@preact/signals';
import type { Schedule } from '../../shared/model/tasks.ts';
import { rpc } from '../lib/rpc.ts';
import type { MenuSection } from '../lib/popover.tsx';
import { confirm } from '../lib/dialog.tsx';
import { toastError } from '../lib/toasts.ts';

export const schedules = signal<Schedule[]>([]);
export const schedulesLoaded = signal(false);

let wired = false;
let loading: Promise<void> | null = null;

function upsert(item: Schedule): void {
  const list = schedules.peek();
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) schedules.value = [...list, item];
  else { const next = list.slice(); next[index] = item; schedules.value = next; }
}

function load(): Promise<void> {
  loading ??= rpc.call('schedules.list')
    .then((list) => { schedules.value = list; schedulesLoaded.value = true; })
    .finally(() => { loading = null; });
  return loading;
}

/** Loads the schedules once and subscribes to their events (idempotent). */
export function ensureSchedules(): void {
  if (!wired) {
    wired = true;
    rpc.on('schedule.upserted', upsert);
    rpc.on('schedule.removed', ({ id }) => { schedules.value = schedules.peek().filter((entry) => entry.id !== id); });
    rpc.onOpen(() => { if (schedulesLoaded.peek()) void load().catch(() => undefined); });
  }
  if (!schedulesLoaded.peek()) void load().catch(() => undefined);
}

export async function setScheduleActive(item: Schedule, active: boolean): Promise<void> {
  try { upsert(await rpc.call('schedules.update', { id: item.id, active })); } catch (error) { toastError(error, active ? 'Could not resume' : 'Could not pause'); }
}

export async function deleteSchedule(item: Schedule): Promise<void> {
  const ok = await confirm({ title: 'Cancel this schedule?', body: item.title, confirmLabel: 'Cancel schedule', danger: true });
  if (!ok) return;
  try {
    await rpc.call('schedules.delete', { id: item.id });
    schedules.value = schedules.peek().filter((entry) => entry.id !== item.id);
  } catch (error) { toastError(error, 'Could not cancel the schedule'); }
}

export function scheduleMenu(item: Schedule): MenuSection[] {
  return [{ items: [
    { label: item.active ? 'Pause' : 'Resume', onSelect: () => void setScheduleActive(item, !item.active) },
    { label: 'Cancel', danger: true, onSelect: () => void deleteSchedule(item) },
  ] }];
}
