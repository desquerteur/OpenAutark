// B-050 K10: calendar.move and calendar.remove (tools/builtin/calendar-change.ts) – an agent moves or removes an
// appointment it put in itself, or the block of one of the person's own to-dos it may plan; never an entry the person
// set, another agent's appointment, a row of a connected calendar or the block of an "Only me" to-do; a move keeps the
// length, never lands over the person's appointments and is visible in the agent's chat; a removed block leaves the
// to-do unplanned; nothing works from a chat colleagues read along.
// Owns: checks of these tools only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { calendarTools } from '../../../src/runtime/tools/builtin/calendar.ts';
import { calendarChangeTools } from '../../../src/runtime/tools/builtin/calendar-change.ts';
import { at, world } from './fixture.ts';

function setup() {
  const w = world({ now: '08:00' });
  const chat = w.chat();
  const tool = (name: string): ToolDef => [...calendarTools, ...calendarChangeTools].find((item) => item.name === name)!;
  const call = async (name: string, args: Record<string, unknown>, agentId = 'ag_mara') => {
    const ctx = { agent: w.org.get(agentId)!, runId: 'run_1', mode: 'secretary', services: w.s, signal: new AbortController().signal, status: () => {}, conversationId: chat.id } as ToolContext;
    const out = await tool(name).run(args as never, ctx);
    const text = (out.content[0] as { text: string }).text;
    return { error: out.isError === true, text, data: out.isError ? undefined : JSON.parse(text) as Record<string, unknown> };
  };
  const lines = () => w.chats.messages(chat.id).filter((message) => message.kind === 'status').map((message) => message.body);
  return { ...w, chat, call, lines };
}

test('registered with the built-ins as writes', () => {
  const names = builtinTools().map((tool) => tool.name);
  for (const name of ['calendar.move', 'calendar.remove']) assert.ok(names.includes(name), name);
  assert.deepEqual(calendarChangeTools.map((tool) => tool.category), ['think', 'think']);
});

test('calendar.move: its own appointment keeps its length, never over the person\'s appointment; visible in the chat', async () => {
  const w = setup();
  w.row({ title: 'Meeting', startAt: at('10:00'), endAt: at('11:00') });
  const added = await w.call('calendar.add', { title: 'Zahnarzt', startAt: '2026-10-27T15:00', endAt: '2026-10-27T15:45' });
  const id = added.data!.eventId as string;
  const over = await w.call('calendar.move', { eventId: id, startAt: '2026-10-27T10:30' });
  assert.equal(over.error, true);
  assert.match(over.text, /taken/);
  assert.equal((await w.call('calendar.move', { eventId: id, startAt: '2026-10-27T07:00' })).error, true, 'not into the past');
  assert.equal(w.calendar.repo.get(id)!.startAt, at('15:00'), 'unchanged');
  const moved = await w.call('calendar.move', { eventId: id, startAt: '2026-10-27T16:00' });
  assert.equal(moved.error, false, moved.text);
  assert.deepEqual([w.calendar.repo.get(id)!.startAt, w.calendar.repo.get(id)!.endAt], [at('16:00'), at('16:45')]);
  assert.match(w.lines().at(-1)!, /Moved in the person's calendar: Zahnarzt · Tue 27 Oct 2026, 16:00–16:45/);
});

test('calendar.move and calendar.remove leave the person\'s entries, another agent\'s, connected rows and private blocks alone', async () => {
  const w = setup();
  w.org.add({ ...w.org.get('ag_mara')!, id: 'ag_tom', name: 'Tom' });
  const persons = w.row({ title: 'Notar', startAt: at('09:00'), endAt: at('10:00') });
  const toms = w.row({ title: 'Call', setBy: 'agent', createdBy: 'ag_tom', startAt: at('12:00'), endAt: at('12:30') });
  w.source('cal_g');
  const connected = w.row({ title: 'Sync', sourceId: 'cal_g', externalId: 'u1', readOnly: true, setBy: 'sync', startAt: at('13:00'), endAt: at('14:00') });
  const secret = w.todo('Therapie', { private: true });
  const block = w.calendar.upsertBlock(secret.id, at('17:00'), at('17:30'), 'planner');
  const pinned = w.todo('Buch');
  const pinnedBlock = w.calendar.upsertBlock(pinned.id, at('18:00'), at('18:30'), 'person');
  for (const [row, pattern] of [[persons, /The person set this entry/], [toms, /Only an appointment I put in/], [connected, /connected calendar/],
    [block, /not found/], [pinnedBlock, /The person set this entry/]] as const) {
    for (const name of ['calendar.move', 'calendar.remove']) {
      const out = await w.call(name, name === 'calendar.move' ? { eventId: row.id, startAt: '2026-10-27T19:00' } : { eventId: row.id });
      assert.equal(out.error, true, `${name} ${row.id}`);
      assert.match(out.text, pattern, `${name} ${row.id}`);
    }
    assert.equal(w.calendar.repo.get(row.id)!.startAt, row.startAt, 'unchanged');
  }
  assert.match((await w.call('calendar.remove', { eventId: 'cev_missing' })).text, /not found/);
});

test('a to-do block: calendar.move places it again as the agent\'s, calendar.remove leaves the to-do unplanned', async () => {
  const w = setup();
  const task = w.todo('Küche aufräumen', { estimateMin: 25 });
  const block = w.calendar.upsertBlock(task.id, at('09:00'), at('09:25'), 'planner');
  const moved = await w.call('calendar.move', { eventId: block.id, startAt: '2026-10-27T14:00' });
  assert.equal(moved.error, false, moved.text);
  const now = w.calendar.blocksFor([task.id]).get(task.id)!;
  assert.deepEqual([now.id, now.startAt, now.endAt, now.setBy], [block.id, at('14:00'), at('14:25'), 'agent'], 'the same row, now the agent\'s placement');
  const removed = await w.call('calendar.remove', { eventId: now.id });
  assert.equal(removed.error, false, removed.text);
  assert.equal(w.calendar.blocksFor([task.id]).size, 0);
  assert.equal(w.tasks.get(task.id)!.status, 'open', 'the to-do stays');
  assert.match(w.lines().at(-1)!, /Removed from the person's calendar: Küche aufräumen/);
});

test('calendar.remove: its own appointment goes; nothing works from a chat colleagues read along', async () => {
  const w = setup();
  const own = (await w.call('calendar.add', { title: 'Zahnarzt', startAt: '2026-10-27T15:00' })).data!.eventId as string;
  const kept = (await w.call('calendar.add', { title: 'Friseur', startAt: '2026-10-27T17:00' })).data!.eventId as string;
  assert.equal((await w.call('calendar.remove', { eventId: own })).error, false);
  assert.equal(w.calendar.repo.get(own), undefined);
  w.addPerson(w.chat.id);
  for (const [name, args] of [['calendar.move', { eventId: kept, startAt: '2026-10-27T18:00' }], ['calendar.remove', { eventId: kept }]] as const) {
    const out = await w.call(name, args);
    assert.equal(out.error, true, name);
    assert.match(out.text, /private to them/, name);
  }
  assert.ok(w.calendar.repo.get(kept));
});
