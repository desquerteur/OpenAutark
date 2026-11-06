// My day (#/day, #/day/<YYYY-MM-DD>; B-041 §4): the person's own day – everything they do themselves and what they
// handed off, next to their calendar. The header (lib/header.tsx, day/DayHeader.tsx): "My day" and the date with
// ‹ › (it always opens on today); on a phone the date is a row of its own. Under it today's briefing (day/
// DayBriefing.tsx), the input row (day/DayInput.tsx) and the list (tasks/ForYouList: Needs you · Today · Unplanned ·
// Handed off · Later) with today's overview under it (day/DayOverview.tsx: chats that matter, work) beside the calendar pane (day/DayCalendar.tsx: the day grid). A narrow column and a phone
// show the list or the calendar (List | Calendar – on a computer a row of its own above them, never in the header
// row, where it would run under the frame's cells; the phone opens on the list). On a computer a fixed Day | Week cell
// in the header switches the calendar pane to the week, which then takes the list's width too (wide view). Planning,
// estimates and timers are not controls here: the AI plans the day by itself and does the rest when it is asked in
// the input. Home is this view: the default route shows it.
// The view asks for the calendar range it needs (day-state.ts ensureCalendar) when the day changes.
// Owns: the My day view's layout. Never: data loading of its own (lib/day-store.ts, lib/store.ts) or a copy of the
// to-dos.

import { useEffect } from 'preact/hooks';
import { Header } from '../lib/header.tsx';
import { isMobile } from '../lib/store.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import { ForYouList } from '../tasks/ForYouList.tsx';
import { DayBriefing } from './DayBriefing.tsx';
import { DayCalendar } from './DayCalendar.tsx';
import { DayToolbar, SpanSwitch, dayHeader } from './DayHeader.tsx';
import { DayInput } from './DayInput.tsx';
import { DayOverview } from './DayOverview.tsx';
import { calendarSpan, dayLayout, ensureCalendar, shownDate } from './day-state.ts';

/** List | Calendar for a narrow column or a phone. */
function LayoutSwitch() {
  const current = dayLayout.value;
  return (
    <div class="day-switch" role="tablist" aria-label="Show">
      {(['list', 'calendar'] as const).map((layout) => (
        <button key={layout} type="button" role="tab" class={`day-seg${current === layout ? ' current' : ''}`} aria-selected={current === layout}
          onClick={() => { dayLayout.value = layout; }}>{layout === 'list' ? 'List' : 'Calendar'}</button>
      ))}
    </div>
  );
}

export function DayView() {
  const title = DESTINATIONS.day;
  const date = shownDate.value;
  const mobile = isMobile.value;
  const week = !mobile && calendarSpan.value === 'week';
  useEffect(() => { void ensureCalendar(date); }, [date]);
  useEffect(() => { if (mobile) dayLayout.value = 'list'; }, [mobile]); // the phone opens on the list
  return (
    <div class="day-view">
      {!mobile && <Header {...dayHeader({ title, date, children: <SpanSwitch /> })} />}
      <div class="day-scroll">
        <div class={`day-body${week ? ' week' : ''}`} data-layout={dayLayout.value}>
          {!mobile && <LayoutSwitch />}
          <div class="day-main">
            {mobile && <div class="day-toolbar-row"><DayToolbar date={date}><LayoutSwitch /></DayToolbar></div>}
            <div class="day-listpane">
              <DayBriefing />
              <DayInput />
              <section class="day-list" aria-label={title}>
                <ForYouList />
                <DayOverview />
              </section>
            </div>
          </div>
          <aside class="day-cal-pane" aria-label="Calendar">
            <DayCalendar date={date} />
          </aside>
        </div>
      </div>
    </div>
  );
}
