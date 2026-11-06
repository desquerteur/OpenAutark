// A schedule's rule in words (ui/chat/composer/schedule-rule.ts): the composer's "Sends <rule>" line and the Chat details
// list say the same thing – weekdays and times, intervals, a simple cron rule read back, dates in the rule's zone.
// Owns: these assertions only. Never: renders anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeats, ruleLine, ruleWords } from '../../../src/ui/chat/composer/schedule-rule.ts';
import type { ScheduleSpec } from '../../../src/shared/model/tasks.ts';

const TZ = 'Europe/Berlin';
const NOW = Date.UTC(2026, 9, 31, 12, 30, 45); // Sat 31 Oct 2026, 13:30:45 in Berlin
const H = 3_600_000;
const words = (spec: ScheduleSpec) => ruleWords(spec, { tz: TZ, now: NOW });

test('clock times on weekdays', () => {
  assert.equal(words({ times: ['09:00'], tz: TZ }), 'every day at 09:00');
  assert.equal(words({ times: ['09:00'], days: [0, 1, 2, 3, 4, 5, 6] }), 'every day at 09:00');
  assert.equal(words({ times: ['09:00'], days: [1] }), 'every Monday at 09:00');
  assert.equal(words({ times: ['09:00'], days: [1, 2, 3, 4, 5] }), 'every weekday at 09:00');
  assert.equal(words({ times: ['10:00'], days: [0, 6] }), 'every weekend at 10:00');
  assert.equal(words({ times: ['09:00'], days: [5, 3, 1] }), 'on Mon, Wed, Fri at 09:00');
  assert.equal(words({ times: ['09:00', '13:30'] }), 'every day at 09:00, 13:30');
  assert.equal(ruleLine({ times: ['09:00'], days: [1] }, { tz: TZ, now: NOW }), 'Every Monday at 09:00');
});

test('intervals', () => {
  assert.equal(words({ everyMs: 2 * H }), 'every 2 hours');
  assert.equal(words({ everyMs: H }), 'every hour');
  assert.equal(words({ everyMs: 60_000 }), 'every minute');
  assert.equal(words({ everyMs: 90 * 60_000 }), 'every 90 minutes');
  assert.equal(words({ everyMs: 86_400_000 * 14 }), 'every 2 weeks');
  assert.equal(words({ everyMs: 900_000, days: [1, 2, 3, 4, 5] }), 'every 15 minutes on weekdays');
  assert.equal(words({ everyMs: 7_200_000, days: [1] }), 'every 2 hours on Mondays');
  assert.equal(words({ everyMs: 900_000, window: { from: '09:00', to: '17:00' } }), 'every 15 minutes between 09:00–17:00');
});

test('cron: a simple rule is read back as days and a time, any other stays a cron rule', () => {
  assert.equal(words({ cron: '0 9 * * 1' }), 'every Monday at 09:00');
  assert.equal(words({ cron: '30 8 * * 1-5' }), 'every weekday at 08:30');
  assert.equal(words({ cron: '0 18 * * 0,6' }), 'every weekend at 18:00');
  assert.equal(words({ cron: '15 7 * * *' }), 'every day at 07:15');
  assert.equal(words({ cron: '*/5 * * * *' }), 'on the cron rule */5 * * * *');
  assert.equal(words({ cron: '0 9 1 * *' }), 'on the cron rule 0 9 1 * *');
});

test('a one-off says today, tomorrow or the date (with the year when it is not this one)', () => {
  assert.equal(words({ at: Date.UTC(2026, 9, 31, 17, 0) }), 'today at 18:00');
  assert.equal(words({ at: Date.UTC(2026, 10, 1, 8, 30) }), 'tomorrow at 09:30');
  assert.equal(words({ at: Date.UTC(2026, 10, 3, 8, 30) }), 'on Tue 3 Nov at 09:30');
  assert.equal(words({ at: Date.UTC(2027, 0, 1, 8, 0) }), 'on Fri 1 Jan 2027 at 09:00');
});

test('start and end: from … until …, the whole day without a time', () => {
  const start = Date.UTC(2026, 10, 2, 8, 0); // Mon 2 Nov 09:00
  const end = Date.UTC(2026, 10, 30, 23, 0) - 1; // the end of 30 Nov in Berlin
  assert.equal(words({ times: ['09:00'], days: [1], at: start, until: end }), 'every Monday at 09:00 from Mon 2 Nov 09:00 until Mon 30 Nov');
  assert.equal(words({ times: ['09:00'], at: Date.UTC(2026, 10, 1, 23, 0) }), 'every day at 09:00 from Mon 2 Nov', 'a start at midnight is just the day');
  assert.equal(words({ everyMs: H, at: start }), 'every hour', 'an interval\'s anchor is not a start');
  assert.equal(words({ times: ['09:00'], at: NOW - H }), 'every day at 09:00', 'a start that has passed says nothing');
  assert.equal(words({ times: ['09:00'], maxRuns: 5, except: ['2026-11-11'] }), 'every day at 09:00, 5 runs in all, skipping 1 date');
});

test('which rules repeat', () => {
  assert.equal(repeats({ at: NOW }), false);
  assert.equal(repeats(null), false);
  for (const spec of [{ cron: '0 9 * * 1' }, { everyMs: H }, { times: ['09:00'] }] as ScheduleSpec[]) assert.equal(repeats(spec), true);
});
