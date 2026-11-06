// B-041 track A1: the CalendarService – the window with the agents' runs (computed from schedules, capped, never
// stored; none of a people's own chat, paused ones or the person's timers), the profile zone and sources not synced
// for a day; slot clicks (calendar.add: a to-do is the person's own with its estimate and a pinned block, an event is
// a row with its title, 'auto' reads the text, a resend answers the first result); moves (rev-checked, pinned),
// removal, the planner's and agents' blocks (one per task, never moving the person's, never over an appointment or a
// person-set block), busy spans and blocks by task – every change sent as calendar.upserted / calendar.removed and
// handed to the sources' mirror hook.
// Owns: checks of runtime/calendar/{service,add,agent-runs}.ts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { AGENT_RUN_LIMITS } from '../../../src/runtime/calendar/agent-runs.ts';
import { agent } from '../chat/harness.ts';
import { ANNA, at, MIN, TZ, world } from './fixture.ts';

const code = (run: () => unknown) => { try { run(); return 'ok'; } catch (error) { return (error as { code?: string }).code ?? String(error); } };

test("list: the window's rows, the agents' runs from their schedules, the profile zone and stale sources", () => {
  const w = world({ now: '06:00' });
  const chat = w.chat();
  w.row({ id: 'cev_meeting', title: 'Meeting', startAt: at('10:00'), endAt: at('11:00') });
  w.scheduler.create({ ownerId: 'ag_mara', conversationId: chat.id, kind: 'routine', title: 'Morning digest', spec: { cron: '0 7 * * *', tz: TZ }, payload: { taskTemplate: { title: 'Digest' } } });
  const paused = w.scheduler.create({ ownerId: 'ag_mara', conversationId: chat.id, kind: 'message', title: 'Paused post', spec: { cron: '0 9 * * *', tz: TZ }, payload: { body: 'x' } });
  w.scheduler.update(paused.id, { active: false });
  w.scheduler.create({ ownerId: HUMAN_ID, kind: 'timer', title: 'Tea', spec: { at: at('09:00') }, payload: {} });
  w.source('cal_old', { syncedAt: w.clock.now() - 30 * 60 * MIN });
  const list = w.calendar.list(HUMAN_ID, at('00:00'), at('00:00', '2026-10-30'));
  assert.deepEqual(list.events.map((row) => row.id), ['cev_meeting']);
  assert.deepEqual(list.agentRuns.map((run) => [run.title, run.agentId, run.at]), [
    ['Morning digest', 'ag_mara', at('07:00')], ['Morning digest', 'ag_mara', at('07:00', '2026-10-28')], ['Morning digest', 'ag_mara', at('07:00', '2026-10-29')],
  ], "the routine's runs; not the paused one or the person's timer");
  assert.equal(list.tz, TZ);
  assert.deepEqual(list.staleSources, ['cal_old']);
  assert.equal(w.db.get<{ n: number }>('SELECT count(*) AS n FROM calendar_events')?.n, 1, 'runs are never stored');
});

test("the agents' lane is capped per schedule and per window", () => {
  const w = world({ now: '06:00' });
  const chat = w.chat();
  for (const title of ['A', 'B', 'C', 'D', 'E']) w.scheduler.create({ ownerId: 'ag_mara', conversationId: chat.id, kind: 'message', title, spec: { everyMs: 15 * MIN }, payload: { body: title } });
  const runs = w.calendar.list(HUMAN_ID, at('06:00'), at('06:00', '2026-10-29')).agentRuns;
  assert.equal(runs.length, AGENT_RUN_LIMITS.perWindow);
  for (const title of ['A', 'B', 'C', 'D', 'E']) assert.ok(runs.filter((run) => run.title === title).length <= AGENT_RUN_LIMITS.perSchedule, title);
  assert.ok(runs.every((run, index) => index === 0 || runs[index - 1].at <= run.at), 'by time');
});

test("one agent's runs (the agent page): capped for it alone, never pushed out by other agents' busy routines; no rows", () => {
  const w = world({ now: '06:00' });
  w.org.add(agent('ag_tom', 'Tom'));
  const chat = w.chat();
  w.row({ id: 'cev_meeting', title: 'Meeting', startAt: at('10:00'), endAt: at('11:00') });
  for (const title of ['A', 'B', 'C', 'D', 'E']) w.scheduler.create({ ownerId: 'ag_mara', conversationId: chat.id, kind: 'message', title, spec: { everyMs: 15 * MIN }, payload: { body: title } });
  w.scheduler.create({ ownerId: 'ag_tom', conversationId: chat.id, kind: 'routine', title: 'Evening report', spec: { cron: '0 18 * * *', tz: TZ }, payload: { taskTemplate: { title: 'Report' } } });
  const all = w.calendar.list(HUMAN_ID, at('06:00'), at('06:00', '2026-10-31')).agentRuns;
  assert.equal(all.filter((run) => run.agentId === 'ag_tom').length < 4, true, "all agents together: Tom's later runs fall behind the cap");
  const toms = w.calendar.list(HUMAN_ID, at('06:00'), at('06:00', '2026-10-31'), 'ag_tom');
  assert.deepEqual(toms.agentRuns.map((run) => run.at), [at('18:00'), at('18:00', '2026-10-28'), at('18:00', '2026-10-29'), at('18:00', '2026-10-30')]);
  assert.deepEqual(toms.events, [], 'the agent page needs no rows');
});

