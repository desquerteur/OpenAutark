// Tests for messages that reach running work (21.10. 17:09, agents/dispatch-boundary.ts,
// dispatcher.ts steer/urgent, chat/delivery.ts fold): an urgent interrupt waits for the turn's next
// tool boundary (a call in flight is never cut, a call waiting for an approval is no work), the
// person's own Stop does not wait, a turn that ends first is not cut at all; the interrupted work
// resumes exactly once after the urgent chat; the person's normal message is folded into the running
// turn of that chat when the engine can steer, else it waits for the next turn – never an interrupt.
// A deferred urgent interrupt leaves one quiet line and never undoes the person's Stop or the emergency
// stop (the stopped work does not come back); lines with files or speech are never steered (the next
// turn brings them in full; an important one interrupts at the boundary instead).
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { ToolBoundary } from '../../../src/runtime/agents/dispatch-boundary.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';
import { flush, openWakes, setup } from './fakes.ts';

function withTom() {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lea', 'Lea'));
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  return { h, a, b };
}

/** Records steered text on the running turn's engine (`ok` false: the engine refuses). */
function steerable(call: { request: { control: { engine?: Engine } } }, ok = true): string[] {
  const texts: string[] = [];
  call.request.control.engine = { steer: async (_runId: string, text: string) => { texts.push(text); return ok; } } as unknown as Engine;
  return texts;
}

test('ToolBoundary: defers until the last running call ends, once, cancellable', () => {
  const boundary = new ToolBoundary();
  let ran = 0;
  assert.equal(boundary.at(() => ran++), true, 'nothing in flight: at once');
  assert.equal(ran, 1);
  boundary.tool('c1', true);
  boundary.tool('c1', true); // a repeated start (dynamic tool: tool_start and callTool)
  boundary.tool('c2', true);
  assert.equal(boundary.at(() => ran++), false);
  assert.equal(boundary.deferred, true);
  boundary.tool('c1', false);
  assert.equal(ran, 1, 'c2 still runs');
  boundary.tool('unknown', false);
  assert.equal(ran, 1, 'an unknown end changes nothing');
  boundary.tool('c2', false);
  assert.equal(ran, 2, 'the last call ended: the boundary is reached');
  boundary.tool('c2', false);
  assert.equal(ran, 2, 'runs once');
  boundary.tool('c3', true);
  boundary.at(() => ran++);
  boundary.cancel();
  boundary.tool('c3', false);
  assert.equal(ran, 2, 'a cancelled interrupt (the turn ended) never runs');
  boundary.tool('', true);
  boundary.tool('', true);
  assert.equal(boundary.inFlight, 2, 'calls without an id count one by one');
  boundary.tool('', false);
  boundary.tool('', false);
  assert.equal(boundary.inFlight, 0);
});

test('urgent message elsewhere: a call in flight finishes first, then the turn is cut at the boundary; the cut work resumes exactly once', async () => {
  const { h, a, b } = withTom();
  h.chats.send({ conversationId: b.id, body: 'publish the release notes', authorId: 'human' });
  await flush();
  const running = h.executor.last();
  running.request.onTool?.('call_publish', true);
  h.clock.advance(1000);
  h.chats.send({ conversationId: a.id, body: 'Call me now', authorId: 'human', priority: 'important' });
  await flush();
  assert.equal(running.request.signal.aborted, false, 'the publish call is never cut mid-way');
  assert.equal(h.executor.calls.length, 1, 'no second turn while the first runs');
  running.request.onTool?.('call_publish', false);
  await flush();
  assert.equal(running.request.signal.aborted, true, 'cut at the boundary');
  assert.equal(running.request.control.stopKind, 'urgent');
  assert.equal(h.executor.last().request.conversationId, a.id, 'the urgent chat runs next');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.conversationId, b.id, 'the cut work resumes');
  h.executor.last().finish();
  await flush();
  assert.deepEqual(h.executor.calls.map((call) => call.request.conversationId), [b.id, a.id, b.id], 'exactly once each');
  assert.equal(openWakes(h.db).length, 0);
});

