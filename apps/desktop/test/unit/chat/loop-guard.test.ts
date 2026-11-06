// Tests for the agent-to-agent loop and cost guard (src/runtime/chat/loop-guard.ts) and how
// delivery applies it in group chats: rate limit per chat and minute, ping-pong and (B-050 round 4) discussion detection,
// reset rules (human message, task progress), isolation per chat, and the hand-over to the
// lead. Owns: these assertions only. Never: real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard } from '../../../src/runtime/chat/loop-guard.ts';
import { agent, harness } from './harness.ts';

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);
const S = 1000;

test('rate: more than N agent messages per minute pause the chat; then "paused" until reset', () => {
  const guard = new LoopGuard({ maxPerMinute: 3, pingPongTurns: 100 });
  const verdicts = ['ag_a', 'ag_b', 'ag_c', 'ag_a', 'ag_b'].map((id, i) => guard.agentMessage('conv_1', id, T0 + i * S));
  assert.deepEqual(verdicts, ['ok', 'ok', 'ok', 'rate', 'paused']);
  assert.equal(guard.paused('conv_1'), true);
});

test('rate: the window slides – messages older than a minute no longer count', () => {
  const guard = new LoopGuard({ maxPerMinute: 3, pingPongTurns: 100 });
  for (let i = 0; i < 3; i++) assert.equal(guard.agentMessage('conv_1', 'ag_a', T0 + i * S), 'ok');
  assert.equal(guard.agentMessage('conv_1', 'ag_a', T0 + 60 * S), 'ok', 'the first one dropped out of the window');
  assert.equal(guard.agentMessage('conv_1', 'ag_a', T0 + 61 * S), 'ok');
  assert.equal(guard.agentMessage('conv_1', 'ag_a', T0 + 61.5 * S), 'rate');
});

test('ping-pong: two agents alternating N times pause the chat; pair() names them', () => {
  const guard = new LoopGuard({ maxPerMinute: 1000, pingPongTurns: 4 });
  const verdicts = ['ag_a', 'ag_b', 'ag_a', 'ag_b'].map((id, i) => guard.agentMessage('conv_1', id, T0 + i * 10 * S));
  assert.deepEqual(verdicts, ['ok', 'ok', 'ok', 'ping_pong']);
  assert.deepEqual(guard.pair('conv_1').sort(), ['ag_a', 'ag_b']);
  assert.deepEqual(guard.pair('conv_unknown'), []);
});

test('ping-pong: a third voice or one agent talking alone is not a ping-pong', () => {
  const guard = new LoopGuard({ maxPerMinute: 1000, pingPongTurns: 4 });
  for (const [i, id] of ['ag_a', 'ag_b', 'ag_c', 'ag_a', 'ag_b', 'ag_c', 'ag_a'].entries()) {
    assert.equal(guard.agentMessage('conv_1', id, T0 + i * S), 'ok');
  }
  for (let i = 0; i < 8; i++) assert.equal(guard.agentMessage('conv_2', 'ag_a', T0 + i * S), 'ok');
  assert.deepEqual(['ag_a', 'ag_a', 'ag_b', 'ag_a'].map((id, i) => guard.agentMessage('conv_3', id, T0 + i * S)), ['ok', 'ok', 'ok', 'ok'], 'A A B A does not alternate');
});

test('reset (human message / task progress) clears the pause and the ping-pong run', () => {
  const guard = new LoopGuard({ maxPerMinute: 1000, pingPongTurns: 4 });
  ['ag_a', 'ag_b', 'ag_a', 'ag_b'].forEach((id, i) => guard.agentMessage('conv_1', id, T0 + i * S));
  assert.equal(guard.paused('conv_1'), true);
  guard.reset('conv_1');
  assert.equal(guard.paused('conv_1'), false);
  assert.deepEqual(['ag_a', 'ag_b', 'ag_a'].map((id, i) => guard.agentMessage('conv_1', id, T0 + (10 + i) * S)), ['ok', 'ok', 'ok'], 'the run starts over');
  assert.doesNotThrow(() => guard.reset('conv_never_seen'));
});

test('reset after a rate pause starts a fresh window, so the next reply is not paused again (regression)', () => {
  const guard = new LoopGuard({ maxPerMinute: 3, pingPongTurns: 100 });
  for (let i = 0; i < 4; i++) guard.agentMessage('conv_1', 'ag_a', T0 + i * S);
  assert.equal(guard.paused('conv_1'), true);
  guard.reset('conv_1'); // the person writes "go on"
  assert.equal(guard.agentMessage('conv_1', 'ag_a', T0 + 5 * S), 'ok');
  assert.equal(guard.agentMessage('conv_1', 'ag_b', T0 + 6 * S), 'ok');
  assert.equal(guard.agentMessage('conv_1', 'ag_a', T0 + 7 * S), 'ok');
  assert.equal(guard.agentMessage('conv_1', 'ag_b', T0 + 8 * S), 'rate', 'the brake still holds for the new window');
});

