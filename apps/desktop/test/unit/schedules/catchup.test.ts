// Tests for firing and catch-up in the scheduler (src/runtime/schedules/scheduler.ts): what
// happens to runs missed while the PC was off ('once' collapses them into one late fire,
// 'all' replays them capped, 'skip' drops fires older than the grace period), interval
// anchoring, maxRuns/until, the once-only guard across two processes, and robustness against
// a broken stored schedule. Owns: these assertions only. Never: real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { SchedulerImpl, type SchedulerOptions } from '../../../src/runtime/schedules/scheduler.ts';
import { ScheduleRepo } from '../../../src/runtime/schedules/repo.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { ScheduleSpec } from '../../../src/shared/model/tasks.ts';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const NINE = Date.UTC(2026, 9, 17, 9, 0, 0); // harness clock start (Saturday 09:00Z)

function setup() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const posts = () => h.chats.messages(chat.id).filter(m => m.kind === 'text' && m.meta.via === 'schedule');
  const message = (spec: ScheduleSpec, body = 'Daily check-in') =>
    h.scheduler.create({ ownerId: 'ag_tom', conversationId: chat.id, kind: 'message', title: body, spec, payload: { body } });
  /** The PC is off: this process ends, time passes, a new process starts on the same DB. */
  const restart = (offMs: number, options: SchedulerOptions = {}) => {
    h.scheduler.stop();
    h.clock.advance(offMs);
    const log = new MemoryLogger();
    const next = new SchedulerImpl({ ...h.services, log }, { timers: h.timers, ...options });
    next.start();
    return { scheduler: next, log };
  };
  return { ...h, chat, posts, message, restart };
}

test("catch-up 'once' (default): missed daily runs collapse into ONE late fire", () => {
  const h = setup();
  h.scheduler.start();
  const daily = h.message({ cron: '0 10 * * *', tz: 'UTC' });
  assert.equal(daily.nextAt, NINE + H);
  const { scheduler } = h.restart(3 * D + 2 * H); // off from Sat 09:00 to Tue 11:00
  const posts = h.posts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].meta.plannedAt, NINE + H, 'the first missed occurrence is the one that fires');
  const after = scheduler.get(daily.id)!;
  assert.equal(after.runs, 1);
  assert.equal(after.lastAt, h.clock.now());
  assert.equal(new Date(after.nextAt!).toISOString(), '2026-10-21T10:00:00.000Z', 'next regular occurrence after now');
  assert.equal(h.timers.only().ms, 23 * H);
  scheduler.stop();
});

test("catch-up 'all': every missed run is replayed in order, capped by maxCatchUp", () => {
  const h = setup();
  h.scheduler.start();
  const daily = h.message({ cron: '0 10 * * *', tz: 'UTC', catchUp: 'all' });
  const { scheduler } = h.restart(3 * D + 2 * H);
  assert.deepEqual(h.posts().map(p => new Date(p.meta.plannedAt as number).toISOString()), [
    '2026-10-17T10:00:00.000Z', '2026-10-18T10:00:00.000Z', '2026-10-19T10:00:00.000Z', '2026-10-20T10:00:00.000Z',
  ]);
  assert.equal(scheduler.get(daily.id)!.runs, 4);
  scheduler.stop();

  const capped = setup();
  capped.scheduler.start();
  capped.message({ cron: '0 10 * * *', tz: 'UTC', catchUp: 'all' });
  capped.restart(10 * D, { maxCatchUp: 3 }).scheduler.stop();
  assert.equal(capped.posts().length, 3);
});

test("catch-up 'skip': runs later than the grace period are dropped, a little late still fires", () => {
  const h = setup();
  h.scheduler.start();
  const daily = h.message({ cron: '0 10 * * *', tz: 'UTC', catchUp: 'skip' });
  const { scheduler } = h.restart(2 * D);
  assert.equal(h.posts().length, 0);
  const after = scheduler.get(daily.id)!;
  assert.equal(after.runs, 0);
  assert.equal(new Date(after.nextAt!).toISOString(), '2026-10-19T10:00:00.000Z');
  assert.equal(after.active, true);
  // One minute late (timer delayed by a busy PC) is inside the 2-minute grace: it fires.
  h.clock.set(after.nextAt! + M);
  h.timers.fire();
  assert.equal(h.posts().length, 1);
  scheduler.stop();
});

