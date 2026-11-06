// B-044 schedules: clock `times` each local day (src/runtime/schedules/spec.ts) – validation, the
// earliest next time over all times in the spec's zone, weekdays/except/until/"not before", the DST
// days of 25.10.2026 and 28.03.2027 in Berlin, previews and the calendar's agent lane (an older
// unanchored interval runs from its next run); stored specs without `times` stay as they were; the
// launcher's next-due.json (src/runtime/schedules/next-due.ts): the scheduler reports each arm, only a
// changed time is written, writes are serialised and the newest wins, a failed write is logged; the
// scheduler's stop settles it (the last value on disk, no temp file – also none a crash left).
// Owns: these assertions only. Never: real timers or the real data folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firesBetween, isOneOff, localParts, nextFire, validateSpec, wallInstant } from '../../../src/runtime/schedules/spec.ts';
import { previewTimes } from '../../../src/runtime/schedules/preview.ts';
import { NextDueFile } from '../../../src/runtime/schedules/next-due.ts';
import { SchedulerImpl } from '../../../src/runtime/schedules/scheduler.ts';
import { agentRuns } from '../../../src/runtime/calendar/agent-runs.ts';
import { agent, harness } from '../chat/harness.ts';
import type { Schedule } from '../../../src/shared/model/tasks.ts';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const TZ = 'Europe/Berlin';
const local = (ms: number) => { const p = localParts(ms, TZ); return `${p.date} ${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`; };
const MON = Date.UTC(2026, 9, 19, 8, 0); // Mon 19 Oct 2026, 10:00 in Berlin (CEST)
const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-times-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('validateSpec: times are 1–24 different HH:MM and exclude cron and everyMs', () => {
  assert.equal(validateSpec({ times: ['09:00', '13:30', '18:00'], tz: TZ }), undefined);
  for (const times of [[], ['9:00'], ['24:00'], ['09:00', '09:00'], Array.from({ length: 25 }, (_, i) => `${String(i % 24).padStart(2, '0')}:${String(i).padStart(2, '0')}`)]) {
    assert.match(validateSpec({ times })!, /"times" must list 1 to 24 different HH:MM times/, JSON.stringify(times));
  }
  assert.match(validateSpec({ times: ['09:00'], cron: '0 9 * * *' })!, /only one of/);
  assert.equal(isOneOff({ at: MON, times: ['09:00'] }), false, '`at` with times is "not before"');
  assert.equal(isOneOff({ at: MON }), true);
});

test('several times a day: the earliest next time over all times, in the zone, day after day', () => {
  const spec = { times: ['18:00', '09:00', '13:30'], tz: TZ };
  assert.deepEqual(firesBetween(spec, MON, MON + D, 10).map(local), ['2026-10-19 13:30', '2026-10-19 18:00', '2026-10-20 09:00']);
  assert.equal(local(nextFire(spec, wallInstant('2026-10-19', 18 * 60, TZ))!), '2026-10-20 09:00', 'strictly after');
  const weekdays = { ...spec, days: [1, 2, 3, 4, 5] };
  assert.deepEqual(firesBetween(weekdays, wallInstant('2026-10-23', 19 * 60, TZ), wallInstant('2026-10-26', 10 * 60, TZ)).map(local), ['2026-10-26 09:00'], 'the weekend is skipped');
  const skipped = { ...spec, except: ['2026-10-20'], until: wallInstant('2026-10-21', 12 * 60, TZ) };
  assert.deepEqual(firesBetween(skipped, MON, MON + 5 * D).map(local), ['2026-10-19 13:30', '2026-10-19 18:00', '2026-10-21 09:00']);
  const later = { ...spec, at: wallInstant('2026-10-21', 10 * 60, TZ) };
  assert.equal(local(nextFire(later, MON)!), '2026-10-21 13:30', '`at` is "not before"');
  assert.deepEqual(previewTimes(spec, MON).map(local), ['2026-10-19 13:30', '2026-10-19 18:00', '2026-10-20 09:00']);
  const windowed = { times: ['08:00', '12:00', '20:00'], tz: TZ, window: { from: '09:00', to: '18:00' } };
  assert.deepEqual(firesBetween(windowed, MON, MON + 2 * D).map(local), ['2026-10-19 12:00', '2026-10-20 12:00']);
});

test('the DST days in Berlin: the wall times stay, the 25-hour and 23-hour days included', () => {
  const spec = { times: ['01:30', '02:30', '09:00'], tz: TZ };
  const autumn = firesBetween(spec, wallInstant('2026-10-24', 12 * 60, TZ), wallInstant('2026-10-26', 12 * 60, TZ));
  assert.deepEqual(autumn.map(local), ['2026-10-25 01:30', '2026-10-25 02:30', '2026-10-25 09:00', '2026-10-26 01:30', '2026-10-26 02:30', '2026-10-26 09:00']);
  assert.equal(new Date(autumn[2]).toISOString(), '2026-10-25T08:00:00.000Z', '09:00 CET after the change');
  const spring = firesBetween(spec, wallInstant('2027-03-27', 12 * 60, TZ), wallInstant('2027-03-28', 12 * 60, TZ));
  assert.equal(spring.length, 3, 'one run per time, also for 02:30 which the night skips');
  assert.equal(new Date(spring[2]).toISOString(), '2027-03-28T07:00:00.000Z', '09:00 CEST');
  assert.ok(spring.every((at, i) => i === 0 || at > spring[i - 1]), 'in order');
});

