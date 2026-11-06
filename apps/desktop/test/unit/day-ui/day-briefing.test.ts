// The briefing on top of My day (src/ui/day/day-briefing.ts): today's briefing only, its written lines without the
// morning's count line, the overnight facts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Briefing } from '../../../src/shared/model/calendar.ts';
import { briefingFor, briefingLines, overnightFacts, sleptFact } from '../../../src/ui/day/day-briefing.ts';

const briefing = (patch: Partial<Briefing> = {}): Briefing => ({
  date: '2026-10-31', lines: [], planned: 0, needsYou: 0, doneTaskIds: [], preparedTaskIds: [], waitingToStart: 0, chats: [], createdAt: 0, ...patch,
}) as Briefing;

test('only today\'s briefing shows', () => {
  assert.equal(briefingFor(null, '2026-10-31'), null);
  assert.equal(briefingFor(briefing({ date: '2026-10-30' }), '2026-10-31'), null);
  assert.ok(briefingFor(briefing(), '2026-10-31'));
});

test('written lines without the count line, at most three', () => {
  const lines = briefingLines(briefing({ planned: 2, needsYou: 2, lines: ['Today: 2 to-dos planned, 2 need you.', 'Taxes are due.', ' ', 'Mara found a flight.'] }));
  assert.deepEqual(lines, ['Taxes are due.', 'Mara found a flight.']);
  assert.equal(briefingLines(briefing({ lines: ['a', 'b', 'c', 'd', 'e'] })).length, 3);
});

test('the overnight facts: sleep, done, prepared, not started', () => {
  assert.deepEqual(overnightFacts(briefing({ doneTaskIds: ['a', 'b'], preparedTaskIds: ['c'], waitingToStart: 1 })), ['2 done overnight', '1 prepared', '1 not started yet']);
  assert.deepEqual(overnightFacts(briefing()), []);
  assert.equal(sleptFact(undefined, 'UTC'), '');
  assert.match(sleptFact([{ from: Date.UTC(2026, 9, 30, 23, 10), to: Date.UTC(2026, 9, 31, 6, 40) }], 'UTC'), /^PC slept 23:10–06:40 – night work paused$/);
});
