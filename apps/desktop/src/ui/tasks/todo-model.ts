// Pure helpers behind the person's to-dos (split out of tasks/model.ts, which re-exports them): a person's join
// request said as one sentence (the notice band's words too), where a list answer goes, widget icons (a mini-app
// to-do, F01: own icon), the "Show as…" choices (none for mini-apps or host-bound cards) and the due state.
// Owns: these rules (unit-tested in test/unit/ui/tasks-model.test.ts and todo-model.test.ts).
// Never: imports the store, rpc or the DOM – callers pass data in, so tests run in Node.

import { appWidgetOf } from '../../shared/blocks/app-todo.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { isHostBoundTodo } from '../../shared/blocks/catalog.ts';
import type { Task, TodoWidget } from '../../shared/model/tasks.ts';
import type { IconName } from '../lib/icons.tsx';

export const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ join requests, icons, "Show as…"

/** people/join.ts's title of a person's join request ("Let <device> join as <name> · <role>?"). */
const JOIN_TITLE = /^Let (.+?) join as (.+)\?$/;

/** A person's join request said as one sentence like the other requests ("Anna Berg wants to join from
 *  Laptop · Chrome", as "Pixel 8 wants to open Workforce"; the role stays in its question) – the host's own
 *  decision to-do only (system-written, its access binding 'person_…'); null for any other to-do. */
export function joinRequestLabel(task: Pick<Task, 'title' | 'widget' | 'createdBy'>): string | null {
  const binding = task.widget?.accessRequestId;
  const match = task.createdBy === SYSTEM_ID && typeof binding === 'string' && binding.startsWith('person_') ? JOIN_TITLE.exec(task.title) : null;
  return match ? `${match[2].split(' · ')[0]} wants to join from ${match[1]}` : null;
}

/** Row label of a to-do: its title; a person's join request reads as one sentence (the same words in My day and the notice band). */
export function todoLabel(task: Pick<Task, 'title' | 'widget' | 'createdBy'>): string {
  return joinRequestLabel(task) ?? task.title;
}

/** Where an answer from the list goes (structurally an AskTarget of blocks/ask.ts). */
export function askTargetOf(task: Pick<Task, 'id'>): { kind: 'task'; taskId: string } {
  return { kind: 'task', taskId: task.id };
}

export function widgetIcon(widget: TodoWidget | undefined): IconName {
  switch (widget?.type) {
    case 'app': return 'app-window';
    case 'approve': return 'shield-check';
    case 'record': return widget.mode === 'video' ? 'camera' : widget.mode === 'screen' ? 'monitor' : 'microphone';
    case 'timer': return 'clock';
    case 'upload': return 'paperclip';
    case 'checklist': return 'list-checks';
    case 'form': return 'pencil-simple';
    case 'choice': return 'chat-circle-dots';
    case 'review': return 'magnifying-glass';
    default: return 'check-circle';
  }
}

export const SHOW_AS: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'confirm', label: 'Confirm' },
  { type: 'checklist', label: 'Checklist' },
  { type: 'timer', label: 'Reminder' },
  { type: 'record', label: 'Recording' },
  { type: 'upload', label: 'Upload' },
  { type: 'choice', label: 'Choice' },
  { type: 'form', label: 'Text' },
  { type: 'review', label: 'Review' },
]; // B-078: no "Approval" – a yes/no is a Choice

/**
 * "Show as…" choices; none for mini-apps or cards the host bound to the person (approvals,
 * permission setups, access requests) – switching would drop them.
 */
export function showAsOptions(task: Pick<Task, 'widget' | 'createdBy' | 'assigneeKind'>): ReadonlyArray<{ type: string; label: string }> {
  if (task.assigneeKind !== 'human' || isHostBoundTodo(task) || appWidgetOf(task.widget)) return [];
  return SHOW_AS;
}

export type DueState = 'none' | 'overdue' | 'soon' | 'later';

export function dueState(dueAt: number | undefined, now: number): DueState {
  if (dueAt === undefined) return 'none';
  if (dueAt < now) return 'overdue';
  return dueAt - now < DAY_MS ? 'soon' : 'later';
}
