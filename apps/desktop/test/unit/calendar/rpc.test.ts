// B-041 foundation: the calendar.* and day.* RPC surface – tiers ('todo' for the person's own day, 'tasks' to hand
// work to the team, 'settings' to read connected calendars, the owner for everything that holds a credential),
// no person variants, 'unavailable' while a service is missing, empty reads on an empty profile (no briefing),
// the person's own rows through calendar.list/add/move/remove from a To-do phone (track A1), parameter checks, and
// the event side (rows and the briefing on 'tasks' for devices holding 'todo', source changes owner-only).
// Owns: checks of handlers/calendar.ts, handlers/day.ts, compose/calendar.ts and their scope rules only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { allowedScope } from '../../../src/runtime/rpc/table.ts';
import { mayReceive, maySubscribe } from '../../../src/runtime/rpc/scopes.ts';
import { createCalendar, stopCalendar } from '../../../src/runtime/compose/calendar.ts';
import { topicOf } from '../../../src/shared/api/events.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import type { CalendarEvent } from '../../../src/shared/model/calendar.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const FULL: DeviceCapability[] = ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'];
const device = (capabilities: DeviceCapability[]): ClientScope => ({ kind: 'device', deviceId: 'dev_day', capabilities, secure: true });
const DAY_TODO = ['calendar.list', 'calendar.add', 'calendar.move', 'calendar.remove', 'day.add', 'day.plan', 'day.briefing', 'day.handedOff'];
const OWNER_ONLY = ['calendar.addIcs', 'calendar.updateSource', 'calendar.removeSource', 'calendar.sync', 'calendar.google', 'calendar.connectGoogle', 'calendar.person'];
const VALID: Record<string, unknown> = {
  'calendar.list': { from: 1_000, to: 2_000 }, 'calendar.add': { text: 'Steuern', startAt: 1_000, endAt: 2_000, kind: 'auto' },
  'calendar.move': { id: 'cev_1', startAt: 1_000, endAt: 2_000, rev: 0 }, 'calendar.remove': { id: 'cev_1' }, 'calendar.sources': undefined,
  'calendar.addIcs': { url: 'https://calendar.example.com/basic.ics' }, 'calendar.updateSource': { id: 'cal_1', visible: false },
  'calendar.removeSource': { id: 'cal_1' }, 'calendar.sync': {}, 'calendar.google': undefined, 'calendar.connectGoogle': {},
  'calendar.person': { id: 'per_anna00000000', from: 1_000, to: 2_000 },
  'day.add': { text: 'Wäsche waschen, Küche aufräumen' }, 'day.plan': { date: '2026-10-25', mode: 'plan' },
  'day.briefing': { date: '2026-10-25' }, 'day.sendToTeam': { id: 'task_1' }, 'day.handedOff': {},
};

test('tiers: the day for To-do devices, Send to team with tasks, sources read with settings, credentials with the owner; people their own calendars', () => {
  const table = createHandlerTable();
  const may = (method: string, scope: ClientScope) => allowedScope(table.get(method)!.scope, scope);
  for (const method of DAY_TODO) assert.deepEqual(table.get(method)?.scope, { capability: 'todo' }, method);
  for (const method of DAY_TODO) assert.ok(may(method, device(['todo'])), method);
  assert.deepEqual(table.get('day.sendToTeam')?.scope, { capability: 'tasks' });
  assert.ok(!may('day.sendToTeam', device(['todo'])) && may('day.sendToTeam', device(['todo', 'tasks'])));
  assert.deepEqual(table.get('calendar.sources')?.scope, { person: true, base: { capability: 'settings' } }, 'B-078 D20: a person lists their own');
  const PERSON_TOO = new Set(['calendar.addIcs', 'calendar.removeSource']);
  for (const method of OWNER_ONLY) {
    assert.deepEqual(table.get(method)?.scope, PERSON_TOO.has(method) ? { person: true, base: 'owner' } : 'owner', method);
    assert.ok(!may(method, device(FULL)), method);
  }
  assert.deepEqual(Object.keys(VALID).sort(), table.methods().filter((method) => /^(calendar|day)\./.test(method)).sort(), 'every new method is covered here');
});

