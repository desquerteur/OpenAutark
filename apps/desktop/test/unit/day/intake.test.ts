// My day's own input (runtime/day/intake.ts, day.add through the day service): one plain to-do of the person per
// line (no model, no guessing of times), the assistant woken once with them, "Only me" and "AI helps" off (no wake),
// a clicked slot as the person's block, a later day shown → window.date, retries with the same clientId.
// Owns: checks of the day.add flow only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent, dayFixture } from './fixture.ts';

const EVENING = Date.parse('2026-10-26T21:30:00Z'); // Monday 22:30 in Berlin
const secretary = () => agent('ag_sec', 'Sara', { role: 'Secretary', template: 'secretary', mode: 'secretary', createdAt: 1 });

test('one to-do per line, the person\'s own; the assistant is told once', async () => {
  const f = dayFixture({ now: EVENING });
  f.org.add(secretary());
  const { tasks } = await f.day.add({ text: 'Wäsche waschen\n- Küche aufräumen\n\n2. Steuern erledigen' }, HUMAN_ID);
  assert.deepEqual(tasks.map((task) => task.title), ['Wäsche waschen', 'Küche aufräumen', 'Steuern erledigen']);
  assert.ok(tasks.every((task) => task.assigneeKind === 'human' && task.widget?.type === 'confirm' && !task.conversationId));
  const wakes = f.wakes.list('ag_sec');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].note ?? '', /Küche aufräumen/);
});

test('"Only me" and "AI helps" off wake nobody; Only me marks the to-dos private', async () => {
  const f = dayFixture({ now: EVENING });
  f.org.add(secretary());
  const { tasks } = await f.day.add({ text: 'Arzt anrufen', private: true }, HUMAN_ID);
  assert.equal(tasks[0].private, true);
  f.setDay({ aiHelps: false });
  await f.day.add({ text: 'Bank' }, HUMAN_ID);
  assert.equal(f.wakes.list('ag_sec').length, 0);
});

test('a clicked slot: one to-do for the whole text with the person\'s block; a later day shown is its window', async () => {
  const f = dayFixture({ now: EVENING });
  const startAt = Date.parse('2026-10-27T08:00:00Z');
  const { tasks } = await f.day.add({ text: 'Steuern\nmit Belegen', startAt, endAt: startAt + 45 * 60_000 }, HUMAN_ID);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].estimateMin, 45);
  const block = f.calendar.blocksFor([tasks[0].id]).get(tasks[0].id);
  assert.equal(block?.setBy, 'person');
  assert.equal(block?.startAt, startAt);
  const later = await f.day.add({ text: 'Einkaufen', date: '2026-10-29' }, HUMAN_ID);
  assert.deepEqual(later.tasks[0].window, { date: '2026-10-29' });
});

test('a retry with the same clientId makes nothing twice; empty or too long text is refused', async () => {
  const f = dayFixture({ now: EVENING });
  const first = await f.day.add({ text: 'A\nB', clientId: 'c1' }, HUMAN_ID);
  const again = await f.day.add({ text: 'A\nB', clientId: 'c1' }, HUMAN_ID);
  assert.deepEqual(again.tasks.map((task) => task.id), first.tasks.map((task) => task.id));
  await assert.rejects(f.day.add({ text: '   ' }, HUMAN_ID));
  await assert.rejects(f.day.add({ text: 'x'.repeat(9000) }, HUMAN_ID));
});
