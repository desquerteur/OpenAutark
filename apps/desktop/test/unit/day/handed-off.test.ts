// B-041 track A2: what the person handed off and "Send to team" (runtime/day/handed-off.ts through the day
// service) – the person's work that agents or the team own, open or done since last evening, with their steps;
// never the person's own to-dos, an agent's own work or cancelled work; an own to-do sent to the team becomes
// team work where it is (B-054: chat-free, nothing moves) and the responsible manager is woken (its timer stops, its
// block goes, "Only me" ends), and only to-dos the person wrote can go.
// Owns: checks of day.handedOff / day.sendToTeam only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { zonedTime } from '../../../src/runtime/calendar/when.ts';
import { BERLIN, agent, dayFixture } from './fixture.ts';

const wall = (date: string, clock: string) => zonedTime(date, Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)), BERLIN);

test('handed off: open work others own plus what they finished since last evening, with its steps', async () => {
  const f = dayFixture({ now: wall('2026-10-26', '18:00') });
  f.org.add(agent('ag_mara', 'Mara', { createdAt: 1 }));
  const chat = f.s.chats.create({ agentIds: ['ag_mara'], humans: true, createdBy: HUMAN_ID }).id;
  const make = (title: string, extra: Record<string, unknown> = {}) => f.s.tasks.create({ conversationId: chat, title, assigneeKind: 'agent', assigneeId: 'ag_mara', createdBy: HUMAN_ID, ...extra });
  const oldDone = make('Old report');
  f.s.tasks.setStatus(oldDone.id, 'done', HUMAN_ID);
  f.clock.set(wall('2026-10-26', '21:00'));
  const nightDone = make('Taxes prepared');
  f.s.tasks.setStatus(nightDone.id, 'done', HUMAN_ID);
  const working = make('Research flights', { steps: ['Compare prices'] });
  const cancelled = make('Dropped');
  f.s.tasks.setStatus(cancelled.id, 'cancelled', HUMAN_ID);
  f.s.tasks.create({ conversationId: chat, title: 'Mara\'s own idea', assigneeKind: 'agent', assigneeId: 'ag_mara', createdBy: 'ag_mara' });
  await f.day.add({ text: 'Wäsche waschen' }, HUMAN_ID);
  const team = f.quick('Find a plumber').task;
  f.clock.set(wall('2026-10-27', '07:00'));
  const list = f.day.handedOff(HUMAN_ID);
  assert.deepEqual(list.map((task) => task.title).sort(), ['Find a plumber', 'Research flights', 'Taxes prepared'].sort());
  assert.deepEqual(list.find((task) => task.id === working.id)?.steps.map((step) => step.title), ['Compare prices']);
  assert.ok(list.some((task) => task.id === team.id));
  assert.deepEqual(f.day.handedOff(HUMAN_ID, 0).map((task) => task.title).includes('Old report'), true, 'an explicit since reaches further back');
});

test('Send to team: an own to-do becomes team work where it is and its manager is woken; its timer, block and "Only me" go', async () => {
  const f = dayFixture({ now: wall('2026-10-26', '09:00') });
  f.org.add(agent('ag_mara', 'Mara', { role: 'Manager', mode: 'manager', createdAt: 1 }));
  const startAt = wall('2026-10-27', '09:00');
  const [taxes] = (await f.day.add({ text: 'Steuern erledigen', private: true, startAt }, HUMAN_ID)).tasks;
  f.day.focus(taxes.id, 'start', HUMAN_ID);
  f.clock.advance(60_000);
  assert.equal(f.calendar.events.length, 1);
  const sent = await f.day.sendToTeam(taxes.id, HUMAN_ID);
  assert.equal(sent.assigneeKind, 'team');
  assert.equal(sent.private, undefined);
  assert.deepEqual([sent.spentMs, sent.timerStartedAt], [60_000, undefined]);
  assert.deepEqual(f.calendar.events, [], 'its block left My day');
  assert.ok(f.s.wakes.list('ag_mara').some((wake) => wake.taskId === taxes.id), 'the manager decides who does it');
  assert.equal(f.s.tasks.get(taxes.id)?.conversationId, undefined, 'still chat-free: nothing moved to a chat');
  assert.ok(f.day.handedOff(HUMAN_ID).some((task) => task.id === taxes.id), 'it shows under Handed off');
});

test('Send to team refuses what is not an own, open, top-level to-do the person wrote', async () => {
  const f = dayFixture();
  f.org.add(agent('ag_x', 'Mara', { createdAt: 1 }));
  const chat = f.s.chats.create({ agentIds: ['ag_x'], humans: true, createdBy: HUMAN_ID }).id;
  const ask = f.s.tasks.create({ conversationId: chat, title: 'Upload the file', assigneeKind: 'human', createdBy: 'ag_x', humanReason: 'physical' });
  await assert.rejects(f.day.sendToTeam(ask.id, HUMAN_ID), { code: 'bad_request' });
  const [wash] = (await f.day.add({ text: 'Wäsche waschen' }, HUMAN_ID)).tasks;
  f.s.tasks.setStatus(wash.id, 'done', HUMAN_ID);
  await assert.rejects(f.day.sendToTeam(wash.id, HUMAN_ID), { code: 'conflict' });
  await assert.rejects(f.day.sendToTeam('task_missing00000', HUMAN_ID), { code: 'not_found' });
});

