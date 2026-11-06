// One arming step for human to-do widgets (F02, src/runtime/tasks/timers.ts), on a manual
// clock: a timer an agent asks for with a duration rings once at now + 10 min (absolute `at`,
// duration kept, dueAt set) – through human.ask, the human's own tasks.create path and an ask
// block in a message alike; an agent's invalid widget comes back as a precise error, but a confirm
// without instructions takes the to-do's why or title (C4-live); switching
// the widget ("Show as…") or updating it never makes a second schedule; the ring follows a new
// time or repeat (with the due time the old timer set) and goes when the widget is no longer a
// timer; the host's approval card keeps its host-only approvalId.
// Owns: these assertions only. Never: real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { humanTools } from '../../../src/runtime/tools/builtin/human.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

const MIN = 60_000;

function fixture() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const ctx: ToolContext = {
    agent: h.org.get('ag_ava')!, runId: 'run_f02', conversationId: chat.id, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  };
  const ask = humanTools.find((tool) => tool.name === 'human.ask')!;
  const timers = (taskId: string) => h.scheduler.list({ taskId }).filter((schedule) => schedule.kind === 'timer');
  return { ...h, chat, ctx, ask, timers };
}

function assertArmed(f: ReturnType<typeof fixture>, taskId: string, start: number): void {
  const task = f.tasks.get(taskId)!;
  const at = start + 10 * MIN;
  assert.equal(task.widget?.at, new Date(at).toISOString(), 'the timer time is absolute');
  assert.equal(task.widget?.duration, 'PT10M', 'the duration stays for display');
  assert.equal(task.dueAt, at, 'the to-do is due when it rings');
  const schedules = f.timers(taskId);
  assert.equal(schedules.length, 1, 'one ring schedule');
  assert.deepEqual(schedules[0].spec, { at });
  assert.equal(schedules[0].ownerId, HUMAN_ID);
}

test('human.ask: a 10-minute timer rings once at now + 10 min', async () => {
  const f = fixture();
  const start = f.clock.now();
  const out = await f.ask.run({ title: 'Take the bread out', reason: 'physical', widget: { type: 'timer', duration: 'PT10M', label: 'Bread' } }, f.ctx);
  const { todoId } = JSON.parse((out.content[0] as { text: string }).text) as { todoId: string };
  assertArmed(f, todoId, start);
});

test('the human\'s tasks.create path and an agent\'s ask block arm the same way', () => {
  const f = fixture();
  const start = f.clock.now();
  const typed = f.tasks.create({ conversationId: f.chat.id, title: 'Tea', assigneeKind: 'human', widget: { type: 'timer', duration: 'PT10M', label: 'Tea' }, createdBy: HUMAN_ID });
  assertArmed(f, typed.id, start);

  const body = '```ui\n{"type":"timer","duration":"PT10M","label":"Stretch"}\n```';
  const message = f.chats.send({ conversationId: f.chat.id, body, authorId: 'ag_ava', authorKind: 'agent' });
  const [todo] = f.tasks.ingestBlocks(message, uiBlocksOf(body).map((entry) => entry.block));
  assertArmed(f, todo.id, message.createdAt);
});

test('an agent\'s invalid widget is refused with a precise error', async () => {
  const f = fixture();
  await assert.rejects(
    f.ask.run({ title: 'Pick an intro', reason: 'taste', widget: { type: 'choice', question: 'Which intro?' } }, f.ctx),
    (error: Error) => /Invalid choice widget: .*options/.test(error.message),
  );
  assert.equal(f.tasks.todos().length, 0, 'nothing landed on the list');
});

