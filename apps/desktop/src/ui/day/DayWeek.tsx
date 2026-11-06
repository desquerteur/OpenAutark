// The week in My day's calendar pane (a computer only; Day | Week is a fixed cell of the header): the seven days
// (Monday first) of the week the shown day is in, side by side on one hour scale, opening at the start of work.
// Blocks are the day grid's – events and to-do blocks, titles only in the narrow columns, no drag: a click opens the
// block's popover, a right click or long press its menu (Done · Move to… · Show in list · Remove from calendar).
// Read-mostly: free time is not picked here (that is the Day view). A day's heading opens that day.
// Owns: the week's markup. Never: loads data (the window covers the mini month's six weeks) or adds anything.

import { useLayoutEffect, useRef } from 'preact/hooks';
import { daySettingsOf } from '../../shared/model/day-settings.ts';
import { dayClock } from '../lib/day-store.ts';
import { go } from '../lib/router.ts';
import { settings } from '../lib/store.ts';
import { HOUR_PX, LABEL_ROOM, labelSafeTop, lanes, localMinute, weekOf, workSpan } from './day-grid.ts';
import { dateText } from './day-format.ts';
import { calendarSpan, eventsOn, today } from './day-state.ts';
import { DayBlock } from './DayCalendarBlock.tsx';
import { minuteText } from './DaySlot.tsx';

/** One day of the week: its blocks, and the now line on today. */
function WeekColumn(props: { date: string; tz: string; current: string }) {
  const { date, tz } = props;
  return (
    <div class={`day-week-col${date === props.current ? ' current' : ''}`} aria-label={dateText(date)}>
      {lanes(eventsOn(date, tz).map(({ event, span }) => ({ item: event, span }))).map(({ item, span, lane, lanes: count }) => (
        <DayBlock key={item.id} event={item} date={date} tz={tz} span={span} lane={lane} lanes={count} compact />
      ))}
      {date === props.current && <div class="day-cal-now" style={{ top: `${(localMinute(dayClock.value, tz) / 60) * HOUR_PX}px` }} aria-hidden="true" />}
    </div>
  );
}

export function DayWeek(props: { date: string; tz: string }) {
  const { tz } = props;
  const days = weekOf(props.date);
  const current = today.value;
  const work = workSpan(daySettingsOf(settings.value ?? undefined));
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) { el.scrollTop = Math.max(0, (work.start / 60) * HOUR_PX - LABEL_ROOM); el.scrollTop = labelSafeTop(el.scrollTop); }
  }, [days[0]]);
  const open = (date: string) => { calendarSpan.value = 'day'; go.day(date === current ? undefined : date); };
  return (
    <div class="day-week">
      <div class="day-week-head">
        {days.map((date) => (
          <button key={date} type="button" class={`day-week-day${date === current ? ' current' : ''}${date === props.date ? ' selected' : ''}`} onClick={() => open(date)}>
            {dateText(date).replace(/ \w+$/, '')}
          </button>
        ))}
      </div>
      <div class="day-cal-scroll" ref={scroller}>
        <div class="day-week-grid" style={{ height: `${24 * HOUR_PX}px`, '--day-hour': `${HOUR_PX}px` }}>
          <div class="day-cal-off" style={{ top: 0, height: `${(work.start / 60) * HOUR_PX}px` }} aria-hidden="true" />
          <div class="day-cal-off" style={{ top: `${(work.end / 60) * HOUR_PX}px`, bottom: 0 }} aria-hidden="true" />
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} class="day-cal-hour" style={{ top: `${hour * HOUR_PX}px` }} aria-hidden="true">
              <span class="day-cal-hour-label tabular">{hour ? minuteText(hour * 60) : ''}</span>
            </div>
          ))}
          <div class="day-week-cols">
            {days.map((date) => <WeekColumn key={date} date={date} tz={tz} current={current} />)}
          </div>
        </div>
      </div>
    </div>
  );
}
