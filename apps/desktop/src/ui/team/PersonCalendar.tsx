// A person's next days on their page (B-078 D20, owner: "wenn er auf die Mitarbeiter geht … die Kalender von denen
// auch sehen"): a small read-only list of today and the next two days from calendar.person – their own PC answers
// when it is linked here (an "Only me" to-do there shows as Busy), else their rows on this PC. Offline or no
// calendar: one quiet line saying so. Reloads when the person changes; nothing to click.
// Owns: this list. Never: changes an entry or polls.

import { useEffect, useState } from 'preact/hooks';
import type { PersonCalendar as PersonCalendarData } from '../../shared/model/calendar.ts';
import { rpc } from '../lib/rpc.ts';
import { dayMonth, relativeDay, time } from '../lib/format.ts';

const DAYS = 3;

/** Local midnight of today. */
function today(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "today", "tomorrow", else "30 Oct" – capitalised. */
function dayLabel(ms: number): string {
  const days = Math.round((today(ms) - today()) / 86_400_000);
  const text = days >= 0 && days < 2 ? relativeDay(ms) : dayMonth(ms);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function PersonCalendar(props: { personId: string }) {
  const [data, setData] = useState<PersonCalendarData | null>(null);
  useEffect(() => {
    setData(null);
    let alive = true;
    const from = today();
    const to = new Date(from).setDate(new Date(from).getDate() + DAYS);
    rpc.call('calendar.person', { id: props.personId, from, to }).then(
      (answer) => { if (alive) setData(answer); },
      () => { if (alive) setData({ reachable: false, note: 'The calendar could not be read.', entries: [] }); },
    );
    return () => { alive = false; };
  }, [props.personId]);

  if (!data) return null;
  return (
    <section class="agent-section person-calendar" aria-label="Calendar">
      <h2 class="agent-section-title">Calendar</h2>
      {!data.reachable ? <p class="muted">{data.note ?? 'No calendar of theirs is reachable now.'}</p>
        : data.entries.length ? (
          <ul class="person-list">
            {data.entries.map((entry, index) => (
              <li key={index} class="person-list-row">
                <span class="person-list-text"><span>{entry.title}</span><small class="muted">{dayLabel(entry.startAt)} · {entry.allDay ? 'All day' : `${time(entry.startAt)}–${time(entry.endAt)}`}</small></span>
              </li>
            ))}
          </ul>
        ) : <p class="muted">Nothing in the next {DAYS} days.</p>}
    </section>
  );
}
