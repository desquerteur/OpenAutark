// The morning briefing on top of My day, pure: today's briefing (a stored one of another day – My day left open
// past midnight – is not shown), its written sentences (at most BRIEFING_LIMITS.lines, not the morning's count
// line – the list below counts live) and one muted line of what happened overnight (when the PC slept while night
// work waited, what was done and prepared and what did not start).
// Owns: these rules (unit-tested in test/unit/day-ui/day-briefing.test.ts). Never: imports the store, rpc or the
// DOM – callers pass data in.

import { BRIEFING_LIMITS, type Briefing, type SleepSpan } from '../../shared/model/calendar.ts';
import { clockOf } from './day-grid.ts';

/** Today's briefing, or null. */
export function briefingFor(briefing: Briefing | null, date: string): Briefing | null {
  return briefing && briefing.date === date ? briefing : null;
}

/** "PC slept 23:10–06:40 – night work paused" (one sleep), "PC slept 2× between 23:10 and 06:40 – …"; '' for none. */
export function sleptFact(slept: readonly SleepSpan[] | undefined, tz: string): string {
  if (!slept?.length) return '';
  const first = slept[0];
  const last = slept[slept.length - 1];
  const when = slept.length === 1
    ? `${clockOf(first.from, tz)}–${clockOf(first.to, tz)}`
    : `${slept.length}× between ${clockOf(first.from, tz)} and ${clockOf(last.to, tz)}`;
  return `PC slept ${when} – night work paused`;
}

/** The muted line: when the PC slept, what was done and prepared overnight and what did not start. Empty: nothing. */
export function overnightFacts(briefing: Pick<Briefing, 'doneTaskIds' | 'preparedTaskIds' | 'waitingToStart' | 'slept'>, tz = 'UTC'): string[] {
  return [
    sleptFact(briefing.slept, tz),
    briefing.doneTaskIds.length ? `${briefing.doneTaskIds.length} done overnight` : '',
    briefing.preparedTaskIds.length ? `${briefing.preparedTaskIds.length} prepared` : '',
    briefing.waitingToStart > 0 ? `${briefing.waitingToStart} not started yet` : '',
  ].filter(Boolean);
}

/** The line the runtime writes without a model (runtime/day/briefing.ts countLines): "Today: 2 to-dos planned, 2 need you." */
function countLine(briefing: Pick<Briefing, 'planned' | 'needsYou'>): string {
  const day = [
    briefing.planned ? `${briefing.planned} ${briefing.planned === 1 ? 'to-do' : 'to-dos'} planned` : '',
    briefing.needsYou ? `${briefing.needsYou} ${briefing.needsYou === 1 ? 'needs' : 'need'} you` : '',
  ].filter(Boolean);
  return day.length ? `Today: ${day.join(', ')}.` : '';
}

/** The briefing's written sentences (the count line left out: the list shows the live numbers). */
export function briefingLines(briefing: Pick<Briefing, 'lines' | 'planned' | 'needsYou'>): string[] {
  const counts = countLine(briefing);
  return briefing.lines.filter((line) => line.trim() && line.trim() !== counts).slice(0, BRIEFING_LIMITS.lines);
}
