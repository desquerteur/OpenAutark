// Host decision to-dos: a request the person decides on a host-written to-do in My day – today the
// joins of people's devices (people/join.ts: "Let <device> join as <person>?", Allow / Deny).
// Only the person's answer decides (verification 'reported_by_human', which no agent can produce);
// a to-do closed, removed or handed to an agent any other way comes back while the request is open
// (at most MAX_RESTORES times), and a changed title or notes is put back. The widget carries the
// host-only binding (shared/blocks/catalog.ts HOST_ONLY_PROPS `accessRequestId`). TaskService sends
// the desktop notification and the push for the new human to-do itself; the to-do is chat-free.
// Owns: opening, watching, repairing and closing these to-dos. Never: decides by itself or trusts
// anything but the host-written option labels.

import type { UiBlock } from '../../shared/blocks/catalog.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { ORIGINS } from '../../shared/model/origin.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { Bus } from '../bus.ts';
import type { Logger, RuntimeServices } from '../contracts.ts';
import { currentCaller } from '../rpc/caller.ts';
import type { ClientScope } from '../../shared/api/protocol.ts';

export const MAX_RESTORES = 5;

/** Services a decision to-do needs (the runtime's, handed over lazily). */
export type TodoServices = Pick<RuntimeServices, 'tasks'> & Partial<Pick<RuntimeServices, 'notifications'>>;

/** What a decision to-do shows: host-written text and the option labels it accepts. */
export interface DecisionText {
  title: string;
  notes: string;
  question: string;
  options: Array<{ label: string; hint?: string }>;
  /** Shown as an OS notification when the to-do cannot be created. */
  fallback: string;
  /** The kind of that notification (default 'important'). */
  ring?: 'todo' | 'important';
  /**
   * The host-only binding (shared/blocks/catalog.ts HOST_ONLY_PROPS `accessRequestId`): agents may
   * read the to-do but never change it, and a linked PC is told to decide it on this PC.
   */
  binding: string;
}

interface Entry { key: string; text: DecisionText; todoId?: string; restores: number }

export interface DecisionTodosDeps {
  bus: Pick<Bus, 'on'>;
  log: Logger;
  services: () => TodoServices | undefined;
  /**
   * The person's answer: the chosen option label, or undefined for "Can't do this"/a decline;
   * `scope` is the answering caller. Returns false when the request refused this answer and stays
   * open (its to-do comes back).
   */
  answered(key: string, choice: string | undefined, scope: ClientScope | undefined): boolean;
}

const isClosed = (view: Pick<TaskView, 'status'>): boolean => view.status === 'done' || view.status === 'cancelled';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Creates the human to-do for `text`; returns its id (undefined: only a notification went out). */
export function createDecisionTodo(s: TodoServices, log: Logger, text: DecisionText): string | undefined {
  const { title, notes, question, options, binding } = text;
  const widget: UiBlock = { type: 'choice', accessRequestId: binding, question, options };
  try {
    return s.tasks.create({
      origin: { source: ORIGINS.system.source, label: 'Access request' }, title, notes, assigneeKind: 'human', humanReason: 'approval', priority: 1, widget, createdBy: SYSTEM_ID,
    }).id;
  } catch (error) {
    log.warn('decision to-do failed', { binding, error: errorText(error) });
    try { s.notifications?.notify({ kind: text.ring ?? 'important', title, body: text.fallback }); } catch { /* best effort */ }
    return undefined;
  }
}

export class DecisionTodos {
  private readonly deps: DecisionTodosDeps;
  private readonly entries = new Map<string, Entry>();
  private readonly byTodo = new Map<string, Entry>();
  /** To-dos this module changes itself (their events are ignored). */
  private readonly closing = new Set<string>();
  private listening = false;

  constructor(deps: DecisionTodosDeps) { this.deps = deps; }

  /** Opens the to-do for `key` (once). */
  open(key: string, text: DecisionText): void {
    this.listen();
    if (this.entries.has(key)) return;
    const entry: Entry = { key, text, restores: 0 };
    this.entries.set(key, entry);
    this.attach(entry);
  }

  /** The request ended another way: its open to-do is cancelled with `note`. */
  close(key: string, note: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.detach(entry, note);
  }