test('a turn that ends before its boundary is not cut afterwards: its wakes are done and the urgent chat runs next', async () => {
  const { h, a, b } = withTom();
  h.chats.send({ conversationId: b.id, body: 'build the site', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  call.request.onTool?.('call_build', true);
  h.chats.send({ conversationId: a.id, body: 'Quick question', authorId: 'human', priority: 'important' });
  await flush();
  assert.equal(call.request.signal.aborted, false);
  call.finish(); // done before the call reported its end (an engine that missed tool_end)
  await flush();
  call.request.onTool?.('call_build', false);
  assert.equal(call.request.signal.aborted, false, 'a finished turn is not cut afterwards');
  assert.equal(h.executor.last().request.conversationId, a.id);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 2, 'the finished work is not run again');
  assert.equal(openWakes(h.db).length, 0);
});

test("the person's own Stop (messages.stop, runs.cancel) aborts at once, also mid-call", async () => {
  const { h, b } = withTom();
  h.chats.send({ conversationId: b.id, body: 'one more', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  call.request.onTool?.('call_x', true);
  await h.dispatcher.interrupt('ag_tom', b.id);
  assert.equal(call.request.signal.aborted, true);
  assert.equal(call.request.control.stopKind, 'human');
});

test("the person's normal message reaches a running turn in its chat at the next step (steer) – no interrupt, no extra turn", async () => {
  const { h, a } = withTom();
  const first = h.chats.send({ conversationId: a.id, body: 'draft the offer', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  const texts = steerable(call);
  call.request.control.lastSeq = first.seq;
  const later = h.chats.send({ conversationId: a.id, body: 'add the discount too', authorId: 'human' });
  await flush();
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Lena: add the discount too$/m);
  assert.doesNotMatch(texts[0], /\(important\)/, 'a normal line stays normal');
  assert.equal(call.request.signal.aborted, false);
  assert.equal(call.request.control.steeredSeq, later.seq);
  h.chats.markRead(a.id, 'ag_tom', call.request.control.steeredSeq); // turn-finish advances the cursor
  call.finish();
  await flush();
  assert.equal(h.executor.calls.length, 1, 'the message was answered in the running turn');
  assert.equal(openWakes(h.db).length, 0);
});

test('a normal message without steering waits for the next turn; an agent\'s normal message is never folded; other chats are untouched', async () => {
  const { h, a, b } = withTom();
  h.chats.send({ conversationId: a.id, body: 'research the market', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  const refused = steerable(call, false);
  h.chats.send({ conversationId: a.id, body: 'also look at Austria', authorId: 'human' });
  await flush();
  assert.equal(refused.length, 1, 'tried once');
  assert.equal(call.request.signal.aborted, false, 'a normal message never interrupts');
  h.chats.send({ conversationId: b.id, body: 'unrelated', authorId: 'human' });
  await flush();
  assert.equal(refused.length, 1, 'a message in another chat waits for its own turn');
  assert.equal(call.request.signal.aborted, false);
  call.finish();
  await flush();
  const next = h.executor.last();
  assert.notEqual(next, call, 'the next turn reads the message');
  next.finish();
  await flush();
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 3);
  assert.equal(openWakes(h.db).length, 0);
  // An agent's normal message: no steer.
  const team = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], createdBy: 'human' });
  h.chats.send({ conversationId: team.id, body: '@Tom start', authorId: 'human', mentions: ['ag_tom'] });
  await flush();
  const teamCall = h.executor.last();
  const seen = steerable(teamCall);
  h.chats.send({ conversationId: team.id, body: 'FYI the file moved', authorId: 'ag_lea', authorKind: 'agent', mentions: ['ag_tom'] });
  await flush();
  assert.equal(seen.length, 0);
});

test('halt (the emergency stop): every running turn ends at once as the person\'s Stop, nothing starts until lifted, then what waited runs', async () => {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lea', 'Lea'));
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ agentIds: ['ag_lea'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'send the mails', authorId: 'human' });
  h.chats.send({ conversationId: b.id, body: 'book the flight', authorId: 'human' });
  await flush();
  const [tom, lea] = h.executor.calls;
  tom.request.onTool?.('call_send', true); // mid-call: the emergency stop does not wait
  h.dispatcher.setHalted(true);
  const halted = h.dispatcher.haltAll('All agent work was stopped by the person.');
  assert.deepEqual(halted.runIds.sort(), [tom.request.runId, lea.request.runId].sort());
  await halted.settled;
  assert.equal(tom.request.signal.aborted && lea.request.signal.aborted, true);
  assert.equal(tom.request.control.stopKind, 'human');
  h.chats.send({ conversationId: a.id, body: 'are you there?', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 2, 'no turn while halted');
  assert.equal(openWakes(h.db).length, 1, 'the message waits');
  h.dispatcher.setHalted(false);
  await flush();
  assert.equal(h.executor.calls.length, 3);
  assert.equal(h.executor.last().request.conversationId, a.id);
  h.executor.last().finish();
  await flush();
  assert.equal(openWakes(h.db).length, 0);
});

test('a task turn cut at its boundary by an urgent message resumes exactly once: its kept wake and the ownership follow-up run as one turn', async () => {
  const { h, a, b } = withTom();
  const task = h.tasks.create({ conversationId: b.id, title: 'Publish the release', assigneeId: 'ag_tom', createdBy: 'human' });
  await flush();
  const first = h.executor.last();
  assert.equal(first.request.taskId, task.id);
  // As turn-finish does when the engine stops: the ownership loop learns the outcome before the dispatcher settles.
  first.request.signal.addEventListener('abort', () => {
    h.ownership.afterTurn({ agentId: 'ag_tom', taskId: task.id, runId: first.request.runId, outcome: 'interrupted', progressed: true });
  }, { once: true });
  first.request.onTool?.('call_publish', true);
  h.chats.send({ conversationId: a.id, body: 'Call me now', authorId: 'human', priority: 'important' });
  await flush();
  assert.equal(first.request.signal.aborted, false, 'the publish call runs to its end');
  first.request.onTool?.('call_publish', false);
  await flush();
  assert.equal(first.request.signal.aborted, true);
  const urgent = h.executor.last();
  assert.equal(urgent.request.conversationId, a.id);
  h.clock.advance(5000); // the urgent chat takes a while: the follow-up is due as well
  urgent.finish();
  await flush();
  const resume = h.executor.last();
  assert.equal(resume.request.taskId, task.id, 'the task resumes');
  resume.finish();
  await flush();
  assert.equal(h.executor.calls.filter((call) => call.request.taskId === task.id).length, 2, 'cut once, resumed once');
  assert.deepEqual(openWakes(h.db), [], 'nothing left that would resume it a second time');
});

for (const how of ['emergency stop', 'runs.cancel'] as const) {
  test(`a deferred urgent interrupt never undoes the ${how}: the stopped work does not come back`, async () => {
    const { h, a, b } = withTom();
    h.chats.send({ conversationId: b.id, body: 'send the mails', authorId: 'human' });
    await flush();
    const running = h.executor.last();
    running.request.onTool?.('call_send', true);
    h.chats.send({ conversationId: a.id, body: 'Quick question', authorId: 'human', priority: 'important' });
    await flush();
    assert.equal(running.request.signal.aborted, false, 'the urgent interrupt waits for the boundary');
    const quiet = h.chats.messages(a.id, { limit: 50 }).filter((message) => message.kind === 'status');
    assert.deepEqual(quiet.map((message) => message.body), ['Tom reads the important message after the current step.'], 'one quiet line where the person waits');
    h.chats.send({ conversationId: a.id, body: 'And another thing', authorId: 'human', priority: 'important' });
    await flush();
    assert.equal(h.chats.messages(a.id, { limit: 50 }).filter((message) => message.kind === 'status').length, 1, 'once per deferral');
    let cancelled: Promise<boolean> | undefined;
    if (how === 'emergency stop') { h.dispatcher.setHalted(true); h.dispatcher.haltAll('All agent work was stopped by the person.'); }
    else cancelled = h.dispatcher.cancelRun(running.request.runId);
    running.request.onTool?.('call_send', false); // the cut call returns while the turn winds down
    await cancelled;
    await flush();
    assert.equal(running.request.control.stopKind, 'human', 'a stop, not an urgent hand-over: the task would pause');
    assert.ok(!openWakes(h.db).some((wake) => wake.conversation_id === b.id), 'the stopped chat keeps no wake that would run it again');
    if (how === 'emergency stop') h.dispatcher.setHalted(false);
    await flush();
    for (let i = 0; i < 3 && !h.executor.last().done; i++) { h.executor.last().finish(); await flush(); }
    assert.deepEqual(h.executor.calls.map((call) => call.request.conversationId === b.id ? 'b' : 'a'), ['b', 'a'], 'only the important chat runs after the stop');
    assert.deepEqual(openWakes(h.db), []);
  });
}

test("the person's Stop after an urgent cut makes it a stop: the cut work is not handed back", async () => {
  const { h, a, b } = withTom();
  h.chats.send({ conversationId: b.id, body: 'publish the post', authorId: 'human' });
  await flush();
  const running = h.executor.last();
  h.chats.send({ conversationId: a.id, body: 'Now please', authorId: 'human', priority: 'important' });
  assert.equal(running.request.signal.aborted, true, 'no call in flight: cut at once');
  assert.equal(running.request.control.stopKind, 'urgent');
  void h.dispatcher.cancelRun(running.request.runId); // the person stops it while it winds down
  await flush();
  assert.equal(running.request.control.stopKind, 'human');
  h.executor.last().finish();
  await flush();
  assert.deepEqual(h.executor.calls.map((call) => call.request.conversationId === b.id ? 'b' : 'a'), ['b', 'a']);
  assert.deepEqual(openWakes(h.db), []);
});

test('lines with files or speech are never steered: the next turn brings them in full; an important one interrupts at the boundary', async () => {
  const { h, a } = withTom();
  const first = h.chats.send({ conversationId: a.id, body: 'draft the flyer', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  const texts = steerable(call);
  call.request.control.lastSeq = first.seq;
  h.chats.send({ conversationId: a.id, body: 'use this photo', authorId: 'human', attachments: [{ fileId: 'file_abc', name: 'photo.png', mime: 'image/png', size: 1234 }] });
  h.chats.send({ conversationId: a.id, body: 'and make it bigger', authorId: 'human' });
  await flush();
  assert.deepEqual(texts, [], 'nothing steered past the photo (the later line waits behind it)');
  assert.equal(call.request.control.steeredSeq, first.seq, 'the cursor stays before the photo');
  assert.equal(call.request.signal.aborted, false, 'a normal message never interrupts');
  h.chats.markRead(a.id, 'ag_tom', Math.max(call.request.control.lastSeq, call.request.control.steeredSeq)); // as turn-finish does
  call.finish();
  await flush();
  const next = h.executor.last();
  assert.notEqual(next, call, 'the next turn reads the photo in full');
  const spoken = steerable(next);
  next.request.control.lastSeq = h.chats.messages(a.id, { limit: 50 }).at(-1)!.seq;
  h.chats.send({ conversationId: a.id, body: 'what about the colours', authorId: 'human', speech: { source: 'endpoint', live: true } });
  await flush();
  assert.deepEqual(spoken, [], 'a line said live gets an answer written after it (the voice conversation waits for that)');
  h.chats.send({ conversationId: a.id, body: 'Stop, see this', authorId: 'human', priority: 'important', attachments: [{ fileId: 'file_def', name: 'error.png', mime: 'image/png', size: 99 }] });
  await flush();
  assert.deepEqual(spoken, []);
  assert.equal(next.request.signal.aborted, true, 'important with a file: cut at the boundary (no call in flight) instead of a partial steer');
  assert.equal(next.request.control.stopKind, 'urgent');
});