test('interval schedules stay on their grid: a late timer does not shift later runs', () => {
  const h = setup();
  h.scheduler.start();
  const every = h.message({ everyMs: H }, 'Hourly');
  assert.equal(every.nextAt, NINE + H);
  h.clock.set(NINE + H + 5 * M); // the timer fired 5 minutes late
  h.timers.fire();
  assert.equal(h.scheduler.get(every.id)!.nextAt, NINE + 2 * H);
  // Off for 5 h: one late fire ('once'), the grid continues.
  const { scheduler } = h.restart(5 * H);
  assert.equal(h.posts().length, 2);
  assert.equal(scheduler.get(every.id)!.nextAt, NINE + 7 * H);
  scheduler.stop();
});

test('maxRuns ends a schedule (also when catching up), until ends it in time', () => {
  const h = setup();
  h.scheduler.start();
  const twice = h.message({ everyMs: H, maxRuns: 2 }, 'Twice');
  for (let i = 0; i < 2; i++) { h.clock.advance(H); h.timers.fire(); }
  assert.equal(h.posts().length, 2);
  assert.equal(h.scheduler.get(twice.id)!.active, false);
  assert.equal(h.scheduler.get(twice.id)!.nextAt, undefined);
  assert.equal(h.timers.pending.length, 0);
  // Re-activating an exhausted schedule keeps it off.
  assert.equal(h.scheduler.update(twice.id, { active: true }).active, false);

  const all = setup();
  all.scheduler.start();
  const capped = all.message({ everyMs: H, maxRuns: 3, catchUp: 'all' }, 'Three');
  const { scheduler } = all.restart(10 * H);
  assert.equal(all.posts().length, 3, 'replay stops at maxRuns');
  assert.equal(scheduler.get(capped.id)!.runs, 3);
  assert.equal(scheduler.get(capped.id)!.active, false);
  scheduler.stop();

  const until = setup();
  until.scheduler.start();
  const bounded = until.message({ cron: '0 10 * * *', tz: 'UTC', until: NINE + D + 2 * H }, 'Until Sunday');
  for (let i = 0; i < 2; i++) { until.clock.set(until.scheduler.get(bounded.id)!.nextAt!); until.timers.fire(); }
  assert.equal(until.posts().length, 2);
  assert.equal(until.scheduler.get(bounded.id)!.active, false);
});

test('one-off at: a time just passed still fires once; at after until never activates', () => {
  const h = setup();
  h.scheduler.start();
  const late = h.message({ at: NINE - 30_000 }, 'Late');
  assert.equal(late.nextAt, NINE - 30_000);
  assert.equal(h.posts().length, 0, 'fires on the next tick, not inside create()');
  h.timers.fire();
  assert.equal(h.posts().length, 1);
  assert.equal(h.scheduler.get(late.id)!.active, false);
  const never = h.message({ at: NINE - 30_000, until: NINE - 60_000 }, 'Never');
  assert.equal(never.active, false);
});

test('an occurrence fires once even when two processes tick the same database', () => {
  const h = setup();
  const other = new SchedulerImpl(h.services, { timers: h.timers });
  h.message({ at: NINE + H }, 'Once');
  h.clock.advance(H);
  h.scheduler.tick();
  other.tick();
  h.scheduler.tick();
  assert.equal(h.posts().length, 1);
});

test('effects per kind: message posts, reminder wakes privately, routine creates a task, timer notifies', () => {
  const h = setup();
  h.scheduler.start();
  h.message({ at: NINE + M }, 'Post this');
  const reminder = h.scheduler.create({ ownerId: 'ag_tom', conversationId: h.chat.id, kind: 'reminder', title: 'Look', spec: { at: NINE + M }, payload: { note: 'Look at the numbers' } });
  h.scheduler.create({ ownerId: 'ag_tom', conversationId: h.chat.id, kind: 'routine', title: 'Comments', spec: { at: NINE + M }, payload: { taskTemplate: { title: 'Answer YouTube comments' } } });
  const todo = h.tasks.create({ conversationId: h.chat.id, title: 'Take the bread out', assigneeKind: 'human', createdBy: 'human' });
  h.scheduler.create({ ownerId: 'human', kind: 'timer', title: 'Bread', taskId: todo.id, spec: { at: NINE + M }, payload: {} });
  const statusLines = h.chats.messages(h.chat.id).filter(m => m.kind === 'status' && m.meta.status?.type === 'schedule_created');
  assert.equal(statusLines.length, 2, 'message and routine are announced; reminder and timer are not');
  h.clock.advance(M);
  h.timers.fire();
  assert.deepEqual(h.posts().map(p => [p.body, p.authorId, p.meta.scheduleId !== undefined]), [['Post this', 'ag_tom', true]]);
  const wakes = h.wakeRows().filter(w => w.reason === 'schedule');
  assert.ok(wakes.some(w => w.note === 'Look at the numbers'), `reminder wake (${reminder.id})`);
  const routineTask = h.tasks.list({ conversationId: h.chat.id }).find(t => t.title === 'Answer YouTube comments')!;
  assert.equal(routineTask.assigneeId, 'ag_tom');
  assert.ok(wakes.some(w => w.task_id === routineTask.id), 'the owner is woken for the new task');
  assert.deepEqual(h.notified.map(n => [n.kind, n.title]).filter(([kind]) => kind === 'todo'), [['todo', 'Bread']]);
  assert.equal(h.tasks.get(todo.id)!.status, 'needs_you');
});