  /** Open to-do id of `key` (tests, UI hints). */
  todoOf(key: string): string | undefined { return this.entries.get(key)?.todoId; }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    const guard = <T>(fn: (data: T) => void) => (data: T) => {
      try { fn(data); } catch (error) { this.deps.log.warn('decision to-do listener failed', { error: errorText(error) }); }
    };
    this.deps.bus.on('task.upserted', guard((view: TaskView) => this.onTodo(view)));
    this.deps.bus.on('task.removed', guard(({ id }: { id: string }) => {
      const entry = this.byTodo.get(id);
      if (entry && !this.closing.has(id)) this.later(entry, id);
    }));
  }

  private onTodo(view: TaskView): void {
    const entry = this.byTodo.get(view.id);
    if (!entry || this.closing.has(view.id)) return;
    if (isClosed(view) && view.result?.verification === 'reported_by_human') {
      this.byTodo.delete(view.id);
      entry.todoId = undefined;
      const answer = view.result.answer as { choice?: unknown } | undefined;
      const label = view.status === 'done' && answer && typeof answer === 'object' && typeof answer.choice === 'string' ? answer.choice : undefined;
      const choice = label && entry.text.options.some((option) => option.label === label) ? label : undefined;
      let applied = true;
      try { applied = this.deps.answered(entry.key, choice, currentCaller()?.scope); } finally {
        if (applied) this.entries.delete(entry.key);
        else this.later(entry, view.id);
      }
      return;
    }
    if (isClosed(view) || view.assigneeKind !== 'human') this.later(entry, view.id);
    else if (!this.hasText(view, entry)) queueMicrotask(() => this.repair(entry, view.id));
  }

  private hasText(view: Pick<TaskView, 'title' | 'notes'>, entry: Entry): boolean {
    return view.title === entry.text.title && view.notes === entry.text.notes;
  }

  /** Restores after the change that caused it has finished (never inside TaskService's own emit). */
  private later(entry: Entry, oldId: string): void {
    this.byTodo.delete(oldId);
    entry.todoId = undefined;
    queueMicrotask(() => {
      if (this.entries.get(entry.key) !== entry || entry.todoId) return;
      this.cancel(oldId, 'Replaced');
      // Closed again and again: no further to-do (and no further ring), but no decision either –
      // the request stays open until it expires.
      if (entry.restores >= MAX_RESTORES) return void this.deps.log.warn('decision to-do not restored again', { key: entry.key });
      entry.restores++;
      this.attach(entry);
    });
  }

  private attach(entry: Entry): void {
    const s = this.deps.services();
    if (!s) return;
    entry.todoId = createDecisionTodo(s, this.deps.log, entry.text);
    if (entry.todoId) this.byTodo.set(entry.todoId, entry);
  }

  private repair(entry: Entry, todoId: string): void {
    if (this.byTodo.get(todoId) !== entry) return;
    const s = this.deps.services();
    if (!s) return;
    this.closing.add(todoId);
    try {
      const todo = s.tasks.get(todoId);
      if (todo && !isClosed(todo) && !this.hasText(todo, entry)) s.tasks.update(todoId, { title: entry.text.title, notes: entry.text.notes }, SYSTEM_ID);
    } catch (error) {
      this.deps.log.warn('decision to-do not repaired', { todoId, error: errorText(error) });
    } finally {
      this.closing.delete(todoId);
    }
  }

  private detach(entry: Entry, note: string): void {
    const todoId = entry.todoId;
    if (!todoId) return;
    this.byTodo.delete(todoId);
    entry.todoId = undefined;
    this.cancel(todoId, note);
  }

  private cancel(todoId: string, note: string): void {
    const s = this.deps.services();
    if (!s) return;
    this.closing.add(todoId);
    try {
      const todo = s.tasks.get(todoId);
      if (todo && !isClosed(todo)) s.tasks.setStatus(todoId, 'cancelled', SYSTEM_ID, note);
    } catch (error) {
      this.deps.log.warn('decision to-do not closed', { todoId, error: errorText(error) });
    } finally {
      this.closing.delete(todoId);
    }
  }
}