test("without the services every method answers 'unavailable'", async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const owner = new TestClient(f.server, OWNER);
  for (const [method, params] of Object.entries(VALID)) assert.equal((await owner.request(method, params)).error?.code, 'unavailable', method);
});

test('wired, an empty profile answers empty reads in the profile zone (no briefing, nothing handed off, no sources)', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(() => { stopCalendar(f.services); f.cleanup(); });
  createCalendar(f.services);
  const phone = new TestClient(f.server, device(['todo']));
  assert.deepEqual(await phone.call('calendar.list', VALID['calendar.list']), { events: [], agentRuns: [], tz: 'UTC', staleSources: [] });
  assert.equal(await phone.call('day.briefing', VALID['day.briefing']), null);
  assert.deepEqual(await phone.call('day.handedOff', {}), []);
  const owner = new TestClient(f.server, OWNER);
  assert.deepEqual(await owner.call('calendar.sources'), []);
  assert.deepEqual(await owner.call('calendar.sync', {}), []);
  assert.equal((await owner.call<{ configured: boolean; connected: boolean }>('calendar.google')).connected, false);
});

test("track A1: a To-do phone plans its day through calendar.* – a slot to-do, a move, a removal – and hears every change on 'tasks'", async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(() => { stopCalendar(f.services); f.cleanup(); });
  createCalendar(f.services);
  const phone = new TestClient(f.server, device(['todo']));
  await phone.call('events.subscribe', { topics: ['tasks'] });
  const start = f.clock.now() + 60 * 60_000;
  const added = await phone.call<{ event: CalendarEvent; task?: { id: string; title: string; estimateMin?: number } }>('calendar.add', { text: 'Steuern 30 min', startAt: start, clientId: 'slot-1' });
  assert.deepEqual([added.event.kind, added.event.setBy, added.event.endAt - added.event.startAt, added.task?.title, added.task?.estimateMin], ['todo', 'person', 30 * 60_000, 'Steuern 30 min', 30]); // the text is the title as written
  const list = await phone.call<{ events: CalendarEvent[] }>('calendar.list', { from: start - 1, to: start + 2 * 60 * 60_000 });
  assert.deepEqual(list.events.map((row) => row.id), [added.event.id]);
  const moved = await phone.call<CalendarEvent>('calendar.move', { id: added.event.id, startAt: start + 30 * 60_000, endAt: start + 60 * 60_000, rev: added.event.rev });
  assert.equal(moved.rev, added.event.rev + 1);
  assert.equal((await phone.request('calendar.move', { id: added.event.id, startAt: start, endAt: start + 60_000, rev: added.event.rev })).error?.code, 'conflict', 'a stale rev');
  await phone.call('calendar.remove', { id: added.event.id });
  assert.equal((await phone.request('calendar.remove', { id: added.event.id })).error?.code, 'not_found');
  assert.ok(f.services.tasks.get(added.task!.id), 'removing the block keeps its to-do');
  assert.deepEqual(phone.events('calendar.upserted').map((frame) => (frame.data as CalendarEvent).rev), [0, 1]);
  assert.deepEqual(phone.events('calendar.removed').map((frame) => frame.data), [{ id: added.event.id, ownerId: 'human', taskId: added.task!.id }]);
});