test("a slot click with a to-do: the person's own to-do with the range as its estimate and a pinned block without text", async () => {
  const w = world({ now: '08:00' });
  const { event, task } = await w.calendar.add({ text: 'Steuern', startAt: at('10:00'), endAt: at('10:45') }, HUMAN_ID);
  assert.ok(task);
  assert.deepEqual([task.title, task.assigneeKind, task.createdBy, task.conversationId, task.estimateMin, task.estimateSource],
    ['Steuern', 'human', HUMAN_ID, undefined, 45, 'said'], 'chat-free (B-054)');
  assert.deepEqual(task.origin, { source: 'todo-list', label: 'Calendar' });
  assert.deepEqual([event.kind, event.taskId, event.title, event.setBy, event.startAt, event.endAt, event.ownerId, event.sourceId, event.tz],
    ['todo', task.id, undefined, 'person', at('10:00'), at('10:45'), HUMAN_ID, 'local', TZ]);
  assert.deepEqual(w.upserted().map((row) => row.id), [event.id]);
  assert.deepEqual(w.changes, [event]);
  const plain = await w.calendar.add({ text: 'Küche aufräumen 45 min', startAt: at('13:00') }, HUMAN_ID);
  assert.deepEqual([plain.task?.title, plain.task?.estimateMin, plain.task?.estimateSource, plain.event.endAt], ['Küche aufräumen 45 min', 30, 'default', at('13:30')], 'no guessing from words: the default');
});

test('a to-do slot follows My day\'s switch: "Only me" (AI helps off) makes it private, "AI helps" leaves it open to agents', async () => {
  const only = world({ now: '08:00', day: { aiHelps: false } });
  const mine = await only.calendar.add({ text: 'Steuern', startAt: at('10:00') }, HUMAN_ID);
  assert.equal(mine.task?.private, true);
  assert.equal(only.tasks.get(mine.task!.id)?.private, true, 'stored so');
  const helped = world({ now: '08:00' });
  assert.equal((await helped.calendar.add({ text: 'Steuern', startAt: at('10:00') }, HUMAN_ID)).task?.private, undefined);
});

test('a resend with the same clientId answers the first to-do', async () => {
  const w = world({ now: '08:00' });
  const first = await w.calendar.add({ text: 'Küche aufräumen', startAt: at('10:00'), clientId: 'c1' }, HUMAN_ID);
  const again = await w.calendar.add({ text: 'Küche aufräumen', startAt: at('10:00'), clientId: 'c1' }, HUMAN_ID);
  assert.deepEqual([again.task?.id, again.event.id], [first.task?.id, first.event.id]);
  assert.equal(w.db.get<{ n: number }>('SELECT count(*) AS n FROM calendar_events')?.n, 1);
});

test("a slot click with kind 'event': an event with its title; 'auto' is a to-do; the click decides the time", async () => {
  const w = world({ now: '08:00' });
  const dentist = await w.calendar.add({ text: 'Zahnarzt', startAt: at('10:00'), kind: 'event' }, HUMAN_ID);
  assert.equal(dentist.task, undefined);
  assert.deepEqual([dentist.event.kind, dentist.event.title, dentist.event.setBy, dentist.event.endAt], ['event', 'Zahnarzt', 'person', at('11:00')], 'an hour by default');
  const auto = await w.calendar.add({ text: 'Meeting mit Anna', startAt: at('14:00'), kind: 'auto' }, HUMAN_ID);
  assert.equal(auto.event.kind, 'todo', 'no guessing from words');
  const other = await w.calendar.add({ text: 'Arzt um 15 Uhr', startAt: at('09:00'), kind: 'event' }, HUMAN_ID);
  assert.deepEqual([other.event.title, other.event.startAt], ['Arzt um 15 Uhr', at('09:00')], 'the click decides the time; nothing typed is lost');
  const notes = await w.calendar.add({ text: 'Notar\nUnterlagen mitnehmen', startAt: at('17:00'), kind: 'event' }, HUMAN_ID);
  assert.deepEqual([notes.event.title, notes.event.notes], ['Notar', 'Notar\nUnterlagen mitnehmen']);
  const resent = await w.calendar.add({ text: 'Zahnarzt', startAt: at('18:00'), clientId: 'e1', kind: 'event' }, HUMAN_ID);
  assert.equal((await w.calendar.add({ text: 'Zahnarzt', startAt: at('18:00'), clientId: 'e1', kind: 'event' }, HUMAN_ID)).event.id, resent.event.id);
  await assert.rejects(w.calendar.add({ text: '   ', startAt: at('18:00') }, HUMAN_ID), { code: 'bad_request' });
});

