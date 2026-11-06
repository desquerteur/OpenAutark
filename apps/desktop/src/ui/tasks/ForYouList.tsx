// My day's list (B-041 §4.1, formerly the calm "For you" list): a query over the person's open to-dos
// (store.todos) in My day's groups (ui/day/day-groups.ts) – Needs you · Today (the day's blocks and near timers, by
// time) · Unplanned · Handed off (collapsed: what the person asked others for, ui/day/HandedOff.tsx) · Later
// (collapsed: snoozed, repeating, far timers, due or planned on a later day). Another day than today lists only that
// day's blocks. One item expanded at a time; answered or removed items leave with a short animation. Read at the
// later of the For-you clock and the day clock, so a timer, a due time or a block moves by itself.
// F07 take guard: a to-do whose recorder is recording or holds an unsent take stays open when another one expands,
// and collapsing it asks "Discard recording?"; each mount sweeps unsent takes older than a week (pwa/idb.ts).
// The inputs are My day's own (ui/day/DayInput.tsx) – this list has no add field.
// Owns: the groups' markup, the expanded item, the exit animation and the collapsed toggles.
// Never: lists agent work (the Work view does) or keeps a copy of the to-dos.

import type { ComponentChildren } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import type { TaskView } from '../../shared/model/tasks.ts';
import { EmptyState, Spinner } from '../lib/ui.tsx';
import { loaded, todoClock, todos } from '../lib/store.ts';
import { dayClock, dayRange, dayZone, handedOff, slotOf } from '../lib/day-store.ts';
import { DAY_GROUPS } from '../lib/vocab.ts';
import { heldTakes } from '../blocks/ui/media-devices.ts';
import { sweepTakes } from '../pwa/idb.ts';
import { removedItems, withLeaving } from './model.ts';
import type { Leaving } from './model.ts';
import { HumanItem, holdsTake, letGoOfTake } from './HumanItem.tsx';
import { dayGroups, handedOffRows } from '../day/day-groups.ts';
import { dayTitle } from '../day/day-format.ts';
import { revealRequest, shownDate, today } from '../day/day-state.ts';
import { HandedOffList, ownerName } from '../day/HandedOff.tsx';

const LEAVE_MS = 450;

/**
 * Keeps removed items on screen for the exit animation (answered here or anywhere else).
 * `source` is the whole to-do list: rows that merely left this group (another group)
 * are still open and must not leave with the "done" look.
 */
function useLeaving(items: TaskView[], source: TaskView[]): Array<{ item: TaskView; leaving: boolean }> {
  const previous = useRef<TaskView[]>(items);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [leaving, setLeaving] = useState<Array<Leaving<TaskView>>>([]);
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);
  useEffect(() => {
    const gone = removedItems(previous.current, items, source);
    previous.current = items;
    if (!gone.length) return;
    const ids = new Set(gone.map((entry) => entry.item.id));
    setLeaving((current) => [...current.filter((entry) => !ids.has(entry.item.id)), ...gone]);
    // One timer per removal batch; never cleared by re-renders, only on unmount.
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setLeaving((current) => current.filter((entry) => !ids.has(entry.item.id)));
    }, LEAVE_MS);
    timers.current.add(timer);
  }, [items]);
  return withLeaving(items, leaving);
}

/** A collapsed group ("Later 2", "Handed off 2" – the count as the open groups show it) and, opened, its list (rendered with the id the toggle controls). */
function Collapsed(props: { label: string; count: number; open: boolean; onToggle: () => void; list: (id: string) => ComponentChildren }) {
  const id = useId();
  return (
    <div class="todo-later">
      <button type="button" class="todo-later-toggle" aria-expanded={props.open} aria-controls={id} onClick={props.onToggle}>
        <span>{props.label}</span>{' '}<span class="day-group-count tabular">{props.count}</span>
      </button>
      {props.open && props.list(id)}
    </div>
  );
}

/** One open group: its small heading with the count, its rows (`rows`: how many render, leaving ones included). */
function Group(props: { heading: string; count: number; rows: number; children: ComponentChildren }) {
  const id = useId();
  return (
    <section class="day-group" aria-labelledby={id}>
      <h3 class="day-group-heading" id={id}>{props.heading}{props.count > 0 && <span class="day-group-count tabular">{props.count}</span>}</h3>
      {props.rows > 0 && <ul class="todo-list" aria-label={props.heading}>{props.children}</ul>}
    </section>
  );
}