test('parameters are checked: windows, times, days, minutes, addresses, unknown keys', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(() => { stopCalendar(f.services); f.cleanup(); });
  createCalendar(f.services);
  const owner = new TestClient(f.server, OWNER);
  const DAY = 24 * 60 * 60_000;
  for (const [method, params] of [
    ['calendar.list', { from: 2_000, to: 1_000 }], ['calendar.list', { from: 0, to: 63 * DAY }], ['calendar.list', { from: 0, to: 1, extra: true }],
    ['calendar.add', { text: '', startAt: 1 }], ['calendar.add', { text: 'x', startAt: 5, endAt: 5 }], ['calendar.add', { text: 'x', startAt: 1, kind: 'meeting' }],
    ['calendar.move', { id: 'cev_1', startAt: 10, endAt: 20 }], ['calendar.move', { id: 'cev_1', startAt: 10, endAt: 10 + 15 * DAY, rev: 1 }],
    ['day.plan', { date: '2026-02-30', mode: 'plan' }], ['day.plan', { date: '2026-10-25', mode: 'all' }], ['day.briefing', { date: '25.10.2026' }],
    ['day.add', { text: 'x', private: 'yes' }], ['calendar.addIcs', { url: 'ftp://example.com/a.ics' }], ['calendar.addIcs', { url: 'https://me:secret@example.com/a.ics' }],
    ['calendar.addIcs', { url: 'https://example.com/a.ics', room: '***' }],
    ['calendar.updateSource', { id: 'cal_1', color: 'red; background: url(x)' }], ['calendar.connectGoogle', { clientId: 'not a client id' }],
  ] as const) {
    assert.equal((await owner.request(method, params)).error?.code, 'bad_request', `${method} ${JSON.stringify(params)}`);
  }
});

test('B-078 D20: calendar.addIcs takes a room by name or id; the calendar then belongs to that room, its name the label', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(() => f.cleanup());
  const got: unknown[] = [];
  (f.services as { calendarSources?: unknown }).calendarSources = { addIcs: async (input: unknown) => { got.push(input); return { id: 'cal_1' }; } };
  const owner = new TestClient(f.server, OWNER);
  await owner.call('calendar.addIcs', { url: 'https://example.com/a.ics', room: 'Meeting room 2' });
  await owner.call('calendar.addIcs', { url: 'https://example.com/b.ics', label: 'Board', room: 'room:board' });
  await owner.call('calendar.addIcs', { url: 'https://example.com/d.ics', room: 'room:board' });
  await owner.call('calendar.addIcs', { url: 'https://example.com/c.ics' });
  assert.deepEqual(got, [
    { url: 'https://example.com/a.ics', label: 'Meeting room 2', room: 'room:meeting-room-2' },
    { url: 'https://example.com/b.ics', label: 'Board', room: 'room:board' },
    { url: 'https://example.com/d.ics', label: undefined, room: 'room:board' },
    { url: 'https://example.com/c.ics', label: undefined },
  ]);
});

test("events: calendar rows and the briefing travel on 'tasks' to devices holding 'todo'; source changes stay with the owner", () => {
  const row: CalendarEvent = { id: 'cev_1', ownerId: 'human', kind: 'todo', taskId: 'task_1', startAt: 1, endAt: 2, sourceId: 'local', setBy: 'planner', state: 'planned', createdBy: 'system', rev: 0, createdAt: 1, updatedAt: 1 };
  const events = [['calendar.upserted', row], ['calendar.removed', { id: 'cev_1', ownerId: 'human', taskId: 'task_1' }], ['day.briefing', { ownerId: 'human', date: '2026-10-25' }]] as const;
  for (const [event, data] of events) {
    assert.equal(topicOf(event, data), 'tasks', event);
    assert.ok(maySubscribe(device(['todo']), 'tasks') && mayReceive(device(['todo']), 'tasks', event, data), event);
    assert.ok(!mayReceive(device(['tasks']), 'tasks', event, data), `${event}: not without 'todo'`);
    assert.ok(mayReceive(OWNER, 'tasks', event, data), event);
  }
  assert.ok(mayReceive(device(['tasks']), 'tasks', 'task.upserted'), 'task events are unchanged');
  assert.equal(topicOf('calendar.sources', { ownerId: 'human' }), 'system');
  assert.ok(mayReceive(OWNER, 'system', 'calendar.sources', { ownerId: 'human' }));
  assert.ok(!mayReceive(device(FULL), 'system', 'calendar.sources', { ownerId: 'human' }));
});
