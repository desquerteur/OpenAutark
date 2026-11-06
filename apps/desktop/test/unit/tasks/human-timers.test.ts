// Snooze, finished timers and repeating reminders (F03) on a manual clock with fake timers:
// a snoozed to-do waits under "Later" (F04: listed as waiting, not counted as due now), comes back
// after 10 minutes with a push, without a receipt or a wake; a reminder ticked off early never pushes; a daily timer cycles – Done posts a
// receipt and waits for the next ring, due then, its author hears only the first Done – and "Stop
// repeating" ends it; an older widget's {event:'snoozed'} answer snoozes too; a timer block
// posted again with its id rings (and is due) at the new time even after it rang, and Snooze or
// an answer on the newer message reaches the same to-do; a pending snooze is never
// taken for the widget's ring; an ask block sent with chat.send is a to-do (Snooze works), one
// with "todo": false is not (no Snooze offered); a To-do-only phone link may snooze.
// Owns: these assertions only. Never: real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { countNow, isLater } from '../../../src/shared/model/todo-later.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { canSnooze } from '../../../src/ui/blocks/snooze.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { sessionInfo } from '../../../src/runtime/rpc/handlers/session.ts';
import { agent, harness } from '../chat/harness.ts';

const M = 60_000;
const H = 60 * M;

function setup() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  h.scheduler.start();
  const timer = (widget: Record<string, unknown>, title = 'Take the bread out') => h.tasks.create({
    conversationId: chat.id, title, assigneeKind: 'human', humanReason: 'physical', createdBy: 'ag_ava', widget: { type: 'timer', label: title, ...widget },
  });
  const at = (ms: number) => { h.clock.set(ms); if (h.timers.pending.length) h.timers.fire(); };
  /** Pushes for the ring of a to-do (not the 'new to-do' notice). */
  const rings = (title: string) => h.notified.filter((note) => note.kind === 'todo' && note.title === title).length;
  const listed = (id: string) => h.tasks.todos().some((todo) => todo.id === id);
  /** B-076: an answer in the chat wakes the author as the person's typed line does ('message'). */
  const answerWakes = () => h.wakes.list('ag_ava').filter((wake) => wake.reason === 'message' || wake.reason === 'answer');
  const receipts = () => h.chats.messages(chat.id).filter((message) => message.kind === 'answer');
  return { ...h, chat, timer, at, listed, answerWakes, receipts, rings };
}

test('snooze: the to-do waits, comes back after 10 minutes with a push – no receipt, nobody woken', () => {
  const h = setup();
  const start = h.clock.now();
  const todo = h.timer({ duration: 'PT5M' });
  h.at(start + 5 * M + 1000);
  assert.equal(h.tasks.get(todo.id)?.status, 'needs_you', 'it rang');
  const first = h.rings('Take the bread out');
  assert.ok(first >= 1, 'it pushed');

  const snoozed = h.tasks.snooze(todo.id, h.clock.now() + 10 * M);
  assert.equal(snoozed.status, 'waiting');
  assert.equal(snoozed.waitingOn?.reason, 'Snoozed');
  assert.equal(snoozed.waitingOn?.until, h.clock.now() + 10 * M, 'the snooze records when it ends');
  const waiting = h.tasks.todos().find((entry) => entry.id === todo.id);
  assert.equal(waiting?.status, 'waiting', 'listed under Later while snoozed (F04)');
  assert.equal(isLater(waiting!, h.clock.now()), true);
  assert.equal(countNow(h.tasks.todos(), h.clock.now()), 0, 'not counted as due now');
  assert.equal(h.receipts().length, 0, 'no receipt');
  assert.equal(h.answerWakes().length, 0, 'the agent is not woken');

  h.at(h.clock.now() + 10 * M + 1000);
  assert.equal(h.tasks.get(todo.id)?.status, 'needs_you', 'back after 10 minutes');
  assert.equal(h.listed(todo.id), true);
  assert.equal(countNow(h.tasks.todos(), h.clock.now()), 1, 'due now again');
  assert.equal(h.rings('Take the bread out'), first + 1, 'it pushes again');
});

test('an older widget\'s snooze answer snoozes instead of finishing', () => {
  const h = setup();
  const todo = h.timer({ duration: 'PT5M' });
  h.tasks.answer({ taskId: todo.id, answer: { event: 'snoozed' }, by: HUMAN_ID });
  assert.equal(h.tasks.get(todo.id)?.status, 'waiting');
  assert.equal(h.receipts().length, 0);
  assert.equal(h.answerWakes().length, 0);
  const rings = h.scheduler.list({ taskId: todo.id }).filter((schedule) => schedule.kind === 'timer');
  assert.equal(rings.length, 1, 'the old ring was replaced');
  assert.deepEqual(rings[0].spec, { at: h.clock.now() + 10 * M });
});

