// B-041 track A2: planning a day through the day service (runtime/day/plan.ts) – Robin's dictated evening list
// becomes planner blocks around the next morning's 10:00 meeting, the stored and corrected estimates are used,
// only plannable to-dos are placed (no host cards, rings, steps that do not need the person there), replan moves
// planner blocks and reports them, a block without a new place goes, calendars sync first and stale ones are
// reported, the local today is recorded for the morning run, and a refused block is reported as unplanned.
// Owns: checks of planFor / plannable only (the placement rule: planner.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { CalendarSource } from '../../../src/shared/model/calendar.ts';
import { zonedTime } from '../../../src/runtime/calendar/when.ts';
import { plannedDate } from '../../../src/runtime/day/plan.ts';
import { CalendarServiceImpl } from '../../../src/runtime/calendar/service.ts';
import { BERLIN, agent, dayFixture, fakeSources } from './fixture.ts';

const wall = (date: string, clock: string) => zonedTime(date, Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)), BERLIN);
const TUE = '2026-10-27';
const ROBIN = 'Wäsche waschen\nKüche aufräumen\nSteuern erledigen\nWebseite verbessern\nam Buch arbeiten';
const local = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: BERLIN, hour: '2-digit', minute: '2-digit' }).format(ms);

test("Robin's evening list is planned the next morning around the 10:00 meeting, with her corrected estimate", async () => {
  const f = dayFixture({ now: wall('2026-10-26', '22:30') });
  const { tasks } = await f.day.add({ text: ROBIN }, HUMAN_ID);
  const taxes = tasks.find((task) => task.title === 'Steuern erledigen')!;
  f.day.setEstimate(taxes.id, 120, HUMAN_ID);
  const tonight = await f.day.plan(HUMAN_ID, '2026-10-26', 'plan');
  assert.deepEqual([tonight.placed, tonight.unplanned], [[], []], 'said after work: nothing for tonight');
  f.calendar.event(wall(TUE, '10:00'), wall(TUE, '11:00'));
  f.clock.set(wall(TUE, '06:00'));
  const result = await f.day.plan(HUMAN_ID, TUE, 'plan');
  assert.equal(result.date, TUE);
  assert.equal(result.placed.length, 5);
  assert.deepEqual(result.unplanned, []);
  const byTitle = Object.fromEntries(f.calendar.events.filter((e) => e.kind === 'todo').map((e) => [f.s.tasks.get(e.taskId!)!.title, `${local(e.startAt)}–${local(e.endAt)} ${e.setBy}`]));
  assert.deepEqual(byTitle, {
    'Wäsche waschen': '08:00–08:30 planner', 'Küche aufräumen': '08:40–09:10 planner', 'Webseite verbessern': '09:20–09:50 planner',
    'am Buch arbeiten': '11:10–11:40 planner', 'Steuern erledigen': '11:50–13:50 planner',
  });
  assert.equal(plannedDate(f.s, HUMAN_ID), TUE, 'today was planned: the morning run will not plan it again');
});

test('only plannable to-dos: no host card, no ring, no agent step that does not need the person there', async () => {
  const f = dayFixture({ now: wall(TUE, '07:00') });
  f.org.add(agent('ag_x', 'Mara', { createdAt: 1 }));
  const chat = f.s.chats.create({ agentIds: ['ag_x'], humans: true, createdBy: HUMAN_ID }).id;
  f.s.tasks.create({ title: 'Nudeln', assigneeKind: 'human', createdBy: HUMAN_ID, humanReason: 'physical', widget: { type: 'timer', label: 'Nudeln', duration: 'PT10M' } });
  f.s.tasks.create({ conversationId: f.todoChat(), title: 'Approve 40 €', assigneeKind: 'human', createdBy: SYSTEM_ID, humanReason: 'approval', widget: { type: 'approve', action: 'Pay', approvalId: 'apr_1' } });
  f.s.tasks.create({ conversationId: chat, title: 'Pick a colour', assigneeKind: 'human', createdBy: 'ag_x', humanReason: 'taste' });
  const errand = f.s.tasks.create({ conversationId: chat, title: 'Zettel zur Polizei bringen', assigneeKind: 'human', createdBy: 'ag_x', humanReason: 'physical' });
  const result = await f.day.plan(HUMAN_ID, TUE, 'plan');
  assert.deepEqual(f.calendar.events.map((e) => e.taskId), [errand.id]);
  assert.equal(result.placed.length, 1);
});

test('replan moves a planner block not started yet and reports it; one that finds no place goes', async () => {
  const f = dayFixture({ now: wall(TUE, '07:00') });
  const [a, b] = (await f.day.add({ text: 'Wäsche waschen\nKüche aufräumen' }, HUMAN_ID)).tasks;
  const blockA = f.calendar.block(a.id, wall(TUE, '15:00'), wall(TUE, '15:30'), 'planner');
  const result = await f.day.plan(HUMAN_ID, TUE, 'replan');
  assert.deepEqual(result.moved, [blockA.id]);
  assert.equal(result.placed.length, 1);
  assert.deepEqual(f.calendar.events.filter((e) => e.kind === 'todo').map((e) => [e.taskId, local(e.startAt)]).sort(), [[a.id, '08:00'], [b.id, '08:40']].sort());
  f.clock.set(wall(TUE, '07:30'));
  f.calendar.event(wall(TUE, '07:30'), wall(TUE, '20:00'));
  const full = await f.day.plan(HUMAN_ID, TUE, 'replan');
  assert.equal(full.unplanned.length, 2);
  assert.equal(f.calendar.events.filter((e) => e.kind === 'todo').length, 0, 'their old blocks went: both show as unplanned');
});

