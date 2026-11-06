// My day's header controls (B-041 §4.1): the date with ‹ › (the title goes back to today; the view always opens on
// today; while the week shows, ‹ › step a week). On a computer they sit in the header's title cell beside "My day",
// followed by the fixed Day | Week cell; on a phone they are a row of their own (no week there) with the List |
// Calendar switch (the caller's child) at its end, so the input and the list move up.
// Nothing moves under the cursor: the date has one fixed width that fits its longest label. Every control in it is
// as tall as the icon buttons (28 px), also on a phone (its touch area grows invisibly).
// Owns: these controls and the header data. Never: plans or sets timers – the AI does, from text.

import type { ComponentChildren } from 'preact';
import { go } from '../lib/router.ts';
import { isMobile } from '../lib/store.ts';
import { IconButton } from '../lib/ui.tsx';
import type { HeaderProps } from '../lib/header.tsx';
import { dayTitle, shiftDate } from './day-format.ts';
import { calendarSpan, dayLayout, today } from './day-state.ts';

/** Opens `date` (today without a date in the route). */
function openDate(date: string): void {
  go.day(date === today.peek() ? undefined : date);
}

/** Day | Week of the calendar pane: one fixed cell of the header (a computer only). Picking one also shows the calendar in a narrow view. */
export function SpanSwitch() {
  const current = calendarSpan.value;
  return (
    <div class="day-span" role="tablist" aria-label="Calendar view">
      {(['day', 'week'] as const).map((span) => (
        <button key={span} type="button" role="tab" class={`day-seg${current === span ? ' current' : ''}`} aria-selected={current === span}
          onClick={() => { calendarSpan.value = span; dayLayout.value = 'calendar'; }}>{span === 'day' ? 'Day' : 'Week'}</button>
      ))}
    </div>
  );
}

/** The controls: ‹ date ›; the caller's child at the end. */
export function DayToolbar(props: { date: string; children?: ComponentChildren }) {
  const { date } = props;
  const current = today.value;
  const week = calendarSpan.value === 'week' && !isMobile.value;
  const step = week ? 7 : 1;
  return (
    <div class="day-toolbar">
      <span class="day-datenav">
        <IconButton icon="caret-left" label={week ? 'Previous week' : 'Previous day'} size="small" onClick={() => openDate(shiftDate(date, -step))} />
        <button type="button" class="day-date" disabled={date === current} title={date === current ? undefined : 'Back to today'} onClick={() => openDate(current)}>
          {dayTitle(date, current)}
        </button>
        <IconButton icon="caret-right" label={week ? 'Next week' : 'Next day'} size="small" onClick={() => openDate(shiftDate(date, step))} />
      </span>
      {props.children}
    </div>
  );
}

/** My day's desktop header: "My day" with the controls in the title cell. */
export function dayHeader(props: { title: string; date: string; children?: ComponentChildren }): HeaderProps {
  return {
    zone: 'main', class: 'day-header',
    title: (
      <span class="day-head">
        <h2 class="frame-header-text">{props.title}</h2>
        <DayToolbar date={props.date}>{props.children}</DayToolbar>
      </span>
    ),
  };
}