test('done early: the reminder never pushes; cancelled: it never rings', () => {
  const h = setup();
  const start = h.clock.now();
  const early = h.timer({ duration: 'PT30M' });
  h.tasks.answer({ taskId: early.id, answer: { event: 'done' }, by: HUMAN_ID });
  assert.equal(h.tasks.get(early.id)?.status, 'done');
  assert.equal(h.scheduler.list({ taskId: early.id }).length, 0, 'the one-shot ring is gone');
  const cancelled = h.timer({ duration: 'PT20M' }, 'Water the plants');
  const before = h.rings('Take the bread out') + h.rings('Water the plants');
  h.tasks.setStatus(cancelled.id, 'cancelled', HUMAN_ID);
  h.at(start + 31 * M);
  assert.equal(h.rings('Take the bread out') + h.rings('Water the plants'), before, 'no push for finished to-dos');
});

test('a daily timer cycles: Done waits for the next ring, the author hears only the first; Stop repeating ends it', () => {
  const h = setup();
  const nine = new Date(h.clock.now());
  nine.setHours(9, 0, 0, 0);
  if (nine.getTime() <= h.clock.now()) nine.setDate(nine.getDate() + 1);
  const todo = h.timer({ at: nine.toISOString(), repeat: 'daily' }, 'Take the pills');
  assert.ok(h.scheduler.list({ taskId: todo.id }).some((schedule) => 'cron' in schedule.spec), 'a repeating ring');

  h.at(nine.getTime() + 1000);
  assert.equal(h.tasks.get(todo.id)?.status, 'needs_you');
  assert.equal(h.tasks.get(todo.id)?.dueAt, nine.getTime());
  h.tasks.answer({ taskId: todo.id, answer: { event: 'done' }, by: HUMAN_ID });
  let current = h.tasks.get(todo.id)!;
  assert.equal(current.status, 'waiting', 'not done: it comes back tomorrow');
  assert.equal(current.ledger.doneCount, 1);
  assert.equal(current.dueAt, nine.getTime() + 24 * H, 'due at its next ring, not "overdue · yesterday" then');
  assert.equal(current.widget?.at, new Date(nine.getTime() + 24 * H).toISOString(), 'the timer shows the next ring');
  const ringIds = h.scheduler.list({ taskId: todo.id }).map((schedule) => schedule.id);
  assert.equal(h.receipts().length, 1, 'a receipt for today');
  assert.equal(h.answerWakes().length, 1, 'the author hears the first Done');
  h.wakes.done(h.wakes.claim('ag_ava', Number.MAX_SAFE_INTEGER).map((wake) => wake.id));

  h.at(nine.getTime() + 24 * H + 1000);
  assert.equal(h.tasks.get(todo.id)?.status, 'needs_you', 'it rings again the next day');
  assert.ok(h.tasks.get(todo.id)!.dueAt! > h.clock.now() - M, 'due just now, not a day ago');
  assert.deepEqual(h.scheduler.list({ taskId: todo.id }).map((schedule) => schedule.id), ringIds, 'the moved time keeps the one daily ring');
  h.tasks.answer({ taskId: todo.id, answer: { event: 'done' }, by: HUMAN_ID });
  current = h.tasks.get(todo.id)!;
  assert.equal(current.status, 'waiting');
  assert.equal(current.dueAt, nine.getTime() + 48 * H);
  assert.equal(h.receipts().length, 2, 'each day has its receipt');
  assert.equal(h.answerWakes().length, 0, 'later Done do not wake the author');

  const stopped = h.tasks.stopRepeating(todo.id, HUMAN_ID);
  assert.equal(stopped.status, 'done');
  assert.equal(h.scheduler.list({ taskId: todo.id }).filter((schedule) => schedule.active).length, 0, 'no more rings');
  const pushes = h.rings('Take the pills');
  h.at(nine.getTime() + 48 * H + 1000);
  assert.equal(h.rings('Take the pills'), pushes, 'nothing rings after Stop repeating');
});

test('a timer block posted again with its id for a new time rings then – also after the first ring', () => {
  const h = setup();
  const start = h.clock.now();
  const post = (at: number) => {
    const body = '```ui\n' + JSON.stringify({ type: 'timer', id: 'stretch', label: 'Stretch', at: new Date(at).toISOString() }) + '\n```';
    const message = h.chats.send({ conversationId: h.chat.id, body, authorId: 'ag_ava', authorKind: 'agent' });
    return h.tasks.ingestBlocks(message, uiBlocksOf(body).map((entry) => entry.block))[0];
  };
  const todo = post(start + H);
  h.at(start + H + 1000);
  assert.equal(h.tasks.get(todo.id)?.status, 'needs_you', 'it rang');
  const rang = h.rings('Stretch');

  assert.equal(post(start + 5 * H).id, todo.id, 'the same to-do');
  const rings = h.scheduler.list({ taskId: todo.id }).filter((schedule) => schedule.kind === 'timer');
  assert.equal(rings.length, 1, 'still one ring');
  assert.deepEqual([rings[0].spec, rings[0].active], [{ at: start + 5 * H }, true], 'moved to the new time and armed again');
  assert.equal(h.tasks.get(todo.id)?.dueAt, start + 5 * H, 'the due time the old timer set follows (not due/overdue at the old time)');
  h.at(start + 5 * H + 1000);
  assert.equal(h.rings('Stretch'), rang + 1, 'it rings at the new time');
});

