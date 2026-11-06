// One block in My day's calendar (B-041 §4.1): an event (its own title) or a to-do's time block (the to-do's
// title – a block copies no task text – with a check that finishes it where one tick can), a read-only calendar's
// event dimmed, a done or cut block quiet. On a computer a block is dragged to move it (pointer events, 5-minute
// snap; it then is the person's – the planner leaves it); a click opens its popover: the time, the notes and "Move
// to" a typed time (works on touch too). The block's menu (right click or long press, blockMenu): Done · Move to… ·
// Show in list · Remove from calendar – for a to-do's block (the to-do stays) or, after a confirm, an appointment of
// the app's own calendar (calendar.remove; a connected calendar's entries stay).
// Owns: the block's markup, its drag, its menu and its popover. Never: places blocks (the grid lays them out) or
// decides what a check sends (tasks/todo-actions.ts).

import { useRef, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../shared/model/calendar.ts';
import { LOCAL_SOURCE_ID } from '../../shared/model/calendar.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { confirm } from '../lib/dialog.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import type { MenuSection } from '../lib/popover.tsx';
import { handedOff } from '../lib/day-store.ts';
import { todos } from '../lib/store.ts';
import { Button, Icon, Popover } from '../lib/ui.tsx';
import { useTask } from '../tasks/task-cache.ts';
import { checkAnswer } from '../tasks/todo-actions.ts';
import { checkTodo, moveBlock, unplanBlock } from './day-actions.ts';
import { HOUR_PX, SNAP_MIN, clockOf, movedBy, movedTo } from './day-grid.ts';
import type { Span } from './day-grid.ts';
import { revealTodo, sources } from './day-state.ts';

const DRAG_PX = 4;

/** The to-do behind a block: on the list, handed off, else the task cache. */
function useBlockTask(event: CalendarEvent): TaskView | undefined {
  const id = event.kind === 'todo' ? event.taskId : undefined;
  const listed = id ? todos.value.find((task) => task.id === id) ?? handedOff.value.find((task) => task.id === id) : undefined;
  const cached = useTask(id && !listed ? id : undefined);
  return listed ?? cached ?? undefined;
}

/** A block the person may move: not from a read-only calendar. */
export function movable(event: CalendarEvent): boolean {
  if (event.readOnly) return false;
  if (event.sourceId === LOCAL_SOURCE_ID) return true;
  return sources.peek().find((source) => source.id === event.sourceId)?.writable === true;
}

export interface DayBlockProps {
  event: CalendarEvent;
  date: string;
  tz: string;
  span: Span;
  lane: number;
  lanes: number;
  /** The week view: narrow columns, no drag. */
  compact?: boolean;
}

export function DayBlock(props: DayBlockProps) {
  const { event, span, tz } = props;
  const task = useBlockTask(event);
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0); // minutes, while dragging
  const drag = useRef<{ y: number; moved: boolean; id: number } | null>(null);
  const done = event.state !== 'planned';
  const title = event.kind === 'todo' ? task?.title ?? (done ? 'Done' : 'To-do') : event.title || 'Event';
  const check = !done && task && checkAnswer(task);
  const readOnly = !movable(event);
  const mayMove = !readOnly;
  const menu = useContextMenu(() => blockMenu({ event, task, title, mayMove, onMove: () => setOpen(true) }));

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('.day-block-check')) return;
    drag.current = { y: e.clientY, moved: false, id: e.pointerId };
    if (mayMove && !props.compact && e.pointerType !== 'touch') ref.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const state = drag.current;
    if (!state || state.id !== e.pointerId || !mayMove || props.compact || e.pointerType === 'touch') return;
    const dy = e.clientY - state.y;
    if (!state.moved && Math.abs(dy) < DRAG_PX) return;
    state.moved = true;
    setOffset(Math.round((dy / HOUR_PX) * 60 / SNAP_MIN) * SNAP_MIN);
  };
  const onPointerUp = (e: PointerEvent) => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.id !== e.pointerId) return;
    if (!state.moved) { setOpen(!open); return; }
    const delta = offset;
    setOffset(0);
    if (delta) { const next = movedBy(event, delta, tz, props.date); void moveBlock(event, next.startAt, next.endAt); }
  };
  const top = ((span.start + offset) / 60) * HOUR_PX;
  const height = Math.max(((span.end - span.start) / 60) * HOUR_PX - 2, 18);
  const width = 100 / props.lanes;
  return (
    <>
      {/* A plain container: the check and the open control are sibling buttons (never a button in a button). */}
      <div ref={ref} class="day-block" data-kind={event.kind} data-state={event.state} data-readonly={readOnly ? 'true' : undefined}
        data-dragging={offset ? 'true' : undefined} data-short={height < 34 ? 'true' : undefined}
        style={{ top: `${top}px`, height: `${height}px`, left: `calc(${props.lane * width}% + 2px)`, width: `calc(${width}% - 4px)` }}
        onContextMenu={menu.onContextMenu} onClickCapture={menu.onClickCapture}
        onPointerDown={(e) => { menu.onPointerDown(e); onPointerDown(e); }} onPointerMove={(e) => { menu.onPointerMove(e); onPointerMove(e); }}
        onPointerUp={(e) => { menu.onPointerUp(); onPointerUp(e); }}
        onPointerCancel={() => { menu.onPointerCancel(); drag.current = null; setOffset(0); }}>
        {(check || (event.kind === 'todo' && done)) && (
          <button type="button" class={`day-block-check${done ? ' done' : ''}`} disabled={done} aria-label={`Done: ${title}`}
            onClick={(e) => { e.stopPropagation(); if (task) void checkTodo(task); }}>
            <Icon name="check" size={12} />
          </button>
        )}
        <button type="button" class="day-block-open" aria-label={`${title}, ${clockOf(event.startAt, tz)}–${clockOf(event.endAt, tz)}`} aria-expanded={open}
          onClick={(e) => { if (e.detail === 0) setOpen(!open); }}>{/* a pointer opens it on pointer-up (a drag moves instead); keys click with detail 0 */}
          <span class="day-block-text">
            <span class="day-block-title">{title}</span>
            {!props.compact && <span class="day-block-time tabular">{clockOf(event.startAt, tz)}–{clockOf(event.endAt, tz)}</span>}
          </span>
        </button>
      </div>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="right-start" width={260} label={title} class="day-block-popover">
        <BlockDetails event={event} title={title} date={props.date} tz={tz} mayMove={mayMove} onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

/** The block's menu: Done (a to-do's check), Move to… (opens the popover's time field), Show in list, Remove from calendar. */
function blockMenu(input: { event: CalendarEvent; task: TaskView | undefined; title: string; mayMove: boolean; onMove: () => void }): MenuSection[] {
  const { event, task } = input;
  const done = event.state !== 'planned';
  const listed = task && todos.peek().some((entry) => entry.id === task.id);
  const removable = !done && (event.kind === 'todo' || (event.sourceId === LOCAL_SOURCE_ID && !event.readOnly));
  const remove = async () => {
    if (event.kind === 'event' && !(await confirm({ title: `Remove ${input.title}?`, confirmLabel: 'Remove', danger: true }))) return;
    void unplanBlock(event);
  };
  return [{ items: [
    ...(!done && task && checkAnswer(task) ? [{ label: 'Done', onSelect: () => void checkTodo(task) }] : []),
    ...(input.mayMove ? [{ label: 'Move to…', onSelect: input.onMove }] : []),
    ...(listed ? [{ label: 'Show in list', onSelect: () => revealTodo(task.id) }] : []),
    ...(removable ? [{ label: 'Remove from calendar', danger: true, onSelect: () => void remove() }] : []),
  ] }];
}

function BlockDetails(props: { event: CalendarEvent; title: string; date: string; tz: string; mayMove: boolean; onClose: () => void }) {
  const { event, tz } = props;
  const [clock, setClock] = useState(clockOf(event.startAt, tz));
  const [busy, setBusy] = useState(false);
  const source = event.sourceId === LOCAL_SOURCE_ID ? undefined : sources.value.find((entry) => entry.id === event.sourceId)?.label;
  const target = movedTo(event, props.date, clock, tz);
  const move = async () => {
    if (!target || busy) return;
    setBusy(true);
    if (await moveBlock(event, target.startAt, target.endAt)) props.onClose();
    setBusy(false);
  };
  return (
    <div class="day-block-details">
      <p class="day-block-details-title">{props.title}</p>
      <p class="day-block-details-time tabular">
        {clockOf(event.startAt, tz)}–{clockOf(event.endAt, tz)}{source ? ` · ${source}` : ''}{event.state === 'done' ? ' · Done' : event.state === 'cut' ? ' · Ended early' : ''}
      </p>
      {event.notes && <p class="day-block-details-notes">{event.notes}</p>}
      {props.mayMove && (
        <form class="day-move" onSubmit={(e) => { e.preventDefault(); void move(); }}>
          <label class="day-move-label" for={`move-${event.id}`}>Move to</label>
          <input id={`move-${event.id}`} class="input day-move-time" type="time" step={300} value={clock} disabled={busy}
            onInput={(e) => setClock((e.currentTarget as HTMLInputElement).value)} />
          <Button type="submit" variant="secondary" class="small" busy={busy} disabled={!target || target.startAt === event.startAt}>Move</Button>
        </form>
      )}
    </div>
  );
}