test("an agent's event is refused over an appointment or a block the person set; a planner block yields", async () => {
  const w = world({ now: '08:00' });
  w.row({ title: 'Meeting', startAt: at('10:00'), endAt: at('11:00') });
  const mine = w.todo('Buch');
  w.calendar.upsertBlock(mine.id, at('12:00'), at('13:00'), 'person');
  const planned = w.todo('Wäsche');
  w.calendar.upsertBlock(planned.id, at('14:00'), at('14:30'), 'planner');
  await assert.rejects(w.calendar.add({ text: 'Dentist', startAt: at('10:30'), endAt: at('11:30'), kind: 'event' }, 'ag_mara'), { code: 'conflict' });
  await assert.rejects(w.calendar.add({ text: 'Dentist', startAt: at('12:30'), kind: 'event' }, 'ag_mara'), { code: 'conflict' });
  const ok = await w.calendar.add({ text: 'Dentist', startAt: at('14:00'), endAt: at('15:00'), kind: 'event' }, 'ag_mara');
  assert.deepEqual([ok.event.setBy, ok.event.createdBy], ['agent', 'ag_mara']);
  await assert.rejects(w.calendar.add({ text: 'Kitchen', startAt: at('16:00'), kind: 'todo' }, 'ag_mara'), { code: 'bad_request' }, 'agents place to-dos with the tools');
  const own = await w.calendar.add({ text: 'Meeting', startAt: at('10:30'), kind: 'event' }, HUMAN_ID);
  assert.equal(own.event.kind, 'event', 'the person may double-book');
});

test('move: rev-checked, then pinned; a read-only row or an unknown one is refused; remove sends calendar.removed', () => {
  const w = world({ now: '08:00' });
  const task = w.todo('Steuern');
  const block = w.calendar.upsertBlock(task.id, at('10:00'), at('10:30'), 'planner');
  assert.equal(code(() => w.calendar.move(block.id, at('11:00'), at('11:30'), block.rev + 1, HUMAN_ID)), 'conflict');
  const moved = w.calendar.move(block.id, at('11:00'), at('11:30'), block.rev, HUMAN_ID);
  assert.deepEqual([moved.startAt, moved.endAt, moved.setBy, moved.rev], [at('11:00'), at('11:30'), 'person', block.rev + 1]);
  assert.equal(code(() => w.calendar.move(block.id, at('12:00'), at('11:00'), moved.rev, HUMAN_ID)), 'bad_request');
  w.source('cal_1');
  const mirrored = w.row({ title: 'Team sync', sourceId: 'cal_1', externalId: 'uid-1', readOnly: true, setBy: 'sync', startAt: at('15:00'), endAt: at('16:00') });
  assert.equal(code(() => w.calendar.move(mirrored.id, at('16:00'), at('17:00'), 0, HUMAN_ID)), 'bad_request');
  assert.equal(code(() => w.calendar.remove(mirrored.id, HUMAN_ID)), 'bad_request');
  assert.equal(code(() => w.calendar.move('cev_none', at('16:00'), at('17:00'), 0, HUMAN_ID)), 'not_found');
  w.calendar.remove(block.id, HUMAN_ID);
  assert.equal(w.calendar.repo.get(block.id), undefined);
  assert.deepEqual(w.removedEvents().at(-1), { id: block.id, ownerId: HUMAN_ID, taskId: task.id });
  assert.ok(w.tasks.get(task.id), 'its to-do stays');
  assert.equal(code(() => w.calendar.remove(block.id, HUMAN_ID)), 'not_found');
  // The person's own appointment (a local event, e.g. one made by mistake) can be removed too (track C Request 7).
  const appointment = w.row({ title: 'Dentist', startAt: at('17:00'), endAt: at('18:00') });
  w.calendar.remove(appointment.id, HUMAN_ID);
  assert.equal(w.calendar.repo.get(appointment.id), undefined);
  assert.deepEqual(w.removedEvents().at(-1), { id: appointment.id, ownerId: HUMAN_ID });
  assert.ok(w.calendar.repo.get(mirrored.id), 'the read-only row stays');
});

