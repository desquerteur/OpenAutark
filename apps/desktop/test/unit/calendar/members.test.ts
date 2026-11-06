// B-078 (D20, head of staff as an open capability): the calendar across members – commonGaps over each member's own
// window and buffer; `who` resolution (human, a colleague on their own linked PC, rooms, unknown ids); calendar.ask on
// the PC that answers (my own PC and the company get entries with "Only me" to-dos masked, an employee's PC asking the
// company gets busy only; an add goes through that PC's own rules and names the asking PC); the agent tools with `who`
// (busy only for others and in shared chats, the time everyone shares, one booking per member, refused over a
// colleague's appointment before anything is written, an offline PC said plainly); rooms from calendar.connect; people.list
// says where each person is reachable; calendar.person for the person page.
// Owns: these assertions only. Never: a real mesh, network or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { calendarTools } from '../../../src/runtime/tools/builtin/calendar.ts';
import { peopleTools } from '../../../src/runtime/tools/builtin/people.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { commonGaps } from '../../../src/runtime/calendar/rules.ts';
import { resolveMember, roomId, whoList } from '../../../src/runtime/calendar/members.ts';
import { ASK_METHOD, serveAsk } from '../../../src/runtime/calendar/linked.ts';
import { personCalendar } from '../../../src/runtime/calendar/team.ts';
import { record } from '../devices/sync-net.ts';
import { ANNA, at, DAY, MIN, world } from './fixture.ts';

type World = ReturnType<typeof world>;

/** Company PC `a` and Anna's own PC `b`, linked: a sees b as her employee PC, b sees a as its employer. */
function linked(options: { online?: boolean } = {}) {
  const a = world({ now: '08:00' });
  const b = world({ now: '08:00' });
  new DevicesRepo(a.db).upsert(record('dev_b', { name: 'Anna-Laptop', personId: ANNA }));
  new DevicesRepo(b.db).upsert(record('dev_a', { name: 'Company-PC', joinedAs: 'employee' }));
  const calls: Array<{ method: string; params: unknown }> = [];
  const wire = (from: World, to: World, fromId: string) => {
    from.s.devices = {
      self: () => ({ id: fromId }), list: () => [], online: () => options.online !== false,
      call: async (_id: string, method: string, params: unknown) => { calls.push({ method, params }); return serveAsk(to.s, structuredClone(params), fromId); },
    } as unknown as RuntimeServices['devices'];
  };
  wire(a, b, 'dev_a');
  wire(b, a, 'dev_b');
  a.s.people = { list: () => [], nameOf: (id: string) => (id === ANNA ? 'Anna' : undefined) } as unknown as RuntimeServices['people'];
  return { a, b, calls };
}

function tools(w: World, conversationId?: string) {
  return async (name: string, args: Record<string, unknown>) => {
    const tool: ToolDef = [...calendarTools, ...peopleTools].find((item) => item.name === name)!;
    const ctx = { agent: w.org.get('ag_mara')!, runId: 'run_1', mode: 'secretary', services: w.s, signal: new AbortController().signal, status: () => {}, conversationId } as ToolContext;
    const out = await tool.run(args as never, ctx);
    const text = (out.content[0] as { text: string }).text;
    return { error: out.isError === true, text, data: out.isError ? undefined : JSON.parse(text) as Record<string, unknown> };
  };
}

test('commonGaps: the time every member has free, each inside their own window and with their own buffer', () => {
  const H = 60 * MIN;
  const gaps = commonGaps([
    { busy: [{ startAt: 10 * H, endAt: 11 * H }], from: 8 * H, to: 17 * H, bufferMin: 0 },
    { busy: [{ startAt: 13 * H, endAt: 14 * H }], from: 9 * H, to: 20 * H, bufferMin: 15 },
  ], 30);
  assert.deepEqual(gaps.map((gap) => [gap.startAt / H, gap.endAt / H]), [[9, 10], [11, 12.75], [14.25, 17]]);
  assert.deepEqual(commonGaps([], 30), []);
  assert.deepEqual(commonGaps([{ busy: [], from: 8 * H, to: 9 * H }, { busy: [], from: 9 * H, to: 10 * H }], 30), [], 'windows that do not meet share nothing');
});