test('a confirm without its own instructions shows the to-do\'s why, else its title (C4-live)', async () => {
  const f = fixture();
  const todo = async (args: Record<string, unknown>) => {
    const out = await f.ask.run({ reason: 'physical', ...args } as Parameters<typeof f.ask.run>[0], f.ctx);
    return f.tasks.get((JSON.parse((out.content[0] as { text: string }).text) as { todoId: string }).todoId)!;
  };
  const withWhy = await todo({ title: 'Spülmaschine ausräumen', why: 'Geschirr verstauen, dann bestätigen.', widget: { type: 'confirm' } });
  assert.equal(withWhy.widget?.instructions, 'Geschirr verstauen, dann bestätigen.');
  const titleOnly = await todo({ title: 'Müll rausbringen', widget: { type: 'confirm' } });
  assert.equal(titleOnly.widget?.instructions, 'Müll rausbringen');
});

test('switching or updating the widget never makes a second schedule', () => {
  const f = fixture();
  const todo = f.tasks.create({ conversationId: f.chat.id, title: 'Tea', assigneeKind: 'human', widget: { type: 'timer', duration: 'PT10M' }, createdBy: HUMAN_ID });
  f.tasks.changeWidget(todo.id, 'confirm');
  f.tasks.changeWidget(todo.id, 'timer');
  f.tasks.update(todo.id, { widget: { type: 'timer', duration: 'PT20M' } }, HUMAN_ID);
  assert.equal(f.timers(todo.id).length, 1);
});

test('the ring follows the timer: a new time or repeat moves it (and the due time it set), "Show as…" another widget drops it', () => {
  const f = fixture();
  const start = f.clock.now();
  const todo = f.tasks.create({ conversationId: f.chat.id, title: 'Tea', assigneeKind: 'human', widget: { type: 'timer', duration: 'PT10M' }, createdBy: HUMAN_ID });
  f.tasks.update(todo.id, { widget: { type: 'timer', duration: 'PT20M' } }, HUMAN_ID);
  assert.equal(f.timers(todo.id).length, 1);
  assert.deepEqual(f.timers(todo.id)[0].spec, { at: start + 20 * MIN }, 'it rings at the new time, not at +10 min');
  assert.equal(f.tasks.get(todo.id)?.dueAt, start + 20 * MIN, 'the due time the old timer set follows');

  f.tasks.update(todo.id, { dueAt: start + 60 * MIN }, HUMAN_ID);
  f.tasks.update(todo.id, { widget: { type: 'timer', duration: 'PT30M' } }, HUMAN_ID);
  assert.deepEqual(f.timers(todo.id)[0].spec, { at: start + 30 * MIN });
  assert.equal(f.tasks.get(todo.id)?.dueAt, start + 60 * MIN, 'a due time given explicitly stays');

  const ring = f.timers(todo.id)[0].id;
  f.tasks.update(todo.id, { widget: { ...f.tasks.get(todo.id)!.widget!, type: 'timer' } }, HUMAN_ID);
  assert.deepEqual(f.timers(todo.id).map((schedule) => [schedule.id, schedule.spec.at]), [[ring, start + 30 * MIN]], 'the same time leaves the ring alone');

  f.tasks.update(todo.id, { widget: { type: 'timer', at: new Date(start + 30 * MIN).toISOString(), repeat: 'daily' } }, HUMAN_ID);
  assert.equal(f.timers(todo.id).length, 1);
  assert.ok(f.timers(todo.id)[0].spec.cron, 'a repeat turns it into a repeating ring');

  f.tasks.changeWidget(todo.id, 'confirm');
  assert.equal(f.timers(todo.id).length, 0, 'no longer a timer: it never rings or pushes at the old time');
});

test('the host\'s approval card keeps its approvalId', () => {
  const f = fixture();
  const card = f.tasks.create({
    conversationId: f.chat.id, title: 'Pay 30 EUR', assigneeKind: 'human', humanReason: 'approval', createdBy: SYSTEM_ID,
    widget: { type: 'approve', action: 'Pay 30 EUR', approvalId: 'ap_1' },
  });
  assert.equal(f.tasks.get(card.id)?.widget?.approvalId, 'ap_1');
});