test("stored specs without times keep their runs; the agents' lane shows times and anchors an older interval at its next run", () => {
  assert.deepEqual(firesBetween({ cron: '0 9 * * *', tz: 'UTC' }, Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 21)), [Date.UTC(2026, 9, 19, 9), Date.UTC(2026, 9, 20, 9)]);
  const schedule = (id: string, spec: Schedule['spec'], nextAt?: number): Schedule => ({
    id, ownerId: 'ag_tom', conversationId: undefined, kind: 'routine', title: id, spec, payload: {}, runs: 0, active: true, createdAt: 0, ...(nextAt ? { nextAt } : {}),
  });
  const list = [schedule('times', { times: ['09:00', '17:00'], tz: TZ }), schedule('every', { everyMs: 6 * H, tz: TZ }, MON + 2 * H)];
  const runs = agentRuns({ scheduler: { list: () => list } as never }, MON, MON + D);
  assert.deepEqual(runs.filter((run) => run.scheduleId === 'times').map((run) => local(run.at)), ['2026-10-19 17:00', '2026-10-20 09:00']);
  assert.deepEqual(runs.filter((run) => run.scheduleId === 'every').map((run) => run.at), [MON + 2 * H, MON + 8 * H, MON + 14 * H, MON + 20 * H]);
});

test('next-due.json: written on change only, serialised, the newest value wins; a failure is logged', async () => {
  const writes: string[] = [];
  let release: () => void = () => {};
  const io = { write: async (_file: string, text: string) => { writes.push(text.trim()); await new Promise<void>((resolve) => { release = resolve; }); }, discardTemp: async () => {} };
  const file = new NextDueFile(tmp, { io });
  file.report(1000);
  file.report(1000);
  file.report(2000);
  file.report(3000);
  assert.deepEqual(writes, ['{"at":1000}'], 'one write in flight');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await file.flush();
  assert.deepEqual(writes, ['{"at":1000}', '{"at":3000}'], 'the newest value, not every step');
  file.report(3000);
  file.report(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await file.flush();
  assert.deepEqual(writes.at(-1), '{"at":null}');
  const warnings: string[] = [];
  const failing = new NextDueFile(tmp, { io: { write: async () => { throw new Error('disk full'); }, discardTemp: async () => {} }, log: { warn: (message) => warnings.push(message) } });
  failing.report(5);
  await failing.flush();
  assert.deepEqual(warnings, ['next-due file not written']);
  const real = new NextDueFile(path.join(tmp, 'data'));
  real.report(1234.4);
  await real.flush();
  assert.deepEqual(JSON.parse(readFileSync(path.join(tmp, 'data', 'next-due.json'), 'utf8')), { at: 1234 });
});

test('the scheduler reports the earliest due schedule or wake on every arm', async () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const reports: Array<number | undefined> = [];
  const scheduler = new SchedulerImpl(h.services, { timers: h.timers, nextDue: { report: (at) => { reports.push(at); } } });
  scheduler.start();
  assert.deepEqual(reports, [undefined], 'nothing due');
  const now = h.clock.now();
  const late = scheduler.create({ ownerId: 'ag_tom', kind: 'reminder', title: 'Late', spec: { at: now + 2 * H }, payload: { note: 'x' } });
  scheduler.create({ ownerId: 'ag_tom', kind: 'reminder', title: 'Soon', spec: { at: now + H }, payload: { note: 'y' } });
  assert.deepEqual(reports.slice(1), [now + 2 * H, now + H]);
  scheduler.update(late.id, { active: false });
  assert.equal(reports.at(-1), now + H);
  await scheduler.stop();
  const count = reports.length;
  scheduler.arm();
  assert.equal(reports.length, count, 'a stopped scheduler reports nothing');
});

test("the scheduler's stop settles next-due.json: the last value is on disk and no temp file is left", async () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const dir = path.join(tmp, 'settle');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'next-due.json.tmp'), '{"at":1}'); // left by a crashed write
  const scheduler = new SchedulerImpl(h.services, { timers: h.timers, nextDue: new NextDueFile(dir) });
  scheduler.start();
  const reminder = scheduler.create({ ownerId: 'ag_tom', kind: 'reminder', title: 'Later', spec: { at: h.clock.now() + H }, payload: { note: 'x' } });
  await scheduler.stop(); // no flush before: the stop waits for the write in flight
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'next-due.json'), 'utf8')), { at: reminder.nextAt });
  assert.deepEqual(readdirSync(dir), ['next-due.json'], 'no temp file');
  const blocked = path.join(tmp, 'blocked');
  mkdirSync(path.join(blocked, 'next-due.json'), { recursive: true }); // the rename cannot replace a folder
  const warnings: string[] = [];
  const file = new NextDueFile(blocked, { log: { warn: (message) => warnings.push(message) } });
  file.report(5);
  await file.settle();
  assert.deepEqual(warnings, ['next-due file not written']);
  assert.equal(existsSync(path.join(blocked, 'next-due.json.tmp')), false, 'a failed rename removes its temp file');
});
