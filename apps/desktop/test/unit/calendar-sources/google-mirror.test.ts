// B-041 track G: My day's own rows mirrored into the person's "Workforce" Google calendar – a to-do block (made,
// moved, done ✓, removed), an "Only me" to-do as "Busy", an event made in the app with its title; the app's event id
// and extendedProperties.private {eventId, taskId, pcId}; only the PC set as pc_device_id writes, and only with the
// app-calendar scope; a sync repairs writes that failed, deletes mirrors of rows that went and makes a deleted
// Workforce calendar again.
// Owns: checks of runtime/calendar/sources/google-mirror.ts (with google-events.ts mirrorBody / mirrorId).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorId } from '../../../src/runtime/calendar/sources/google-events.ts';
import { PC, tick } from './fixture.ts';
import { BOTH_SCOPES } from './google-fake.ts';
import { setup, until } from './google-world.ts';
import { vienna } from './ics-fixtures.ts';

const iso = (date: string, hhmm: string) => new Date(vienna(date, hhmm)).toISOString();
const DAY = '2026-10-24';

test('a to-do block goes to the Workforce calendar and follows its moves, its check-off and its removal', async () => {
  const { google, w, connect } = await setup();
  await connect();
  assert.equal(google.calendars.size, 1, 'the Workforce calendar is made at the first sync');
  assert.ok(google.apiCalls().includes('POST /calendars'));
  const task = w.todo('Küche aufräumen');
  const block = w.calendar.upsertBlock(task.id, vienna(DAY, '10:00'), vienna(DAY, '10:30'), 'planner');
  await until(() => google.mirrors().length === 1);
  const [first] = google.mirrors();
  assert.equal(first.id, mirrorId(PC, block.id));
  assert.equal(first.summary, 'Küche aufräumen');
  assert.deepEqual(first.extendedProperties!.private, { eventId: block.id, taskId: task.id, pcId: PC });
  assert.deepEqual([first.start!.dateTime, first.end!.dateTime, first.start!.timeZone], [iso(DAY, '10:00'), iso(DAY, '10:30'), 'Europe/Vienna']);
  const moved = w.calendar.move(block.id, vienna(DAY, '11:00'), vienna(DAY, '11:30'), block.rev, 'human');
  await until(() => google.mirrors()[0].start!.dateTime === iso(DAY, '11:00'));
  w.clock.set(vienna(DAY, '12:00'));
  w.tasks.setStatus(task.id, 'done', 'human');
  await until(() => google.mirrors()[0].summary === '✓ Küche aufräumen');
  assert.equal(w.calendar.repo.get(moved.id)!.state, 'done');
  w.calendar.remove(moved.id, 'human');
  await until(() => google.mirrors().length === 0);
});

test('an "Only me" to-do shows as Busy; an event made in the app keeps its title and has no task', async () => {
  const { google, w, connect } = await setup();
  await connect();
  const secret = w.todo('Termin beim Psychologen', { private: true });
  w.calendar.upsertBlock(secret.id, vienna(DAY, '14:00'), vienna(DAY, '15:00'), 'planner');
  const { event } = await w.calendar.add({ text: 'Lunch with Tom', startAt: vienna(DAY, '12:00'), endAt: vienna(DAY, '13:00'), kind: 'event' }, 'human');
  await until(() => google.mirrors().length === 2);
  const byRow = new Map(google.mirrors().map((mirror) => [mirror.extendedProperties!.private!.eventId, mirror]));
  assert.equal([...byRow.values()].find((mirror) => mirror.extendedProperties!.private!.taskId === secret.id)!.summary, 'Busy');
  assert.equal(JSON.stringify(google.calls).includes('Psychologen'), false, 'no text of a private to-do leaves the PC');
  const lunch = byRow.get(event.id)!;
  assert.equal(lunch.summary, event.title);
  assert.equal('taskId' in lunch.extendedProperties!.private!, false);
});

test('only the PC set as pc_device_id writes; another PC on the same account reads only', async () => {
  const { google, w, connect } = await setup();
  const { source } = await connect();
  w.db.run('UPDATE calendar_sources SET pc_device_id = ? WHERE id = ?', ['dev_other', source.id]);
  assert.equal(w.sources.list('human')[0].writable, false);
  const writes = () => google.apiCalls().filter((call) => /^(PUT|POST|DELETE) /.test(call)).length;
  const before = writes();
  w.calendar.upsertBlock(w.todo('Steuern').id, vienna(DAY, '16:00'), vienna(DAY, '17:00'), 'planner');
  for (let i = 0; i < 20; i++) await tick();
  w.clock.advance(60_000);
  await w.sources.sync(source.id);
  assert.equal(writes(), before, 'nothing written from this PC');
  assert.ok(google.apiCalls().at(-1)!.startsWith('GET /calendars/primary/events'), 'it still reads');
});

test('without the app-calendar scope nothing is written and the source is not writable', async () => {
  const { google, w, connect } = await setup();
  google.grantedScope = 'https://www.googleapis.com/auth/calendar.events.readonly';
  const { source } = await connect();
  assert.equal(source.writable, false);
  assert.equal(google.calendars.size, 0);
  google.grantedScope = BOTH_SCOPES;
});

test('a sync repairs failed writes, deletes mirrors of rows that went and makes a deleted Workforce calendar again', async () => {
  const { google, w, connect } = await setup();
  const { source } = await connect();
  const calendarId = [...google.calendars.keys()][0];
  google.down = true;
  const block = w.calendar.upsertBlock(w.todo('Wäsche waschen').id, vienna(DAY, '17:00'), vienna(DAY, '18:00'), 'planner');
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(google.mirrors().length, 0, 'the write failed (offline)');
  google.down = false;
  google.calendars.get(calendarId)!.set('stray', {
    id: 'stray', status: 'confirmed', summary: 'Old block', start: { dateTime: iso(DAY, '08:00') }, end: { dateTime: iso(DAY, '09:00') },
    extendedProperties: { private: { eventId: 'cev_gone', pcId: PC } },
  });
  w.clock.advance(60_000);
  const [repaired] = await w.sources.sync(source.id);
  assert.equal(repaired.status, 'ok');
  assert.deepEqual(google.mirrors().map((mirror) => mirror.extendedProperties!.private!.eventId), [block.id]);
  google.calendars.clear(); // the person deleted the Workforce calendar in Google
  w.clock.advance(60_000);
  await w.sources.sync(source.id);
  assert.equal(google.calendars.size, 1);
  assert.notEqual([...google.calendars.keys()][0], calendarId);
  assert.deepEqual(google.mirrors().map((mirror) => mirror.extendedProperties!.private!.eventId), [block.id]);
  assert.equal(w.sourceRows()[0].write_calendar_id, [...google.calendars.keys()][0]);
});