test('a block posted again with its id: snooze and answers of the newer message reach the same to-do', () => {
  const h = setup();
  const start = h.clock.now();
  const post = (at: number) => {
    const body = 'Again:\n```ui\n' + JSON.stringify({ type: 'timer', id: 'tea', label: 'Tea', at: new Date(at).toISOString() }) + '\n```';
    const message = h.chats.send({ conversationId: h.chat.id, body, authorId: 'ag_ava', authorKind: 'agent' });
    const blocks = uiBlocksOf(body);
    return { message, todo: h.tasks.ingestBlocks(message, blocks.map((entry) => entry.block), blocks.map((entry) => entry.index))[0] };
  };
  const first = post(start + H);
  const second = post(start + 2 * H);
  assert.equal(second.todo.id, first.todo.id);
  const ref = { messageId: second.message.id, blockIndex: 0 };
  assert.equal(h.tasks.snooze(ref, h.clock.now() + 10 * M).id, first.todo.id, 'Snooze on the newer block finds the to-do');
  h.tasks.answer({ ...ref, answer: { event: 'done' }, by: HUMAN_ID });
  assert.equal(h.tasks.get(first.todo.id)?.status, 'done', 'answering the newer block finishes the to-do');
  assert.equal(h.receipts().length, 1);
  h.tasks.answer({ ...ref, answer: { event: 'done' }, by: HUMAN_ID });
  assert.equal(h.receipts().length, 1, 'answering it again is a double answer: no second receipt');
  assert.equal(h.answerWakes().length, 1, 'and no second wake');
});

test('a pending snooze is not the widget\'s ring: a new timer time while snoozed rings too', () => {
  const h = setup();
  const start = h.clock.now();
  const todo = h.timer({ duration: 'PT5M' });
  h.at(start + 5 * M + 1000);
  const snoozeAt = h.clock.now() + 10 * M;
  h.tasks.snooze(todo.id, snoozeAt);
  h.tasks.update(todo.id, { widget: { type: 'timer', label: 'Take the bread out', at: new Date(start + 2 * H).toISOString() } }, HUMAN_ID);
  const specs = h.scheduler.list({ taskId: todo.id }).filter((schedule) => schedule.kind === 'timer').map((schedule) => schedule.spec.at);
  assert.deepEqual(specs.sort((a, b) => a! - b!), [snoozeAt, start + 2 * H], 'the snooze stays, the widget gets its own ring');
});

test('an ask block an agent posts with chat.send is a to-do, so Snooze works on it; "todo": false stays in the chat only', async () => {
  const h = setup();
  const send = chatTools.find((tool) => tool.name === 'chat.send')!;
  const ctx = {
    agent: h.org.get('ag_ava')!, runId: 'run_send', conversationId: h.chat.id, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  } as ToolContext;
  const body = '```ui\n{"type":"timer","duration":"PT10M","label":"Bread"}\n```\n```ui\n{"type":"timer","duration":"PT10M","label":"Tea","todo":false}\n```';
  const out = await send.run({ text: body }, ctx);
  const { messageId } = JSON.parse((out.content[0] as { text: string }).text) as { messageId: string };
  const [todo, inline] = uiBlocksOf(body);
  const snoozed = h.tasks.snooze({ messageId, blockIndex: todo.index }, h.clock.now() + 10 * M);
  assert.equal(snoozed.status, 'waiting', 'the block\'s to-do snoozes');
  assert.equal(snoozed.title, 'Bread');
  assert.throws(() => h.tasks.snooze({ messageId, blockIndex: inline.index }, h.clock.now() + 10 * M), /To-do not found/);
  assert.equal(canSnooze(inline.block, { kind: 'block', messageId, blockIndex: inline.index }), false, 'so the chat does not offer Snooze there');
});

test('a To-do-only phone link may snooze and stop repeating', () => {
  const info = sessionInfo(createHandlerTable(), { kind: 'device', deviceId: 'dv_phone', capabilities: ['todo'], secure: false });
  assert.ok(info.allowedMethods.includes('todos.snooze'));
  assert.ok(info.allowedMethods.includes('todos.stopRepeating'));
});