test('calendars sync before planning; stale and failing ones are reported but the plan goes on', async () => {
  const now = wall(TUE, '07:00');
  const f = dayFixture({ now });
  const source = (id: string, extra: Partial<CalendarSource>): CalendarSource => ({ id, ownerId: HUMAN_ID, kind: 'ics', label: id, visible: true, writable: false, status: 'ok', ...extra });
  const sources = fakeSources([
    source('fresh', { lastSyncAt: now - 60_000 }), source('old', { lastSyncAt: now - 25 * 60 * 60_000 }), source('broken', { status: 'error', lastSyncAt: now }),
    source('hidden', { visible: false }),
  ]);
  f.s.calendarSources = sources;
  f.calendar.stale = ['reported'];
  await f.day.add({ text: 'Wäsche waschen' }, HUMAN_ID);
  const result = await f.day.plan(HUMAN_ID, TUE, 'plan');
  assert.deepEqual(sources.syncs, ['plan']);
  assert.deepEqual(result.staleSources.sort(), ['broken', 'old', 'reported']);
  assert.equal(result.placed.length, 1);
  const failing = fakeSources([source('x', { lastSyncAt: now })]);
  failing.sync = () => Promise.reject(new Error('offline'));
  f.s.calendarSources = failing;
  assert.equal((await f.day.plan(HUMAN_ID, TUE, 'plan')).date, TUE, 'a failed sync never stops the plan');
});

test('planning another day records nothing for the morning; a refused block is unplanned; no calendar is unavailable', async () => {
  const f = dayFixture({ now: wall(TUE, '07:00') });
  await f.day.add({ text: 'Wäsche waschen' }, HUMAN_ID);
  await f.day.plan(HUMAN_ID, '2026-10-28', 'plan');
  assert.equal(plannedDate(f.s, HUMAN_ID), undefined);
  f.calendar.events = [];
  f.calendar.upsertBlock = () => { throw new Error('refused'); };
  const refused = await f.day.plan(HUMAN_ID, TUE, 'plan');
  assert.deepEqual(refused.unplanned.map((entry) => entry.reason), ['Could not be placed']);
  f.s.calendar = undefined;
  await assert.rejects(f.day.plan(HUMAN_ID, TUE, 'plan'), { code: 'unavailable' });
});

test('with the calendar service itself (track A1): the plan writes planner blocks and replan places the ones not started again', async () => {
  const f = dayFixture({ now: wall('2026-10-26', '22:30') });
  const calendar = new CalendarServiceImpl(f.s);
  calendar.start();
  f.s.calendar = calendar;
  const { tasks } = await f.day.add({ text: ROBIN }, HUMAN_ID);
  f.clock.set(wall(TUE, '06:00'));
  calendar.insert({ ...calendar.fresh(HUMAN_ID, 'event', 'person', HUMAN_ID, wall(TUE, '10:00'), wall(TUE, '11:00')), title: 'Meeting' });
  const first = await f.day.plan(HUMAN_ID, TUE, 'plan');
  assert.deepEqual([first.placed.length, first.unplanned], [5, []]);
  const blocks = () => calendar.blocksFor(tasks.map((task) => task.id));
  assert.deepEqual([...blocks().values()].map((block) => local(block.startAt)).sort(), ['08:00', '08:40', '09:20', '11:10', '11:50']);
  f.clock.set(wall(TUE, '08:45'));
  const again = await f.day.plan(HUMAN_ID, TUE, 'replan');
  assert.equal(again.moved.length, 3, 'the blocks not started yet were placed again');
  assert.deepEqual([...blocks().values()].map((block) => local(block.startAt)).sort(), ['08:00', '08:40', '09:20', '11:10', '11:50'], 'still the earliest free times');
  calendar.stop();
});

test('a block the person dragged that ended unticked yesterday, and a to-do reopened after its block: the plan places both again (calendar service)', async () => {
  const f = dayFixture({ now: wall('2026-10-26', '09:00') });
  const calendar = new CalendarServiceImpl(f.s);
  calendar.start();
  f.s.calendar = calendar;
  const [kitchen, wash] = (await f.day.add({ text: 'Küche aufräumen\nWäsche waschen' }, HUMAN_ID)).tasks;
  const block = calendar.upsertBlock(kitchen.id, wall('2026-10-26', '14:00'), wall('2026-10-26', '14:30'), 'planner');
  calendar.move(block.id, wall('2026-10-26', '15:00'), wall('2026-10-26', '15:30'), block.rev, HUMAN_ID); // dragged: the person's
  const washBlock = calendar.upsertBlock(wash.id, wall('2026-10-26', '16:00'), wall('2026-10-26', '16:30'), 'planner');
  f.clock.set(wall('2026-10-26', '16:10'));
  f.s.tasks.setStatus(wash.id, 'done', HUMAN_ID);
  f.clock.set(wall('2026-10-26', '17:00'));
  f.s.tasks.setStatus(wash.id, 'open', HUMAN_ID);
  assert.equal(calendar.blocksFor([wash.id]).size, 0, 'reopened after its block: unplanned');
  assert.ok(washBlock.id);
  f.clock.set(wall(TUE, '06:00'));
  const result = await f.day.plan(HUMAN_ID, TUE, 'plan');
  assert.deepEqual(result.unplanned, []);
  const blocks = calendar.blocksFor([kitchen.id, wash.id]);
  assert.deepEqual([...blocks.values()].map((event) => [event.taskId, local(event.startAt), event.setBy, event.state]).sort(), [
    [kitchen.id, '08:00', 'planner', 'planned'], [wash.id, '08:40', 'planner', 'planned'],
  ].sort());
  calendar.stop();
});