test("upsertBlock: one block per to-do, moved by the planner; never the person's block, never over an appointment; only for open to-dos", () => {
  const w = world({ now: '08:00' });
  const task = w.todo('Wäsche waschen');
  const first = w.calendar.upsertBlock(task.id, at('09:00'), at('09:30'), 'planner');
  assert.deepEqual([first.createdBy, first.setBy, first.state], ['system', 'planner', 'planned']);
  const again = w.calendar.upsertBlock(task.id, at('09:40'), at('10:10'), 'planner');
  assert.deepEqual([again.id, again.startAt, again.rev], [first.id, at('09:40'), first.rev + 1]);
  w.calendar.move(first.id, at('10:00'), at('10:30'), again.rev, HUMAN_ID);
  assert.equal(code(() => w.calendar.upsertBlock(task.id, at('11:00'), at('11:30'), 'planner')), 'conflict', "the person's block stays");
  assert.equal(code(() => w.calendar.upsertBlock(task.id, at('11:00'), at('11:30'), 'agent')), 'conflict');
  assert.equal(w.calendar.upsertBlock(task.id, at('11:00'), at('11:30'), 'person').startAt, at('11:00'), 'the person moves their own');

  w.row({ title: 'Arzt', startAt: at('15:00'), endAt: at('16:00') });
  w.row({ title: 'Feiertag', allDay: true, startAt: at('00:00'), endAt: at('00:00', '2026-10-28') });
  const other = w.todo('Küche');
  assert.equal(code(() => w.calendar.upsertBlock(other.id, at('15:30'), at('16:30'), 'planner')), 'conflict', 'not over an appointment');
  assert.equal(code(() => w.calendar.upsertBlock(other.id, at('13:00'), at('13:30'), 'planner')), 'ok', 'an all-day row is no busy time');
  assert.equal(code(() => w.calendar.upsertBlock(other.id, at('11:15'), at('11:45'), 'agent')), 'conflict', "not over the person's block");

  const chat = w.chat();
  const work = w.tasks.create({ conversationId: chat.id, title: 'Recherche', createdBy: HUMAN_ID, assigneeKind: 'agent', assigneeId: 'ag_mara' });
  assert.equal(code(() => w.calendar.upsertBlock(work.id, at('17:00'), at('17:30'), 'planner')), 'bad_request', 'agent work gets no block');
  const finished = w.todo('Erledigt');
  w.tasks.setStatus(finished.id, 'done', HUMAN_ID);
  assert.equal(code(() => w.calendar.upsertBlock(finished.id, at('17:00'), at('17:30'), 'planner')), 'conflict');
  assert.equal(code(() => w.calendar.upsertBlock('task_missing', at('17:00'), at('17:30'), 'planner')), 'not_found');
  assert.equal(code(() => w.calendar.upsertBlock(other.id, at('17:30'), at('17:00'), 'planner')), 'bad_request');
});

test('busy: every timed row – appointments and every block, the planner\'s too – not all-day rows; blocksFor by task', () => {
  const w = world({ now: '08:00' });
  w.row({ title: 'Meeting', startAt: at('10:00'), endAt: at('11:00') });
  w.row({ title: 'Urlaub', allDay: true, startAt: at('00:00'), endAt: at('00:00', '2026-10-28') });
  const pinned = w.todo('Buch');
  const byAgent = w.todo('Paket');
  const byPlanner = w.todo('Wäsche');
  w.calendar.upsertBlock(pinned.id, at('12:00'), at('13:00'), 'person');
  w.calendar.upsertBlock(byAgent.id, at('13:00'), at('13:30'), 'agent');
  w.calendar.upsertBlock(byPlanner.id, at('14:00'), at('14:30'), 'planner');
  assert.deepEqual(w.calendar.busy(HUMAN_ID, at('00:00'), at('23:59')), [
    { startAt: at('10:00'), endAt: at('11:00') }, { startAt: at('12:00'), endAt: at('13:00') }, { startAt: at('13:00'), endAt: at('13:30') },
    { startAt: at('14:00'), endAt: at('14:30') },
  ]);
  const blocks = w.calendar.blocksFor([pinned.id, byPlanner.id, 'task_none', pinned.id]);
  assert.deepEqual([...blocks.keys()].sort(), [pinned.id, byPlanner.id].sort());
  assert.equal(blocks.get(byPlanner.id)?.setBy, 'planner');
  assert.equal(w.calendar.list(ANNA, at('00:00'), at('23:59')).events.length, 0, "another member's calendar is empty");
});