test('reset without a rate pause keeps counting the minute (task lines are no way around the cost brake)', () => {
  const guard = new LoopGuard({ maxPerMinute: 3, pingPongTurns: 100 });
  guard.agentMessage('conv_1', 'ag_a', T0);
  guard.agentMessage('conv_1', 'ag_b', T0 + S);
  guard.reset('conv_1');
  guard.agentMessage('conv_1', 'ag_a', T0 + 2 * S);
  assert.equal(guard.agentMessage('conv_1', 'ag_b', T0 + 3 * S), 'rate');
});

test('every chat has its own counters', () => {
  const guard = new LoopGuard({ maxPerMinute: 2, pingPongTurns: 100 });
  guard.agentMessage('conv_1', 'ag_a', T0);
  guard.agentMessage('conv_1', 'ag_a', T0);
  assert.equal(guard.agentMessage('conv_1', 'ag_a', T0), 'rate');
  assert.equal(guard.agentMessage('conv_2', 'ag_a', T0), 'ok');
  assert.equal(guard.paused('conv_2'), false);
});

test('defaults: 20 agent messages per minute, 8 alternating turns, 12 changes of speaker', () => {
  const guard = new LoopGuard();
  // Round 4: two speakers taking turns out of step (a b b a b b …) are a discussion now – here one hand-over between them.
  for (let i = 0; i < 20; i++) assert.equal(guard.agentMessage('conv_1', i < 10 ? 'ag_a' : 'ag_b', T0 + i), 'ok');
  assert.equal(guard.agentMessage('conv_1', 'ag_c', T0 + 21), 'rate');
  const pingPong = new LoopGuard();
  const verdicts = Array.from({ length: 8 }, (_, i) => pingPong.agentMessage('conv_1', i % 2 ? 'ag_b' : 'ag_a', T0 + i * 10 * S));
  assert.deepEqual(verdicts, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ping_pong']);
  const talk = new LoopGuard();
  const outOfStep = Array.from({ length: 20 }, (_, i) => talk.agentMessage('conv_1', i % 3 === 0 ? 'ag_a' : 'ag_b', T0 + i));
  assert.equal(outOfStep.indexOf('ping_pong'), 18, 'the old rate input (a b b a b b …) now pauses at its twelfth change of speaker, before the rate limit');
});

test('round 4, discussion: twelve changes of speaker among agents pause the chat – three in a circle, two out of step; one agent alone never', () => {
  const guard = new LoopGuard({ maxPerMinute: 1000 });
  const circle = Array.from({ length: 13 }, (_, i) => guard.agentMessage('conv_1', ['ag_a', 'ag_b', 'ag_c'][i % 3], T0 + i * 10 * S));
  assert.deepEqual(circle, [...Array<string>(12).fill('ok'), 'ping_pong'], 'the 13th line is the 12th change of speaker');
  assert.deepEqual(guard.pair('conv_1').sort(), ['ag_a', 'ag_b', 'ag_c'], 'the voices of the discussion');
  const outOfStep = ['ag_a', 'ag_a', 'ag_b', 'ag_a', 'ag_b', 'ag_b'];
  const verdicts: string[] = [];
  for (let i = 0; i < 40 && !verdicts.includes('ping_pong'); i++) verdicts.push(guard.agentMessage('conv_2', outOfStep[i % 6], T0 + i * 10 * S));
  assert.equal(verdicts.at(-1), 'ping_pong', 'two agents that never strictly alternate are stopped too');
  assert.ok(verdicts.length <= 20, `within 20 lines (${verdicts.length})`);
  for (let i = 0; i < 40; i++) assert.equal(guard.agentMessage('conv_3', 'ag_a', T0 + i * 10 * S), 'ok', 'one agent talking alone');
  guard.reset('conv_1');
  assert.deepEqual(['ag_a', 'ag_b', 'ag_c'].map((id, i) => guard.agentMessage('conv_1', id, T0 + (200 + i) * S)), ['ok', 'ok', 'ok'], 'a person or task progress starts the count over');
  const off = new LoopGuard({ maxPerMinute: 1000, pingPongTurns: 1000, discussionTurns: Infinity });
  for (let i = 0; i < 40; i++) assert.equal(off.agentMessage('conv_1', ['ag_a', 'ag_b', 'ag_c'][i % 3], T0 + i * S), 'ok', 'Infinity: off (bridged people)');
});

// ----------------------------------------------------------------- applied by delivery

function group(maxPerMinute?: number) {
  const h = harness({ maxPerMinute });
  h.org.add(agent('ag_mara', 'Mara', { mode: 'manager' }));
  h.org.add(agent('ag_tom', 'Tom', { managerId: 'ag_mara' }));
  h.org.add(agent('ag_lea', 'Lea', { managerId: 'ag_mara' }));
  const chat = h.chats.create({ title: 'Launch', agentIds: ['ag_mara', 'ag_tom', 'ag_lea'], createdBy: 'human' });
  const say = (from: string, to: string) => {
    h.wakes.cancel(to);
    h.clock.advance(5 * S);
    h.chats.send({ conversationId: chat.id, body: `@${h.org.get(to)!.name} next`, authorId: from });
    return h.wakes.pending(to) > 0;
  };
  const notes = () => h.chats.messages(chat.id).filter(m => m.kind === 'status' && m.meta.status?.details?.guard).map(m => m.body);
  return { ...h, chat, say, notes };
}

test('delivery: ping-pong between two agents stops waking them and hands over to the lead once', () => {
  const g = group();
  const woken: boolean[] = [];
  for (let i = 0; i < 10; i++) woken.push(i % 2 ? g.say('ag_lea', 'ag_tom') : g.say('ag_tom', 'ag_lea'));
  assert.deepEqual(woken, [true, true, true, true, true, true, true, false, false, false]);
  assert.deepEqual(g.notes(), ['Agent replies paused: back-and-forth without progress'], 'one status line, not one per message');
  const review = g.wakeRows().filter(w => w.agent_id === 'ag_mara' && w.reason === 'review');
  assert.equal(review.length, 1, 'the lead (manager) is asked to sort it out');
});

test('delivery: a human message lifts the pause; a task change breaks the ping-pong too', () => {
  const g = group();
  for (let i = 0; i < 8; i++) (i % 2 ? g.say('ag_lea', 'ag_tom') : g.say('ag_tom', 'ag_lea'));
  assert.equal(g.say('ag_tom', 'ag_lea'), false);
  g.chats.send({ conversationId: g.chat.id, body: '@Tom please go on', authorId: 'human' });
  assert.equal(g.say('ag_tom', 'ag_lea'), true);
  for (let i = 0; i < 7; i++) (i % 2 ? g.say('ag_tom', 'ag_lea') : g.say('ag_lea', 'ag_tom'));
  assert.equal(g.say('ag_lea', 'ag_tom'), false, 'paused again after another 8 alternations');
  const task = g.tasks.create({ conversationId: g.chat.id, title: 'Draft the script', assigneeId: 'ag_tom', createdBy: 'human' });
  g.tasks.claim(task.id, 'ag_tom'); // a task_* status line = real progress
  assert.equal(g.say('ag_tom', 'ag_lea'), true);
});

test('B-076, delivery: the person\'s click on an ask block (their answer line) lifts the pause like a typed line', () => {
  const g = group();
  for (let i = 0; i < 8; i++) (i % 2 ? g.say('ag_lea', 'ag_tom') : g.say('ag_tom', 'ag_lea'));
  assert.equal(g.say('ag_tom', 'ag_lea'), false);
  g.chats.send({ conversationId: g.chat.id, body: 'Option B', kind: 'answer', authorId: 'human', authorKind: 'human' });
  assert.equal(g.say('ag_tom', 'ag_lea'), true);
});

test('delivery: after a rate pause, a human message lets agents answer each other again (regression)', () => {
  const g = group(4);
  const woken = Array.from({ length: 6 }, (_, i) => g.say(i % 3 === 0 ? 'ag_tom' : i % 3 === 1 ? 'ag_lea' : 'ag_mara', i % 3 === 0 ? 'ag_lea' : i % 3 === 1 ? 'ag_mara' : 'ag_tom'));
  assert.deepEqual(woken, [true, true, true, true, false, false]);
  assert.deepEqual(g.notes(), ['Agent replies paused: message rate limit']);
  g.chats.send({ conversationId: g.chat.id, body: 'Carry on, all of you', authorId: 'human' });
  assert.equal(g.say('ag_tom', 'ag_lea'), true);
  assert.deepEqual(g.notes(), ['Agent replies paused: message rate limit'], 'no second pause line right after the person spoke');
});

test('round 4, delivery: three agents passing the word in a circle stop waking each other after twelve changes of speaker; the lead took part – no review', () => {
  const g = group();
  const order = ['ag_tom', 'ag_lea', 'ag_mara'];
  const woken = Array.from({ length: 14 }, (_, i) => g.say(order[i % 3], order[(i + 1) % 3]));
  assert.deepEqual(woken, [...Array<boolean>(12).fill(true), false, false], 'before, only the rate limit could stop a slow circle');
  assert.deepEqual(g.notes(), ['Agent replies paused: back-and-forth without progress']);
  assert.equal(g.wakeRows().filter((w) => w.reason === 'review').length, 0, 'the lead (Mara) was one of the voices');
  g.chats.send({ conversationId: g.chat.id, body: '@Tom wrap it up please', authorId: 'human' });
  assert.equal(g.say('ag_tom', 'ag_lea'), true, 'the person lifts it');
});
