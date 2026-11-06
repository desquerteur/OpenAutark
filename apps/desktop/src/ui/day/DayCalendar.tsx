// My day's calendar pane (B-041 §4.1): the day grid of the shown day – the whole day scrolls, opening at the start
// of work, the hours outside work quieter –, the current-time line on today (moved by the day clock and, while the
// grid is visible, once a minute), the blocks of the calendar window (events, to-do blocks with their check,
// read-only calendars dimmed, sources switched off left out; lanes side by side where they overlap). Click a free
// time or drag over it (computer), or step through the hours with the keyboard → an inline field (type or
// dictate) → calendar.add 'auto' for exactly that range (day/DaySlot.tsx). A block has the calendar block menu
// (right click or long press, DayCalendarBlock.tsx). Day | Week is a cell of the header (DayHeader.tsx); on a computer
// the week (DayWeek.tsx) takes the pane's place. A calendar not up to date says so in one line.
// Owns: the grid. Never: loads the window (day-state.ts ensureCalendar, lib/day-store.ts) or polls – the minute tick
// is one timeout, only while shown.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { daySettingsOf } from '../../shared/model/day-settings.ts';
import { calendarWindow, dayClock, dayZone } from '../lib/day-store.ts';
import { isMobile, settings } from '../lib/store.ts';
import { EmptyState, Spinner } from '../lib/ui.tsx';
import { HOUR_PX, LABEL_ROOM, labelSafeTop, lanes, localMinute, spanOn, workSpan } from './day-grid.ts';
import { calendarSpan, calendarStatus, eventsOn, hiddenSources, sources, today, watchSources } from './day-state.ts';
import { DayBlock } from './DayCalendarBlock.tsx';
import { HourStops, SlotField, minuteText, useSlotPicker } from './DaySlot.tsx';
import { DayWeek } from './DayWeek.tsx';

/** Date.now(), moved at each new minute while `active` and the window is visible (the now line). */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState !== 'visible') return;
      timer = setTimeout(() => { setNow(Date.now()); arm(); }, 60_050 - (Date.now() % 60_000));
    };
    const visible = () => { setNow(Date.now()); arm(); };
    document.addEventListener('visibilitychange', visible);
    arm();
    return () => { if (timer !== undefined) clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [active]);
  return now;
}

function DayGrid(props: { date: string; tz: string }) {
  const { date, tz } = props;
  const day = daySettingsOf(settings.value ?? undefined);
  const work = workSpan(day);
  const isToday = date === today.value;
  const now = Math.max(dayClock.value, useMinuteTick(isToday));
  const scroller = useRef<HTMLDivElement>(null);
  const picker = useSlotPicker();
  const { draft, setDraft } = picker;
  const laned = lanes(eventsOn(date, tz).map(({ event, span }) => ({ item: event, span })));

  // Open at the start of work (or an hour before now on today, when that is later).
  useLayoutEffect(() => {
    const at = isToday ? Math.max(work.start, localMinute(Date.now(), tz) - 60) : work.start;
    const el = scroller.current;
    if (el) { el.scrollTop = Math.max(0, (at / 60) * HOUR_PX - LABEL_ROOM); el.scrollTop = labelSafeTop(el.scrollTop); }
    setDraft(null);
  }, [date]);

  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return (
    <div class="day-cal-scroll" ref={scroller}>
      <div class="day-cal-grid" ref={picker.target} style={{ height: `${24 * HOUR_PX}px`, '--day-hour': `${HOUR_PX}px` }}
        {...picker.handlers}>
        <div class="day-cal-off" style={{ top: 0, height: `${(work.start / 60) * HOUR_PX}px` }} aria-hidden="true" />
        <div class="day-cal-off" style={{ top: `${(work.end / 60) * HOUR_PX}px`, bottom: 0 }} aria-hidden="true" />
        {hours.map((hour) => (
          <div key={hour} class="day-cal-hour" style={{ top: `${hour * HOUR_PX}px` }} aria-hidden="true">
            <span class="day-cal-hour-label tabular">{hour ? minuteText(hour * 60) : ''}</span>
          </div>
        ))}
        <div class="day-cal-events">
          <HourStops key={date} start={work.start} onPick={picker.pick} />
          {laned.map(({ item, span, lane, lanes: count }) => (
            <DayBlock key={item.id} event={item} date={date} tz={tz} span={span} lane={lane} lanes={count} />
          ))}
          {draft && <SlotField date={date} tz={tz} span={draft} onClose={picker.close} />}
        </div>
        {isToday && <div class="day-cal-now" style={{ top: `${(localMinute(now, tz) / 60) * HOUR_PX}px` }} aria-hidden="true" />}
      </div>
    </div>
  );
}

/** The day's all-day events (a holiday, a trip) as one quiet row above the grid. */
function AllDay(props: { date: string; tz: string }) {
  const hidden = hiddenSources.value;
  const events = (calendarWindow.value?.list.events ?? []).filter((event) => event.allDay && !hidden.has(event.sourceId) && spanOn(event, props.date, props.tz));
  if (!events.length) return null;
  return (
    <div class="day-cal-allday" aria-label="All day">
      {events.map((event) => <span key={event.id} class="day-block" data-allday="true" data-kind={event.kind} data-readonly={event.readOnly ? 'true' : undefined}>{event.title || 'Event'}</span>)}
    </div>
  );
}

/** The calendar pane: the all-day row, the grid (or the week), a line for calendars not up to date. */
export function DayCalendar(props: { date: string }) {
  useEffect(() => watchSources(), []);
  const tz = dayZone.value;
  const status = calendarStatus.value;
  const window = calendarWindow.value;
  const week = calendarSpan.value === 'week' && !isMobile.value;
  const stale = (window?.list.staleSources ?? []).map((id) => sources.value.find((source) => source.id === id)?.label ?? 'A calendar');
  return (
    <div class="day-cal">
      {stale.length > 0 && <p class="day-cal-stale">Not up to date: {stale.join(', ')}</p>}
      {!window && status === 'loading' && <div class="day-cal-state"><Spinner size={16} label="Loading the calendar" /></div>}
      {!window && status !== 'loading' && <EmptyState>The calendar is not available right now.</EmptyState>}
      {window && !week && <AllDay date={props.date} tz={tz} />}
      {window && (week ? <DayWeek date={props.date} tz={tz} /> : <DayGrid date={props.date} tz={tz} />)}
    </div>
  );
}
