// End-to-end (B-041 My day; Umbau Einfachheit: no task router, no rule split – one plain to-do per line, the AI
// splits the rest): Robin's evening list through both inputs, the calendar, the day plan, check-off and "Send to
// team" – over the real headless runtime (built app/runtime-cli.mjs) with the deterministic demo engine and real
// WebSocket RPC.
//   * Work (tasks.quickCreate) makes ONE plain task of what was typed – team work for the responsible manager, not
//     the person's list.
//   * My day (day.add) makes one to-do per line and keeps every one the person's.
//   * calendar.add (kind 'event') at 10:00 tomorrow; day.plan for tomorrow places blocks inside working hours,
//     clear of the event and its buffer.
//   * Ticking off 'Küche aufräumen' before its block removes the block.
//   * day.sendToTeam takes a to-do off the person's list; it stays the team's and is listed as handed off.
// Owns: this flow check. Never: touches the person's data (temp profile).
// Run: npm run build && node --test test/e2e/day-flow.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const LINES = ['Wäsche waschen', 'Küche aufräumen', 'Steuern erledigen', 'Webseite verbessern', 'am Buch arbeiten'];

/** YYYY-MM-DD of `at` in `tz`. */
function localDate(at, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Epoch ms of the wall time `hh:mm` on `date` in `tz` (two passes cover a DST change). */
function wallTime(date, hh, mm, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (at) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map((part) => [part.type, part.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

const titled = (tasks, pattern) => tasks.filter((task) => pattern.test(task.title));

test('My day flow: Work task, day.add, event, plan, check-off, Send to team', { timeout: 300_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const settings = await client.call('settings.get');
  const day = settings.day;
  assert.ok(day?.workStart && day?.workEnd, 'day settings are filled with defaults');
  const { tz } = await client.call('calendar.list', { from: Date.now(), to: Date.now() + 60_000 });
  const tomorrow = localDate(Date.now() + 24 * 60 * 60_000, tz);
  const ids = { day: [] };

  await t.test('Work: one plain task of what was typed – team work, not the person\'s list', async () => {
    const posted = await client.call('tasks.quickCreate', { text: 'Prepare the tax papers for the accountant', clientId: 'e2e-day-flow-work' });
    assert.equal(posted.task.title, 'Prepare the tax papers for the accountant');
    assert.notEqual(posted.task.assigneeKind, 'human', 'no target: team work');
    const again = await client.call('tasks.quickCreate', { text: 'Prepare the tax papers for the accountant', clientId: 'e2e-day-flow-work' });
    assert.equal(again.task.id, posted.task.id, 'a retried post returns the first task');
    const todos = await client.call('todos.list', { limit: 200 });
    assert.ok(!todos.some((task) => task.id === posted.task.id), 'not on the person\'s list');
  });

  await t.test('My day: one to-do per line, every one the person\'s', async () => {
    const { tasks } = await client.call('day.add', { text: LINES.join('\n'), clientId: 'e2e-day-flow-day' });
    assert.equal(tasks.length, LINES.length, `one to-do per line (got ${tasks.length})`);
    for (const task of tasks) assert.equal(task.assigneeKind, 'human', `${task.title}: the person's`);
    ids.day = tasks.map((task) => task.id);
    const todos = await client.call('todos.list', { limit: 200 });
    for (const task of tasks) assert.ok(todos.some((todo) => todo.id === task.id), `${task.title} is on the To-do list`);
    assert.equal(titled(tasks, /steuern/i).length, 1, 'taxes stay the person\'s here');
    t.diagnostic(`day parts: ${tasks.map((task) => task.title).join(' · ')}`);
  });

  let event;
  await t.test('calendar.add: a 10:00 event tomorrow', async () => {
    const startAt = wallTime(tomorrow, 10, 0, tz);
    const added = await client.call('calendar.add', { text: 'Zahnarzt', startAt, endAt: startAt + 60 * 60_000, kind: 'event' });
    event = added.event;
    assert.equal(event.kind, 'event');
    assert.equal(event.startAt, startAt);
    assert.equal(added.task, undefined, 'an event makes no to-do');
  });

  let blocks;
  await t.test('day.plan: blocks inside working hours, clear of the event and its buffer', async () => {
    const result = await client.call('day.plan', { date: tomorrow, mode: 'plan' });
    assert.equal(result.date, tomorrow);
    assert.ok(result.placed.length >= 4, `placed ${result.placed.length}, unplanned ${JSON.stringify(result.unplanned)}`);
    const [sh, sm] = day.workStart.split(':').map(Number);
    const [eh, em] = day.workEnd.split(':').map(Number);
    const open = wallTime(tomorrow, sh, sm, tz);
    const close = wallTime(tomorrow, eh, em, tz);
    const list = await client.call('calendar.list', { from: wallTime(tomorrow, 0, 0, tz), to: wallTime(tomorrow, 23, 59, tz) });
    blocks = list.events.filter((row) => row.kind === 'todo');
    assert.ok(list.events.some((row) => row.id === event.id), 'the event is listed');
    const buffer = (day.bufferMin ?? 0) * 60_000;
    for (const block of blocks) {
      assert.equal(block.setBy, 'planner');
      assert.ok(block.startAt >= open && block.endAt <= close, `block ${new Date(block.startAt).toISOString()} inside working hours`);
      assert.ok(block.endAt + buffer <= event.startAt || block.startAt >= event.endAt + buffer, `block ${new Date(block.startAt).toISOString()}–${new Date(block.endAt).toISOString()} clear of the event`);
    }
    const sorted = [...blocks].sort((a, b) => a.startAt - b.startAt);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].startAt >= sorted[i - 1].endAt, 'blocks do not overlap');
    for (const id of ids.day) {
      const todo = (await client.call('todos.list', { limit: 200 })).find((task) => task.id === id);
      if (todo) assert.ok(blocks.some((block) => block.taskId === id) || result.unplanned.some((entry) => entry.taskId === id), `${todo.title} placed or reported`);
    }
  });

  await t.test('ticking off Küche aufräumen before its block removes the block', async () => {
    const todos = await client.call('todos.list', { limit: 200 });
    const kitchen = todos.find((task) => ids.day.includes(task.id) && /küche/i.test(task.title));
    assert.ok(kitchen, 'Küche aufräumen is on the list');
    const block = blocks.find((row) => row.taskId === kitchen.id);
    assert.ok(block, 'it has a block tomorrow');
    const removed = client.waitFor('calendar.removed', (data) => data.id === block.id, 30_000);
    await client.call('tasks.complete', { id: kitchen.id, clientId: 'e2e-day-flow-done' });
    await removed;
    const list = await client.call('calendar.list', { from: wallTime(tomorrow, 0, 0, tz), to: wallTime(tomorrow, 23, 59, tz) });
    assert.ok(!list.events.some((row) => row.id === block.id), 'the block is gone');
    assert.ok(list.events.some((row) => row.id === event.id), 'the event stays');
  });

  await t.test('day.sendToTeam: the to-do leaves the person\'s list and stays the team\'s', async () => {
    const todos = await client.call('todos.list', { limit: 200 });
    const taxes = todos.find((task) => ids.day.includes(task.id) && /steuern/i.test(task.title));
    assert.ok(taxes, 'the My day to-do Steuern erledigen');
    const sent = await client.call('day.sendToTeam', { id: taxes.id });
    assert.notEqual(sent.assigneeKind, 'human', 'handed to the team');
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the responsible manager may take it meanwhile
    const after = await client.call('todos.list', { limit: 200 });
    assert.ok(!after.some((task) => task.id === taxes.id), 'off the person\'s list');
    const current = await client.call('tasks.get', { id: taxes.id });
    assert.notEqual(current.assigneeKind, 'human', 'still the team\'s');
    const handed = await client.call('day.handedOff', {});
    assert.ok(handed.some((task) => task.id === taxes.id), 'listed under Handed off');
  });
});