test('who: a string or a list; rooms by name; unknown ids say why; a colleague resolves to their own linked PC', () => {
  assert.deepEqual(whoList('human'), ['human']);
  assert.deepEqual(whoList(['human', ANNA, 'human']), ['human', ANNA]);
  assert.equal(typeof whoList([]), 'string');
  assert.equal(roomId('Meeting Room 2'), 'room:meeting-room-2');
  assert.equal(roomId('room:Küche'), 'room:kuche');
  assert.equal(roomId('!!'), undefined);
  const { a } = linked();
  const name = (id: string) => (id === ANNA ? 'Anna' : 'Robin');
  assert.deepEqual(resolveMember(a.s, ANNA, name), { who: ANNA, name: 'Anna', where: 'linked', deviceId: 'dev_b', pc: 'Anna-Laptop', online: true });
  assert.equal(resolveMember(a.s, 'ag_mara', name).where, 'none');
  assert.equal(resolveMember(a.s, 'room:nowhere', name).where, 'none');
  assert.deepEqual(resolveMember(a.s, HUMAN_ID, name), { who: HUMAN_ID, name: 'Robin', where: 'here', ownerId: HUMAN_ID });
});

test('calendar.ask: the company gets entries with an "Only me" to-do masked; an employee PC asking the company gets busy only; an unknown PC nothing', async () => {
  const { a, b } = linked();
  b.row({ title: 'Dentist', startAt: at('10:00'), endAt: at('11:00') });
  const secret = b.todo('Therapy', { private: true });
  b.row({ kind: 'todo', taskId: secret.id, startAt: at('12:00'), endAt: at('12:30') });
  const toCompany = await serveAsk(b.s, { op: 'list', from: at('00:00'), to: at('23:59') }, 'dev_a');
  assert.deepEqual(toCompany.entries?.map((entry) => entry.title), ['Dentist', 'Busy']);
  assert.equal(toCompany.tz, 'Europe/Vienna');
  assert.deepEqual(toCompany.hours, { start: '08:00', end: '20:00' });
  a.row({ title: 'Board meeting', startAt: at('09:00'), endAt: at('10:00') });
  const toEmployee = await serveAsk(a.s, { op: 'list', from: at('00:00'), to: at('23:59') }, 'dev_b');
  assert.equal(toEmployee.entries, undefined, 'an employee PC sees the company busy only');
  assert.deepEqual(toEmployee.busy, [{ startAt: at('09:00'), endAt: at('10:00') }]);
  await assert.rejects(serveAsk(a.s, { op: 'busy', from: 0, to: 1 }, 'dev_stranger'), (error: unknown) => (error as WorkforceError).code === 'forbidden');
  await assert.rejects(serveAsk(a.s, { op: 'busy', from: 0, to: 40 * 24 * 60 * MIN }, 'dev_b'), /31 days/);
});

test('calendar.ask add: written through that PC\'s rules – never over its appointments – and named after the asking PC', async () => {
  const { b } = linked();
  b.row({ title: 'Dentist', startAt: at('10:00'), endAt: at('11:00') });
  await assert.rejects(serveAsk(b.s, { op: 'add', title: 'Sync', startAt: at('10:30'), endAt: at('11:30') }, 'dev_a'), (error: unknown) => (error as WorkforceError).code === 'conflict');
  const answer = await serveAsk(b.s, { op: 'add', title: 'Sync', startAt: at('14:00'), endAt: at('14:30') }, 'dev_a');
  const row = b.calendar.repo.get(answer.event!.id)!;
  assert.equal(row.title, 'Sync');
  assert.match(row.notes ?? '', /Booked from Company-PC/);
  assert.equal(row.setBy, 'agent');
});