test('a schedule whose chat is gone deactivates instead of failing every time', () => {
  const h = setup();
  const log = new MemoryLogger();
  const scheduler = new SchedulerImpl({ ...h.services, log }, { timers: h.timers });
  scheduler.start();
  const daily = scheduler.create({ ownerId: 'ag_tom', conversationId: h.chat.id, kind: 'message', title: 'X', spec: { cron: '0 10 * * *', tz: 'UTC' }, payload: { body: 'x' } });
  h.chats.remove(h.chat.id);
  h.clock.advance(H);
  h.timers.fire();
  const after = scheduler.get(daily.id)!;
  assert.equal(after.active, false);
  assert.equal(after.nextAt, undefined);
  assert.ok(log.entries.some(e => e.message === 'schedule deactivated'));
  assert.equal(h.timers.pending.length, 0);
  scheduler.stop();
});

test('a broken stored schedule is deactivated; the timer and other schedules keep working (regression)', () => {
  const h = setup();
  const repo = new ScheduleRepo(h.db);
  // E.g. restored from a backup made by another version: the cron no longer parses.
  repo.insert({ id: 'sch_broken0000000001', ownerId: 'ag_tom', conversationId: h.chat.id, kind: 'message', title: 'Broken', spec: { cron: 'not a cron' }, payload: {}, nextAt: NINE - M, runs: 0, active: true, createdAt: NINE - D });
  const good = h.message({ at: NINE + M }, 'Still fires');
  const log = new MemoryLogger();
  const scheduler = new SchedulerImpl({ ...h.services, log }, { timers: h.timers });
  assert.doesNotThrow(() => scheduler.start());
  assert.equal(repo.get('sch_broken0000000001')!.active, false);
  assert.ok(log.entries.some(e => e.level === 'error' && e.message === 'schedule fire failed'));
  assert.equal(h.timers.only().ms, M, 'the single timer is armed for the next good schedule');
  h.clock.advance(M);
  h.timers.fire();
  assert.deepEqual(h.posts().map(p => p.body), ['Still fires']);
  assert.equal(scheduler.get(good.id)!.active, false);
  scheduler.stop();
});

test('create validates input; runNow fires at once without moving the plan', () => {
  const h = setup();
  assert.throws(() => h.scheduler.create({ ownerId: 'ag_tom', kind: 'message', title: 'x', spec: { at: NINE + H }, payload: {} }), /is posted in a chat: pass chatId/);
  assert.throws(() => h.scheduler.create({ ownerId: 'human', kind: 'reminder', title: 'x', spec: { at: NINE + H }, payload: {} }), /use a timer/);
  assert.throws(() => h.message({ everyMs: 1000 }), /at least 60000/);
  assert.equal(h.scheduler.create({ ownerId: 'human', kind: 'timer', title: 'Tea', spec: { everyMs: 1000 }, payload: {} }).active, true, 'timers may tick every second');
  const capped = new SchedulerImpl(h.services, { timers: h.timers, maxAgentSchedules: 1 });
  capped.create({ ownerId: 'ag_tom', kind: 'reminder', title: 'a', spec: { at: NINE + H }, payload: {} });
  assert.throws(() => capped.create({ ownerId: 'ag_tom', kind: 'reminder', title: 'b', spec: { at: NINE + H }, payload: {} }), /Too many active schedules/);
  const weekly = h.message({ cron: '0 18 * * 1', tz: 'UTC' }, 'Weekly');
  h.scheduler.runNow(weekly.id);
  const after = h.scheduler.get(weekly.id)!;
  assert.equal(h.posts().length, 1);
  assert.equal(after.runs, 1);
  assert.equal(after.nextAt, weekly.nextAt);
  assert.throws(() => h.scheduler.runNow('sch_missing'), /Schedule not found/);
});
