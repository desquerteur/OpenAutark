// B-078 D20 (people/rpc-calendar.ts): a colleague who joined by phone or browser connects their own calendar – the
// sources they list, add and remove are theirs (owner = their person id); a room or the owner's calendar is out of
// their reach.
// Owns: these assertions only. Never: a network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarSource } from '../../../src/shared/model/calendar.ts';
import { register as calendarHandlers } from '../../../src/runtime/rpc/handlers/calendar.ts';
import { peopleRig } from './rig.ts';

test('a person lists, adds and removes only their own calendars', async (t) => {
  const r = peopleRig({ modules: [calendarHandlers] });
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const rows: CalendarSource[] = [
    { id: 'cal_owner', ownerId: 'human', kind: 'ics', label: 'Mine', visible: true, writable: false, status: 'ok' },
    { id: 'cal_room', ownerId: 'room:board', kind: 'ics', label: 'Board', visible: true, writable: false, status: 'ok' },
  ];
  const added: Array<[unknown, string]> = [];
  const removed: string[] = [];
  (r.services as { calendarSources?: unknown }).calendarSources = {
    list: (ownerId: string) => rows.filter((row) => row.ownerId === ownerId),
    addIcs: async (input: { url: string; label?: string }, by: string) => {
      added.push([input, by]);
      const row: CalendarSource = { id: 'cal_anna', ownerId: by, kind: 'ics', label: input.label ?? 'Anna', visible: true, writable: false, status: 'ok' };
      rows.push(row);
      return row;
    },
    remove: async (id: string) => { removed.push(id); },
  };
  assert.deepEqual(await anna.client.call('calendar.sources'), []);
  await anna.client.call('calendar.addIcs', { url: 'https://calendar.example.com/anna.ics', label: 'Anna' });
  assert.deepEqual(added, [[{ url: 'https://calendar.example.com/anna.ics', label: 'Anna' }, anna.person.id]]);
  assert.deepEqual((await anna.client.call<CalendarSource[]>('calendar.sources')).map((row) => row.id), ['cal_anna']);
  assert.equal((await anna.client.request('calendar.addIcs', { url: 'https://example.com/r.ics', room: 'Board' })).error?.code, 'bad_request', 'rooms are the owner\'s');
  assert.equal((await anna.client.request('calendar.removeSource', { id: 'cal_owner' })).error?.code, 'not_found');
  assert.equal((await anna.client.request('calendar.removeSource', { id: 'cal_room' })).error?.code, 'not_found');
  await anna.client.call('calendar.removeSource', { id: 'cal_anna' });
  assert.deepEqual(removed, ['cal_anna']);
  assert.equal((await anna.client.request('calendar.sync', {})).error?.code, 'forbidden', 'nothing else of the calendar settings');
});
