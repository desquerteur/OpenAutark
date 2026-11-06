// The overview under My day's list (src/ui/day/day-overview.ts, B-078): the Work block's top three report lines (the
// same rule as Work's report – no stuck or finished counts), the money line, the events still ahead.
// Owns: these assertions only. Never: the DOM, rpc or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpendEntry } from '../../../src/shared/model/security.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { locale } from '../../../src/ui/lib/format.ts';
import { OVERVIEW_LIMITS, dayReport, eventsAhead, spentText } from '../../../src/ui/day/day-overview.ts';
import { report } from '../../../src/ui/tasks/work-model.ts';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 9);
let seq = 0;

function task(patch: Partial<TaskView> = {}): TaskView {
  seq++;
  return {
    id: `task_${seq}`, title: `Task ${seq}`, notes: '', status: 'done', assigneeKind: 'agent', assigneeId: 'ag_mara', createdBy: 'ag_mara', priority: 0,
    dependsOn: [], ledger: {}, attempts: 0, sort: seq, rev: 1, createdAt: NOW - 5 * H, updatedAt: NOW - H, completedAt: NOW - seq * 60_000, steps: [], progress: { done: 0, total: 0 },
    conversationTitle: '', running: false, result: { summary: `Result ${seq}`, evidence: [], verification: 'claimed_by_agent' },
    origin: { source: 'schedule:sch_1', label: 'Routine' }, ...patch, // work nobody asked for: a routine's
  } as TaskView;
}

test('the Work block: the report\'s newest three lines – the same lines Work shows first', () => {
  const done = [task(), task({ result: { summary: 'x', evidence: [], verification: 'claimed_by_agent', alsoHandled: ['Renewed the domain'] }, createdBy: 'human' }), task(), task(), task()];
  const lines = dayReport(done, NOW);
  assert.equal(lines.length, OVERVIEW_LIMITS.report);
  assert.deepEqual(lines.map((line) => line.key), report(done, NOW).slice(0, 3).map((line) => line.key));
  assert.equal(lines[1].text, 'Renewed the domain', 'side work the person asked nothing about is a line; their own request\'s result is not');
  assert.deepEqual(dayReport([task({ status: 'open', completedAt: undefined })], NOW), [], 'open work is no report');
});

test('ahead: events that have not ended, soonest first; to-do blocks stay with the list', () => {
  const later = { startAt: NOW + 3 * H, endAt: NOW + 4 * H };
  const running = { startAt: NOW - H, endAt: NOW + H };
  const over = { startAt: NOW - 3 * H, endAt: NOW - H };
  const block = { startAt: NOW + H, endAt: NOW + 2 * H, taskId: 'task_1' };
  assert.deepEqual(eventsAhead([later, over, block, running], NOW), [running, later]);
});

test('money: per currency, never converted, amounts above 0; "at least" for a cut list; nothing: empty', () => {
  const cash = (amount: number, currency: string, digits: number) => new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  const entry = (amount: number, currency: string): SpendEntry => ({ id: `s${seq++}`, agentId: 'ag_mara', amount, currency, kind: 'purchase', createdAt: NOW });
  assert.equal(spentText([]), '');
  assert.equal(spentText([entry(0, 'USD')]), '');
  assert.equal(spentText([entry(4, 'USD'), entry(2.1, 'USD'), entry(120, 'EUR')]), `${cash(6.1, 'USD', 2)} + ${cash(120, 'EUR', 0)} spent`);
  assert.match(spentText(Array.from({ length: 1000 }, () => entry(1, 'USD'))), /^at least /);
});
