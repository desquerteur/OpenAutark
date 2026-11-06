// B-044 shared limit texts (ui/lib/limits.ts) used by the quota rail and the account rows: window
// labels, the share left ('–' once a reset has passed), the countdown with its clock time, the two
// fixed plan slots ('–' while a reading is missing) and the Codex reset texts.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countdown, leftOf, limitSlots, nextCredit, otherWindows, PLAN_SLOTS, resetButtonLabel, resetClock, resetConfirmText, resetOutcomeText,
  resetExpiryText, resetsAvailableText, windowLabel, windowText, shortWait, fiveHourOf,
} from '../../../src/ui/lib/limits.ts';
import { relative, resetTime, time } from '../../../src/ui/lib/format.ts';
import type { AccountLimits } from '../../../src/shared/model/providers.ts';

const NOW = Date.UTC(2026, 9, 25, 12, 13, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('windowLabel and leftOf: humanized names; the share left, unknown once the reset has passed', () => {
  assert.deepEqual(['5h', 'weekly', 'weekly-opus', '90m-spark'].map(windowLabel), ['5-hour limit', 'Weekly', 'Weekly · Opus', '90m-spark']);
  assert.equal(leftOf({ name: '5h', windowMinutes: 300, usedPercent: 36.4, resetsAt: NOW + HOUR }, NOW), 64);
  assert.equal(leftOf({ name: '5h', windowMinutes: 300, usedPercent: 120 }, NOW), 0);
  assert.equal(leftOf({ name: '5h', windowMinutes: 300, usedPercent: 10, resetsAt: NOW }, NOW), undefined);
});

test('countdown: minutes, hours and minutes within a day, the relative format beyond', () => {
  assert.equal(countdown(NOW + 45 * MIN, NOW), 'in 45 min');
  assert.equal(countdown(NOW + 2 * HOUR + 14 * MIN, NOW), 'in 2 h 14 min');
  assert.equal(countdown(NOW + 3 * HOUR, NOW), 'in 3 h');
  assert.equal(countdown(NOW + 3 * DAY, NOW), relative(NOW + 3 * DAY, NOW));
  assert.equal(countdown(NOW + 20_000, NOW), relative(NOW + 20_000, NOW));
  // beyond a day: calendar days, so the word matches the weekday after it (Tuesday 23:49 → Thursday 02:47 is not "tomorrow")
  const tuesdayNight = new Date(2026, 9, 27, 23, 49).getTime();
  assert.equal(countdown(new Date(2026, 9, 29, 2, 47).getTime(), tuesdayNight), 'in 2 days');
  assert.equal(countdown(new Date(2026, 9, 31, 4, 47).getTime(), tuesdayNight), 'in 4 days', 'Saturday is four calendar days away');
  assert.equal(countdown(new Date(2026, 9, 28, 23, 0).getTime(), new Date(2026, 9, 27, 0, 10).getTime()), 'tomorrow', 'Tuesday 00:10 → Wednesday 23:00');
});

test('resetClock and windowText: "64% left · resets in 2 h 14 min (14:27)"; the clock is the day and time beyond a day', () => {
  const at = NOW + 2 * HOUR + 14 * MIN;
  assert.equal(resetClock(at, NOW), time(at));
  assert.notEqual(resetClock(NOW + 3 * DAY, NOW), time(NOW + 3 * DAY), 'a weekday goes with the time');
  assert.equal(resetClock(NOW + 10 * DAY, NOW), resetTime(NOW + 10 * DAY));
  assert.equal(windowText({ name: '5h', windowMinutes: 300, usedPercent: 36, resetsAt: at }, NOW), `64% left · resets in 2 h 14 min (${time(at)})`);
  assert.equal(windowText({ name: 'weekly', windowMinutes: 10080, usedPercent: 50 }, NOW), '50% left');
  assert.equal(windowText(undefined, NOW), '–');
  assert.equal(windowText({ name: '5h', windowMinutes: 300, usedPercent: 99, resetsAt: NOW - 1 }, NOW), '–', 'a passed reset is no reading');
});

test('limitSlots: always the 5-hour and the weekly slot, "–" while missing; other windows only for the tooltip', () => {
  assert.deepEqual(PLAN_SLOTS, ['5h', 'weekly']);
  const empty = limitSlots(undefined, NOW);
  assert.deepEqual(empty, [{ name: '5h', label: '5-hour limit', line: '5-hour limit · –' }, { name: 'weekly', label: 'Weekly', line: 'Weekly · –' }]);
  const limits: AccountLimits = { readAt: NOW, windows: [
    { name: 'weekly-opus', windowMinutes: 10080, usedPercent: 20 },
    { name: 'weekly', windowMinutes: 10080, usedPercent: 25 },
  ] };
  const slots = limitSlots(limits, NOW);
  assert.deepEqual(slots.map((slot) => [slot.name, slot.left]), [['5h', undefined], ['weekly', 75]], 'a Pro plan without a 5-hour window keeps its slot');
  assert.equal(slots[1].line, 'Weekly · 75% left');
  assert.deepEqual(otherWindows(limits, NOW), ['Weekly · Opus · 80% left']);
});

test('Codex reset texts: the button keeps its slot, the confirm says count, expiry and that it is final; the outcome toast', () => {
  const resets = { available: 2, credits: [{ id: 'rc_old', expiresAt: NOW - 1 }, { id: 'rc_soon', expiresAt: NOW + DAY }, { id: 'rc_late', expiresAt: NOW + 9 * DAY }] };
  assert.equal(nextCredit(resets, NOW)?.id, 'rc_soon', 'an expired credit is skipped');
  assert.equal(nextCredit({ available: 1 }, NOW), undefined, 'only the count is known: the provider picks');
  assert.deepEqual([resetButtonLabel(resets), resetButtonLabel({ available: 0 }), resetButtonLabel(undefined)], ['Use reset (2)', 'Use reset (0)', 'Use reset (–)']);
  assert.equal(resetConfirmText(resets, NOW), `Restores your 5-hour and weekly limits now. 2 resets left; this one expires ${resetTime(NOW + DAY)}. This cannot be undone.`);
  assert.equal(resetConfirmText({ available: 1 }, NOW), 'Restores your 5-hour and weekly limits now. 1 reset left. This cannot be undone.');
  assert.deepEqual([resetsAvailableText(1), resetsAvailableText(3)], ['1 reset available', '3 resets available']);
  const soon = nextCredit(resets, NOW);
  assert.equal(resetExpiryText(soon), `Next expires ${resetTime(NOW + DAY)}`, 'the row\'s tooltip: when the credit a reset uses expires');
  assert.equal(resetsAvailableText(2, soon), `2 resets available · Next expires ${resetTime(NOW + DAY)}`);
  assert.equal(resetsAvailableText(0, soon), '0 resets available', 'no expiry without a reset');
  assert.equal(resetExpiryText({ id: 'rc_forever' }), undefined, 'a credit without an expiry names none');
  assert.equal(resetOutcomeText('reset').ok, true);
  assert.deepEqual(resetOutcomeText('alreadyRedeemed'), resetOutcomeText('reset'), 'the same attempt went through before: done');
  assert.equal(resetOutcomeText('nothingToReset').ok, false);
  assert.equal(resetOutcomeText('noCredit').title, 'No reset available');
});

test('B-078 rail: the short wait to the 5-hour reset and the 5-hour ring only where the plan has that window', () => {
  assert.equal(shortWait(NOW + 42 * MIN, NOW), '42m');
  assert.equal(shortWait(NOW + 2 * HOUR + 5 * MIN, NOW), '2h 5m');
  assert.equal(shortWait(NOW + 3 * HOUR, NOW), '3h');
  assert.equal(shortWait(NOW + 20_000, NOW), '<1m');
  assert.equal(shortWait(NOW - MIN, NOW), undefined);
  const weeklyOnly: AccountLimits = { windows: [{ name: 'weekly', windowMinutes: 10_080, usedPercent: 30, resetsAt: NOW + 3 * DAY }], readAt: NOW };
  assert.equal(fiveHourOf(weeklyOnly, NOW), undefined, 'no 5-hour window: no ring');
  assert.equal(fiveHourOf(undefined, NOW), undefined);
  const both: AccountLimits = { windows: [{ name: '5h', windowMinutes: 300, usedPercent: 64, resetsAt: NOW + 42 * MIN }, weeklyOnly.windows[0]], readAt: NOW };
  assert.deepEqual(fiveHourOf(both, NOW), { left: 36, resetsAt: NOW + 42 * MIN });
  assert.deepEqual(fiveHourOf(both, NOW + HOUR), {}, 'the reset passed: the track alone');
});
