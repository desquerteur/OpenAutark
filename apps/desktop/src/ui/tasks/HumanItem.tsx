// One human to-do on My day's list (formerly "For you"): a single line – a check where one tick finishes it (B-041: a
// plain to-do, a confirmation, a reminder, a checklist; tasks/todo-actions.ts checkAnswer), else the widget icon –,
// the verb-first title, and a short meta line (priority, chat, its block "09:30 · 30 min", "Prepared by Mara", the
// due – none beside a block – or ring time). It expands in place into its widget (AskBlock, at most two buttons; an
// agent's mini-app to-do, F01, its sandboxed app – tasks/AppTodo.tsx) – no modals – with the agent's preparation
// (day/DayPrep) above it.
// F04: a timer shows its ring time ("17:00 · in 5 min" in the last hour, parts.tsx DueText); a to-do that rang gets
// the quiet ringing accent (a bell, the warning tone, a short swing that reduced motion turns off – tasks.css); a
// snoozed one says until when (its schedule once schedules are listed – tasks/schedules.ts –, else the end its wait
// records, waitingOn.until), else just "Snoozed".
// The menu (right click or long press; a ⋯ on the phone; tasks/todo-menu.ts) holds Snooze, Show as…, Open in chat,
// Stop repeating, Send to team and the settling actions. F06: "Can't do this…" opens a one-line reason in place of
// the body and declines the to-do (todos.decline – its agent hears why); "Remove" takes a to-do the person added off
// the list at once (todos.remove); "Done" finishes a mini-app to-do whose app never reports back (an answer marked
// `manual`, so its agent knows no app data came). The item then leaves with the list's exit animation.
// MP9: a browser or social agent's confirm to-do also offers "Open browser" (BrowserTodo.tsx). X02: on a phone over
// plain http it says to open the HTTPS address instead.
// F07 take guard: while its recorder is recording or holds an unsent take (holdsTake), the list keeps the item open,
// and collapsing, declining or removing it asks "Discard recording?" first.
// Owns: the item row, the decline reason and the expanded body. Never: renders agent work here.