test('calendar tools with who: others as busy only, the time both share, one booking each; titles only for the turn\'s own person', async () => {
  const { a, b, calls } = linked();
  b.row({ title: 'Dentist', startAt: at('10:00'), endAt: at('11:00') });
  a.row({ title: 'Board meeting', startAt: at('09:00'), endAt: at('10:00') });
  const call = tools(a);
  const list = await call('calendar.list', { from: DAY, to: DAY, who: ANNA });
  assert.doesNotMatch(list.text, /Dentist/);
  const members = list.data!.members as Array<{ who: string; busy: unknown[] }>;
  assert.equal(members[0].who, ANNA);
  assert.equal(members[0].busy.length, 1);
  assert.equal(calls[0].method, ASK_METHOD);
  const own = await call('calendar.list', { from: DAY, to: DAY });
  assert.match(own.text, /Board meeting/, 'the owner alone with the agent sees their own titles');

  const free = await call('calendar.find_free', { date: DAY, minutes: 60, who: ['human', ANNA] });
  const first = (free.data!.free as Array<{ start: string }>)[0];
  assert.equal(Date.parse(first.start), at('11:10'), 'after both appointments and the 10-minute buffer');
  assert.deepEqual(free.data!.with, ['Robin', 'Anna']);

  const booked = await call('calendar.add', { title: 'Sync', startAt: '2026-10-27T11:30', endAt: '2026-10-27T12:00', who: ['human', ANNA] });
  assert.equal(booked.data!.ok, true, booked.text);
  assert.equal(a.calendar.list(HUMAN_ID, at('11:00'), at('13:00')).events.filter((row) => row.title === 'Sync').length, 1);
  assert.equal(b.calendar.list(HUMAN_ID, at('11:00'), at('13:00')).events.filter((row) => row.title === 'Sync').length, 1, 'Anna\'s PC wrote it into her calendar');

  const over = await call('calendar.add', { title: 'Clash', startAt: '2026-10-27T10:15', endAt: '2026-10-27T10:45', who: ['human', ANNA] });
  assert.equal(over.error, true);
  assert.match(over.text, /Anna is busy then/);
  assert.equal(a.calendar.list(HUMAN_ID, at('10:00'), at('11:00')).events.some((row) => row.title === 'Clash'), false, 'nothing written for anyone');
});

test('in a chat colleagues read along: busy only for the owner too; an offline colleague is said plainly', async () => {
  const { a } = linked({ online: false });
  a.row({ title: 'Board meeting', startAt: at('09:00'), endAt: at('10:00') });
  const chat = a.chat();
  a.addPerson(chat.id);
  const call = tools(a, chat.id);
  const list = await call('calendar.list', { from: DAY, to: DAY });
  assert.equal(list.error, false);
  assert.doesNotMatch(list.text, /Board meeting/);
  const free = await call('calendar.find_free', { date: DAY, minutes: 30, who: ['human', ANNA] });
  assert.match(free.text, /Anna is offline \(Anna-Laptop\)/);
  const booked = await call('calendar.add', { title: 'Sync', startAt: '2026-10-27T14:00', who: [ANNA] });
  assert.equal(booked.error, true);
  assert.match(booked.text, /offline/);
});

test('rooms: a connected calendar of a room is listed and booked in Autark; people.list says where each person is', async () => {
  const { a } = linked();
  a.db.run(`INSERT INTO calendar_sources (id, owner_id, kind, label, visible, writable, status, created_at) VALUES ('cal_room', 'room:atelier', 'ics', 'Atelier', 1, 0, 'ok', 1)`);
  const call = tools(a);
  const free = await call('calendar.find_free', { date: DAY, minutes: 30, who: ['room:atelier'] });
  assert.equal(free.error, false, free.text);
  const booked = await call('calendar.add', { title: 'Workshop', startAt: '2026-10-27T15:00', who: ['room:Atelier'] });
  assert.equal(booked.data!.ok, true, booked.text);
  assert.match(booked.text, /booked in Autark/);
  assert.equal(a.calendar.list('room:atelier', at('14:00'), at('16:00')).events.length, 1);

  a.s.people = { list: () => [
    { id: HUMAN_ID, name: '', title: 'CEO', status: 'active' }, { id: ANNA, name: 'Anna', title: 'Design', status: 'active' },
  ], nameOf: (id: string) => (id === ANNA ? 'Anna' : undefined) } as unknown as RuntimeServices['people'];
  const people = JSON.parse((await call('people.list', {})).text) as Array<Record<string, unknown>>;
  assert.deepEqual(people.map((row) => [row.id, row.pc, row.calendar]), [[HUMAN_ID, 'this PC', 'here'], [ANNA, { name: 'Anna-Laptop', online: true }, 'on their PC']]);
});

test('calendar.person: the company sees a person\'s entries from their PC; unreachable says why', async () => {
  const { a, b } = linked();
  b.row({ title: 'Dentist', startAt: at('10:00'), endAt: at('11:00') });
  const member = resolveMember(a.s, ANNA, () => 'Anna');
  const seen = await personCalendar(a.s, member, at('00:00'), at('23:59'));
  assert.deepEqual(seen.entries.map((entry) => entry.title), ['Dentist']);
  assert.equal(seen.reachable, true);
  const none = await personCalendar(a.s, resolveMember(a.s, 'per_nobody000000', () => 'Ben'), at('00:00'), at('23:59'));
  assert.equal(none.reachable, false);
  assert.match(none.note ?? '', /No calendar of Ben is reachable/);
});