export function ForYouList() {
  const all = todos.value;
  const now = Math.max(todoClock.value, dayClock.value);
  const tz = dayZone.value;
  const date = shownDate.value;
  const isToday = date === today.value;
  const slots = slotOf.value;
  const range = useMemo(() => dayRange(date, tz), [date, tz]);
  const groups = useMemo(
    () => dayGroups(all, { now, dayStart: range.from, dayEnd: range.to, isToday, slots, date }),
    [all, now, range, isToday, slots, date],
  );
  const handed = useMemo(() => (isToday ? handedOffRows(handedOff.value, all, ownerName, now) : []), [isToday, handedOff.value, all, now]);
  // Read here (not only inside the memo) so the list re-renders when a recorder holds or lets go.
  const held = heldTakes.value;
  const [laterOpen, setLaterOpen] = useState(false);
  const [handedOpen, setHandedOpen] = useState(false);
  const needsRows = useLeaving(groups.needsYou, all);
  const todayRows = useLeaving(groups.today, all);
  const unplannedRows = useLeaving(groups.unplanned, all);
  const laterRows = useLeaving(laterOpen ? groups.later : [], all);
  const [expanded, setExpanded] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const listed = useMemo(() => [...groups.needsYou, ...groups.today, ...groups.unplanned, ...(laterOpen ? groups.later : [])], [groups, laterOpen]);
  // Unsent takes older than a week go, also those of to-dos answered elsewhere (no widget mounts again).
  useEffect(() => { void sweepTakes(); }, []);

  // A to-do that left the list (or went into a closed "Later") cannot stay expanded.
  useEffect(() => {
    if (expanded && !listed.some((task) => task.id === expanded)) setExpanded(null);
  }, [listed, expanded]);

  // Another part of My day asks for a row (the calendar's "Show in list", a handed-off step): open and show it.
  const reveal = revealRequest.value;
  useEffect(() => {
    if (!reveal) return;
    if (groups.later.some((task) => task.id === reveal.id)) setLaterOpen(true);
    if (!all.some((task) => task.id === reveal.id)) return;
    setExpanded(reveal.id);
    requestAnimationFrame(() => root.current?.querySelector(`[data-task-id="${CSS.escape(reveal.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, [reveal?.seq]);

  // One item expanded at a time, except a recording one: it stays open until sent or discarded.
  const isOpen = (task: TaskView) => expanded === task.id || holdsTake(task, held);
  const toggle = async (task: TaskView) => {
    if (!isOpen(task)) { setExpanded(task.id); return; }
    if (!(await letGoOfTake(task))) return; // "Discard recording?" – Cancel keeps it open
    setExpanded((current) => (current === task.id ? null : current));
  };
  const row = ({ item: task, leaving }: { item: TaskView; leaving: boolean }) => (
    <HumanItem key={task.id} task={task} leaving={leaving} expanded={isOpen(task)} now={now} slot={slots.get(task.id)} onToggle={() => void toggle(task)} />
  );

  const empty = !needsRows.length && !todayRows.length && !unplannedRows.length && !handed.length && !groups.later.length;
  return (
    <div class="for-you" ref={root}>
      {needsRows.length > 0 && <Group heading={DAY_GROUPS.needsYou} count={groups.needsYou.length} rows={needsRows.length}>{needsRows.map(row)}</Group>}
      {todayRows.length > 0 && (
        <Group heading={isToday ? DAY_GROUPS.today : dayTitle(date, today.value)} count={groups.today.length} rows={todayRows.length}>{todayRows.map(row)}</Group>
      )}
      {unplannedRows.length > 0 && <Group heading={DAY_GROUPS.unplanned} count={groups.unplanned.length} rows={unplannedRows.length}>{unplannedRows.map(row)}</Group>}
      {empty && (loaded.value ? <EmptyState>{isToday ? 'Nothing for today.' : 'Nothing planned.'}</EmptyState> : <Spinner />)}
      {handed.length > 0 && (
        <Collapsed label={DAY_GROUPS.handedOff} count={handed.length} open={handedOpen} onToggle={() => setHandedOpen(!handedOpen)}
          list={(id) => <HandedOffList id={id} rows={handed} />} />
      )}
      {(groups.later.length > 0 || laterRows.length > 0) && (
        <Collapsed label={DAY_GROUPS.later} count={groups.later.length} open={laterOpen} onToggle={() => setLaterOpen(!laterOpen)}
          list={(id) => <ul class="todo-list" id={id} aria-label={DAY_GROUPS.later}>{laterRows.map(row)}</ul>} />
      )}
    </div>
  );
}
