// The overview under My day's list, pure: the top lines of the team's report (B-078 D9/D10 – the same rule as Work's
// report, tasks/work-model.ts report: side work, facts and work nobody asked for, the last three days; no stuck or
// finished counts: what needs the person is on the list above), what the agents spent since last night ("$6.10 + €39
// spent", the one place the UI shows it) and which calendar events are still ahead today.
// Owns: these rules (unit-tested in test/unit/day-ui/day-overview.test.ts). Never: imports the store, rpc or the DOM, or
// reads a clock – callers pass data and the time in.

import type { CalendarEvent } from '../../shared/model/calendar.ts';
import type { SpendEntry } from '../../shared/model/security.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { locale } from '../lib/format.ts';
import { report, type ReportLine, type WorkScope } from '../tasks/work-model.ts';

/** Rows of each list before "more". */
export const OVERVIEW_LIMITS = Object.freeze({ ahead: 3, report: 3 });

/** My day's Work block: the report's newest lines, at most OVERVIEW_LIMITS.report. */
export function dayReport<T extends TaskView>(done: readonly T[], now: number, scope: WorkScope = {}): Array<ReportLine<T>> {
  return report(done, now, { scope, max: OVERVIEW_LIMITS.report });
}

/** spend.list's row cap (runtime/rpc/handlers/security.ts SPEND_LIMIT): a full list may be cut. */
const SPEND_CAP = 1000;

/** Cents below 100 ($6.10, $0.42), whole amounts above ($120). */
function moneyText(amount: number, currency: string): string {
  const digits = amount < 100 ? 2 : 0;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

/** "$6.10 + €39 spent": per currency, never converted, amounts above 0 only; "at least …" when the list was cut; '' for nothing. */
export function spentText(entries: readonly SpendEntry[]): string {
  const totals = new Map<string, number>();
  for (const entry of entries) totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + entry.amount);
  const parts = [...totals].filter(([, amount]) => amount > 0).map(([currency, amount]) => moneyText(amount, currency));
  return parts.length ? `${entries.length >= SPEND_CAP ? 'at least ' : ''}${parts.join(' + ')} spent` : '';
}

/** The events (no to-do blocks: the list has those) that have not ended yet, soonest first. */
export function eventsAhead<E extends Pick<CalendarEvent, 'taskId' | 'startAt' | 'endAt'>>(events: readonly E[], now: number): E[] {
  return events.filter((event) => !event.taskId && event.endAt > now).sort((a, b) => a.startAt - b.startAt);
}
