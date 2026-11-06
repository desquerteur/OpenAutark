// Sidebar content for My day (#/day; B-041 §4.1): its header data (dayNavHeader – the destination's
// name, drawn by the frame's side header row, shell/views.ts), a mini month (today and the shown day marked, a dot
// on days with blocks in the loaded calendar window; a day opens it), the connected calendars with
// on/off for each and "Connect a calendar…" – a button and the right-click menu of the whole nav: both open the
// Manager's chat with the request prepared (Google Calendar or a calendar link are connected by the AI; a calendar that
// needs a new sign-in offers "Reconnect…" the same way). Renders with nothing loaded.
// Owns: My day's sidebar. Never: loads the calendar window itself (the view does), changes a
// calendar beyond showing or hiding it, connects one itself, or draws header markup (lib/header.tsx does).

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { CalendarSource } from '../../shared/model/calendar.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import { calendarWindow, dayZone } from '../lib/day-store.ts';
import { go } from '../lib/router.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import type { MenuSection } from '../lib/popover.tsx';
import { IconButton } from '../lib/ui.tsx';
import type { HeaderProps } from '../lib/header.tsx';
import { Toggle } from '../settings/controls.tsx';
import { connectCalendarRequest, setUpWithAi } from '../team/set-up-with-ai.ts';
import { dateText, monthText } from './day-format.ts';
import { datesWithBlocks, monthGrid } from './day-grid.ts';
import { hiddenSources, setSourceVisible, shownDate, sources, today, watchSources } from './day-state.ts';

const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** The first of the month `months` months from `date`'s month. */
function monthFrom(date: string, months: number): string {
  const [y, m] = date.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  return first.toISOString().slice(0, 10);
}

function MiniMonth() {
  const date = shownDate.value;
  const current = today.value;
  const [month, setMonth] = useState(date.slice(0, 7));
  useEffect(() => setMonth(date.slice(0, 7)), [date]);
  const tz = dayZone.value;
  const hidden = hiddenSources.value;
  const events = calendarWindow.value?.list.events;
  const marked = useMemo(() => datesWithBlocks((events ?? []).filter((event) => !hidden.has(event.sourceId)), tz), [events, hidden, tz]); // not on every render
  const first = `${month}-01`;
  const open = (day: string) => go.day(day === current ? undefined : day);
  return (
    <div class="day-month">
      <div class="day-month-head">
        <span class="day-month-title">{monthText(first)}</span>
        <IconButton icon="caret-left" label="Previous month" size="small" onClick={() => setMonth(monthFrom(first, -1).slice(0, 7))} />
        <IconButton icon="caret-right" label="Next month" size="small" onClick={() => setMonth(monthFrom(first, 1).slice(0, 7))} />
      </div>
      <div class="day-month-grid">
        {WEEK.map((name, index) => <span key={`w${index}`} class="day-month-weekday" aria-hidden="true">{name}</span>)}
        {monthGrid(first).map((day) => {
          const classes = [
            'day-month-day', day.slice(0, 7) !== month ? 'outside' : '', day === current ? 'current' : '', day === date ? 'selected' : '',
          ].filter(Boolean).join(' ');
          return (
            <button key={day} type="button" class={classes} aria-current={day === date ? 'date' : undefined}
              aria-label={`${dateText(day)}${marked.has(day) ? ', planned' : ''}`} onClick={() => open(day)}>
              <span class="day-month-num tabular">{Number(day.slice(8))}</span>
              {marked.has(day) && <span class="day-month-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {month !== current.slice(0, 7) && (
        <button type="button" class="text-button day-month-today" onClick={() => { setMonth(current.slice(0, 7)); open(current); }}>Today</button>
      )}
    </div>
  );
}

const STATUS: Partial<Record<CalendarSource['status'], string>> = { error: 'Sync failed', reconnect: 'Needs a new sign-in', syncing: 'Syncing…' };

const connect = () => void setUpWithAi(connectCalendarRequest());
const connectItem = { label: 'Connect a calendar…', onSelect: connect };

/** A calendar's right-click menu: Reconnect… (when it needs it, via the AI) and Connect a calendar…. */
function sourceMenu(source: CalendarSource): MenuSection[] {
  const needs = source.status === 'reconnect' || source.status === 'error';
  return [{ items: [
    ...(needs ? [{ label: 'Reconnect…', onSelect: () => void setUpWithAi(`Reconnect the calendar "${source.label}" to My day. `) }] : []),
    connectItem,
  ] }];
}

function SourceRow(props: { source: CalendarSource }) {
  const { source } = props;
  const menu = useContextMenu(() => sourceMenu(source));
  return (
    <li class="day-source" {...menu}>
      <span class="day-source-dot" style={source.color ? { background: source.color } : undefined} aria-hidden="true" />
      <span class="day-source-text">
        <span class="day-source-label">{source.label}</span>
        {STATUS[source.status] && <span class="day-source-status">{STATUS[source.status]}</span>}
      </span>
      <Toggle checked={source.visible} label={`Show ${source.label}`} onChange={(visible) => void setSourceVisible(source, visible)} />
    </li>
  );
}

function Sources() {
  const list = sources.value;
  if (!list.length) return null;
  return (
    <div class="day-sources">
      <h3 class="day-nav-heading">Calendars</h3>
      <ul class="day-source-list">
        {list.map((source) => <SourceRow key={source.id} source={source} />)}
      </ul>
    </div>
  );
}

/** My day's side header: the destination's name. */
export function dayNavHeader(): HeaderProps {
  return { title: DESTINATIONS.day };
}

export function DayNav() {
  useEffect(() => watchSources(), []);
  const menu = useContextMenu(() => [{ items: [connectItem] }]);
  return (
    <div class="sidebar-section day-nav" {...menu}>
      <MiniMonth />
      <Sources />
      <button type="button" class="sidebar-action" onClick={connect}>Connect a calendar…</button>
    </div>
  );
}