import { useEffect, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../shared/model/calendar.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { appWidgetOf } from '../../shared/blocks/app-todo.ts';
import { newId } from '../../shared/ids.ts';
import { Button, Icon, confirm } from '../lib/ui.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { KeptTail } from '../lib/kept-tail.ts';
import { conversationMap, removeById, todos } from '../lib/store.ts';
import { chatTitle } from '../lib/chat-face.tsx';
import { dayZone } from '../lib/day-store.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { AskBlock } from '../blocks/AskBlock.tsx';
import { targetKey } from '../blocks/ask.ts';
import { Markdown } from '../blocks/markdown.tsx';
import { discardTake, heldTakes } from '../blocks/ui/media-devices.ts';
import { askTargetOf, isRinging, isSnoozed, snoozeEnd, snoozedUntil, timerAt, todoLabel, widgetIcon } from './model.ts';
import { AppTodoBody } from './AppTodo.tsx';
import { DueText, SnoozedText } from './parts.tsx';
import { ensureSchedules, schedules, schedulesLoaded } from './schedules.ts';
import { canOpenChat } from './jump.ts';
import { putTask } from './task-cache.ts';
import { checkAnswer } from './todo-actions.ts';
import { todoMenu } from './todo-menu.ts';
import { MoreButton } from './parts.tsx';
import { BrowserTodo, BrowserTodoNote, handBackQuietly, useBrowserTodo } from './BrowserTodo.tsx';
import { checkTodo, removeTodo } from '../day/day-actions.ts';
import { blockMinutes, minutesText, rowTime } from '../day/day-format.ts';
import { clockOf } from '../day/day-grid.ts';
import { DayPrep, prepByline } from '../day/DayPrep.tsx';

export interface HumanItemProps {
  task: TaskView;
  expanded: boolean;
  onToggle: () => void;
  /** Answered/removed: shown briefly with the exit animation, no longer interactive. */
  leaving?: boolean;
  onAnswered?: () => void;
  /** Hide the chat name (e.g. inside that chat's own panel). */
  hideChat?: boolean;
  /** The list's clock (store.todoClock) – ring times and countdowns are read at it. */
  now?: number;
  /** B-041: its planned block (lib/day-store.ts slotOf) – the row shows when and how long. */
  slot?: CalendarEvent;
}

/** The record widget's draft key behind a to-do (AskBlock keys its widget by the target). */
export function takeKeyOf(task: TaskView): string {
  return targetKey(askTargetOf(task));
}

/** F07: this to-do's recorder is recording or holds an unsent take. */
export function holdsTake(task: TaskView, held: ReadonlySet<string> = heldTakes.value): boolean {
  return task.widget?.type === 'record' && held.has(takeKeyOf(task));
}

const DISCARD_TAKE = { title: 'Discard recording?', body: 'It has not been sent yet.', confirmLabel: 'Discard', danger: true };

/** Before a guarded item is declined or removed: "Discard recording?" – its take goes once that worked (settled). */
export function mayDropTake(task: TaskView): Promise<boolean> {
  return holdsTake(task) ? confirm(DISCARD_TAKE) : Promise.resolve(true);
}

/** Before a guarded item collapses: "Discard recording?" – the take goes at once; true when it may close. */
export async function letGoOfTake(task: TaskView): Promise<boolean> {
  if (!holdsTake(task)) return true;
  const ok = await confirm(DISCARD_TAKE);
  if (ok) discardTake(takeKeyOf(task));
  return ok;
}

/** "Mark done" on a mini-app to-do: told apart from a real wf.complete result in the receipt and the agent's wake (the takes the app registered still go with it, X03). */
const MARKED_DONE_ANSWER = { done: true, manual: true, note: 'Marked done by hand (not finished in the app)' };

/** A finished or declined to-do leaves the list at once (the event follows). */
function settled(view: TaskView | undefined, task: TaskView): void {
  if (view) putTask(view);
  if (task.widget?.type === 'record') discardTake(takeKeyOf(task)); // nothing to send it to any more
  removeById(todos, task.id);
}

/** "Can't do this…": one line why (optional), in place of the body; the agent hears it. */
function DeclineReason(props: { task: TaskView; onClose: () => void; onDeclined?: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [clientId] = useState(() => newId('up'));
  const send = async () => {
    if (busy) return;
    setBusy(true);
    try {
      settled(await rpc.call('todos.decline', { id: props.task.id, reason: reason.trim(), clientId }), props.task);
      props.onDeclined?.();
    } catch (error) {
      toastError(error, 'Could not decline');
      setBusy(false);
    }
  };
  return (
    <form class="todo-body todo-decline" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input class="input" type="text" value={reason} maxLength={500} autoFocus disabled={busy}
        placeholder="Why not? (optional)" aria-label="Why you can't do this"
        onInput={(event) => setReason((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => { if (event.key === 'Escape') props.onClose(); }} />
      <div class="w-actions">
        <Button type="submit" variant="primary" busy={busy}>Send</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>Cancel</Button>
      </div>
    </form>
  );
}

/** Body for a human task without a widget: one "Done" action. */
function PlainDone(props: { task: TaskView; onAnswered?: () => void }) {
  const [busy, setBusy] = useState(false);
  const done = async () => {
    setBusy(true);
    try {
      putTask(await rpc.call('tasks.complete', { id: props.task.id, clientId: newId('up') }));
      props.onAnswered?.();
    } catch (error) {
      toastError(error, 'Could not complete');
    } finally {
      setBusy(false);
    }
  };
  return <div class="todo-actions"><Button variant="primary" busy={busy} onClick={() => void done()}>Done</Button></div>;
}

/**
 * When a snoozed to-do rings again: its pending schedule once this connection has listed them
 * (live – a paused or deleted ring reads as plain "Snoozed"), else the end its wait records
 * (waitingOn.until – a To-do-only phone without schedules.list).
 */
function useSnoozeEnd(task: TaskView, snoozed: boolean): number | undefined {
  useEffect(() => { if (snoozed) ensureSchedules(); }, [snoozed]);
  if (!snoozed) return undefined;
  return schedulesLoaded.value ? snoozeEnd(schedules.value, task.id) : snoozedUntil(task);
}

/** The row's time: a snoozed to-do's end, a timer's ring time, else the due time – but not beside a planned block:
 *  its "10:55 · 30 min" is when the to-do happens, and a due "Overdue · 1 hour ago" or "in 20 hours" next to it
 *  contradicted the plan (C3 D-7). */
function When(props: { task: TaskView; now: number; until: number | undefined; snoozed: boolean; planned: boolean }) {
  const { task, now } = props;
  if (props.snoozed) return <SnoozedText until={props.until} now={now} />;
  const ring = timerAt(task);
  if (ring !== undefined) return <DueText dueAt={ring} now={now} timer />;
  return props.planned ? null : <DueText dueAt={task.dueAt} now={now} />;
}

/** "09:30 · 30 min" for a planned block, else the time the to-do takes ("30 min"); '' without either. */
function slotText(task: TaskView, slot: CalendarEvent | undefined): string {
  if (slot && slot.state === 'planned') return rowTime(clockOf(slot.startAt, dayZone.value), blockMinutes(slot));
  return task.estimateMin ? minutesText(task.estimateMin) : '';
}

export function HumanItem(props: HumanItemProps) {
  const { task, expanded, leaving } = props;
  const [declining, setDeclining] = useState(false);
  const [ticking, setTicking] = useState(false);
  const known = (task.conversationId ? conversationMap.value.get(task.conversationId) : undefined);
  const chatName = (known && chatTitle(known)) || task.conversationTitle;
  const showChat = !props.hideChat && chatName && canOpenChat(task.conversationId);
  const why = typeof task.widget?.why === 'string' ? task.widget.why : '';
  const app = appWidgetOf(task.widget);
  const browser = useBrowserTodo(task);
  const now = props.now ?? Date.now();
  const ringing = isRinging(task) && !leaving;
  const snoozed = isSnoozed(task);
  const until = useSnoozeEnd(task, snoozed);
  const timed = snoozed || task.dueAt !== undefined || timerAt(task) !== undefined;
  const length = slotText(task, props.slot);
  const prepared = prepByline(task.prep);
  const check = !!checkAnswer(task);
  useEffect(() => { if (leaving) handBackQuietly(task.id); }, [leaving, task.id]);
  const answered = () => { handBackQuietly(task.id); props.onAnswered?.(); };
  const tick = async () => {
    if (ticking) return;
    setTicking(true);
    if (await checkTodo(task)) answered();
    setTicking(false);
  };
  const markDone = async () => {
    try { settled(await rpc.call('tasks.complete', { id: task.id, answer: MARKED_DONE_ANSWER, clientId: newId('up') }), task); answered(); } catch (error) { toastError(error, 'Could not complete'); }
  };
  const remove = async () => {
    if (!(await mayDropTake(task)) || !(await removeTodo(task))) return;
    if (task.widget?.type === 'record') discardTake(takeKeyOf(task)); // nothing to send it to any more
  };
  const handlers = { onMarkDone: () => void markDone(), onRemove: () => void remove(), onDecline: () => void mayDropTake(task).then((ok) => { if (ok) setDeclining(true); }) };
  const menu = useContextMenu(() => todoMenu(task, handlers));
  const icon = leaving ? 'check-circle' : ringing && task.widget?.type === 'timer' ? 'bell' : widgetIcon(task.widget);
  return (
    <li class={`todo-item${expanded || declining ? ' expanded' : ''}${leaving ? ' leaving' : ''}`} data-task-id={task.id} {...menu}>
      <div class="todo-row">
        {check && (
          <button type="button" class={`day-check${ringing ? ' ringing' : ''}${ticking || leaving ? ' done' : ''}`} disabled={leaving || ticking}
            aria-label={`Done: ${todoLabel(task)}`} title="Done" onClick={() => void tick()}>
            <Icon name="check" size={14} />
          </button>
        )}
        <button type="button" class="todo-open" aria-expanded={expanded} disabled={leaving} onClick={props.onToggle}>
          {!check && (
            <span class={`todo-icon${ringing ? ' ringing' : ''}`} aria-hidden="true">
              <Icon name={icon} size={18} />
            </span>
          )}
          <span class="todo-text">
            <span class="todo-title">{ringing && <span class="sr-only">Needs you now: </span>}<KeptTail text={todoLabel(task)} /></span>
            {(showChat || timed || task.priority > 0 || length || prepared) && (
              <span class="todo-meta">
                {task.priority > 0 && <span class="todo-priority">{task.priority === 2 ? 'Urgent' : 'High'}</span>}
                {length && <span class="day-slot-time tabular">{length}</span>}
                {showChat && <span class="todo-chat">{chatName}</span>}
                {prepared && <span class="day-prepared">{prepared}</span>}
                <When task={task} now={now} until={until} snoozed={snoozed} planned={props.slot?.state === 'planned'} />
              </span>
            )}
          </span>
        </button>
        {!leaving && <MoreButton build={() => todoMenu(task, handlers)} />}
      </div>
      {declining && !leaving && <DeclineReason task={task} onClose={() => setDeclining(false)} onDeclined={answered} />}
      {expanded && !declining && !leaving && (
        <div class="todo-body">
          {why && <p class="todo-why">{why}</p>}
          {task.notes && <Markdown text={task.notes} class="todo-notes" />}
          <DayPrep prep={task.prep} />
          {browser ? <BrowserTodo task={task} target={browser} /> : <BrowserTodoNote task={task} />}
          {app ? <AppTodoBody task={task} widget={app} />
            : task.widget
              ? <AskBlock block={task.widget} target={askTargetOf(task)} bare onAnswered={answered} />
              : <PlainDone task={task} onAnswered={answered} />}
        </div>
      )}
    </li>
  );
}
