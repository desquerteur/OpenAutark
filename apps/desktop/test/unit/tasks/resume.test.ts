// Tests that work waiting on someone continues at once (T03, tasks/transitions.ts): (a) the last
// human step of a task that needs the person is answered, done or cancelled → working, no wait,
// 'Continuing: …', owner woken; (b) a child named in waitingOn is done, blocked or cancelled →
// the owner gets a 'child' wake with the return checkpoint, and with several children the task
// resumes after the last; (c) the person writing in a chat where the agent has exactly one task
// waiting on them wakes it for that task; (d) the human reopening agent work wakes the owner
// with a note and a ledger fact; paused work stays paused.
// Owns: these assertions only. Never: real timers, engines or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence, Task } from '../../../src/shared/model/tasks.ts';
import { agent } from '../chat/harness.ts';
import { ownershipFixture } from './ownership-fixture.ts';
import { setup as turnSetup } from '../agents/fixture.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { HUMAN_WROTE_NOTE } from '../../../src/runtime/tasks/transitions.ts';
import { isPaused } from '../../../src/runtime/tasks/owners.ts';

type Fixture = ReturnType<typeof ownershipFixture>;

/** Unclaimed wakes of an agent for a task. */
const wakesOn = (f: Pick<Fixture, 'wakes'>, agentId: string, taskId: string) =>
  f.wakes.list(agentId).filter(w => w.claimedAt === undefined && w.taskId === taskId);
/** Clears an agent's wakes (as if the dispatcher ran them). */
const drain = (f: Pick<Fixture, 'wakes'>, agentId = 'ag_tom') => f.wakes.done(f.wakes.claim(agentId, Number.MAX_SAFE_INTEGER).map(w => w.id));

/** Tom's task waits on a delegated child (as agents.delegate does it, T13). */
function waitOn(f: Fixture, child: Pick<Task, 'id' | 'title'>, who: string): void {
  f.tasks.update(f.task.id, { status: 'waiting', waitingOn: { kind: 'task', id: child.id, reason: `Waiting for ${who}: ${child.title}`, since: f.clock.now() } }, 'ag_tom');
}

function delegationFixture() {
  const f = ownershipFixture();
  f.org.add(agent('ag_lea', 'Lea', { managerId: 'ag_mara' }));
  f.org.add(agent('ag_ben', 'Ben', { managerId: 'ag_mara' }));
  const child = (title: string, assigneeId: string) => f.tasks.create({ conversationId: f.chat.id, parentId: f.task.id, title, assigneeId, createdBy: 'ag_tom' });
  return { ...f, child };
}

test('(a) several human steps: the task continues only after the last one is done or cancelled', () => {
  const f = ownershipFixture();
  const ask = (title: string) => f.tasks.create({
    conversationId: f.chat.id, parentId: f.task.id, title, assigneeKind: 'human', humanReason: 'taste', createdBy: 'ag_tom',
    widget: { type: 'confirm', instructions: title },
  });
  const logo = ask('Which logo?');
  const date = ask('Which date?');
  f.tasks.setStatus(f.task.id, 'needs_you', 'ag_tom', 'Needs your input');
  drain(f);
  f.tasks.setStatus(logo.id, 'done', 'human');
  assert.equal(f.current().status, 'needs_you', 'one step is still open');
  assert.ok(!f.lines().includes('Continuing: Cut the launch video'));
  f.tasks.setStatus(date.id, 'cancelled', 'human', 'Any date is fine');
  assert.equal(f.current().status, 'working');
  assert.equal(f.current().waitingOn, undefined);
  assert.equal(wakesOn(f, 'ag_tom', f.task.id).filter(w => w.reason === 'task').length, 1, 'one merged wake for the owner');
});

test('(a) a human step of work that waits on something else, or of finished work, changes nothing', () => {
  const f = delegationFixture();
  const music = f.child('Find the music', 'ag_lea');
  waitOn(f, music, 'Lea');
  const ask = f.tasks.create({
    conversationId: f.chat.id, parentId: f.task.id, title: 'Which mood?', assigneeKind: 'human', humanReason: 'taste', createdBy: 'ag_tom',
    widget: { type: 'confirm', instructions: 'Calm?' },
  });
  f.tasks.answer({ taskId: ask.id, answer: true, by: 'human' });
  assert.equal(f.current().status, 'waiting', 'still waiting on the child');
  assert.equal(f.current().waitingOn?.id, music.id);
});

test('(b) a delegated child is done: the owner gets the result back (reason child, evidence capped at 8) and the task resumes', () => {
  const f = delegationFixture();
  const music = f.child('Find the music', 'ag_lea');
  waitOn(f, music, 'Lea');
  assert.equal(f.current().status, 'waiting');
  drain(f);
  const evidence: Evidence[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'file', label: `track-${i + 1}.mp3`, ref: `music/track-${i + 1}.mp3` }));
  f.tasks.complete(music.id, { summary: 'Picked three calm tracks', evidence, verification: 'claimed_by_agent' }, 'ag_lea');

  const task = f.current();
  assert.equal(task.status, 'working');
  assert.equal(task.waitingOn, undefined);
  assert.ok(f.lines().includes('Continuing: Cut the launch video'));
  assert.ok(task.ledger.facts?.includes('Delegated work done: Find the music – Picked three calm tracks'));
  const [wake] = wakesOn(f, 'ag_tom', f.task.id);
  assert.equal(wake.reason, 'child');
  assert.ok(wake.dueAt <= f.clock.now());
  assert.match(wake.note!, /^Lea finished "Find the music" \(claimed, not checked yet\)\./);
  assert.match(wake.note!, /Result: Picked three calm tracks/);
  assert.match(wake.note!, /- track-8\.mp3: music\/track-8\.mp3/);
  assert.doesNotMatch(wake.note!, /track-9/, 'at most 8 evidence refs');
  assert.match(wake.note!, /continue the task/);
});

test('(b) several children: each result is delivered, the task resumes after the last; a blocked child reports its blocker', () => {
  const f = delegationFixture();
  const music = f.child('Find the music', 'ag_lea');
  const cover = f.child('Draw the cover', 'ag_ben');
  waitOn(f, music, 'Lea');
  waitOn(f, cover, 'Ben'); // a second delegation keeps the first child
  assert.deepEqual(f.current().waitingOn?.ids, [music.id, cover.id]);
  drain(f);

  f.tasks.complete(music.id, { summary: 'Picked a track', evidence: [{ kind: 'note', label: 'track 2' }], verification: 'claimed_by_agent' }, 'ag_lea');
  let task = f.current();
  assert.equal(task.status, 'waiting', 'the cover is still open');
  assert.equal(task.waitingOn?.id, cover.id);
  assert.equal(task.waitingOn?.ids, undefined);
  assert.ok(!f.lines().includes('Continuing: Cut the launch video'));
  const first = wakesOn(f, 'ag_tom', f.task.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].reason, 'child');
  assert.match(first[0].note!, /Still waiting for 1 more delegated task: "Draw the cover"\./);

  f.tasks.setStatus(cover.id, 'blocked', 'ag_ben', 'No license for the font');
  task = f.current();
  assert.equal(task.status, 'working');
  assert.equal(task.waitingOn, undefined);
  const blocked = wakesOn(f, 'ag_tom', f.task.id).find(w => w.note?.includes('Ben is blocked'))!;
  assert.equal(blocked.reason, 'child');
  assert.match(blocked.note!, /Ben is blocked on "Draw the cover": No license for the font/);
  assert.ok(task.ledger.facts?.includes('Delegated work blocked: Draw the cover – No license for the font'));
});

test('(b) a cancelled or removed child also ends the wait; checklist steps wake nobody, a child not waited on tells its delegator', () => {
  const f = delegationFixture();
  const steps = f.tasks.create({ conversationId: f.chat.id, title: 'Edit the trailer', assigneeId: 'ag_tom', createdBy: 'ag_mara', steps: ['Rough cut', 'Color'] });
  f.tasks.claim(steps.id, 'ag_tom');
  drain(f);
  f.tasks.complete(steps.steps[0].id, { summary: 'Rough cut ready', evidence: [{ kind: 'file', label: 'rough.mp4', ref: 'rough.mp4' }], verification: 'claimed_by_agent' }, 'ag_tom');
  assert.deepEqual(f.wakes.list('ag_tom').filter(w => w.reason === 'child'), [], 'no wake for a checklist step');
  assert.deepEqual(f.wakes.list('ag_mara').filter(w => w.reason === 'child'), []);

  const extra = f.child('Check the subtitles', 'ag_lea');
  f.tasks.complete(extra.id, { summary: 'Fine', evidence: [{ kind: 'note', label: 'ok' }], verification: 'claimed_by_agent' }, 'ag_lea');
  assert.equal(f.current().status, 'working');
  assert.match(wakesOn(f, 'ag_tom', f.task.id).find(w => w.reason === 'child')?.note ?? '', /Delegated work "Check the subtitles" is done: Fine/, 'the task did not wait on it: its delegator hears once');
  drain(f);

  const music = f.child('Find the music', 'ag_lea');
  waitOn(f, music, 'Lea');
  f.tasks.setStatus(music.id, 'cancelled', 'human', 'We use the old track');
  assert.equal(f.current().status, 'working');
  assert.match(wakesOn(f, 'ag_tom', f.task.id).find(w => w.reason === 'child')!.note!, /"Find the music" \(Lea\) was cancelled: We use the old track/);

  drain(f);
  const cover = f.child('Draw the cover', 'ag_ben');
  waitOn(f, cover, 'Ben');
  f.tasks.remove(cover.id, 'ag_tom');
  assert.equal(f.current().status, 'working', 'a removed child holds nothing');
});

test('(b) paused work stays paused when a child it waited on finishes', () => {
  const f = delegationFixture();
  const music = f.child('Find the music', 'ag_lea');
  waitOn(f, music, 'Lea');
  f.tasks.pause(f.task.id, 'human');
  drain(f);
  f.tasks.complete(music.id, { summary: 'Picked a track', evidence: [{ kind: 'note', label: 'track' }], verification: 'claimed_by_agent' }, 'ag_lea');
  assert.ok(isPaused(f.current()));
  assert.deepEqual(wakesOn(f, 'ag_tom', f.task.id), []);
});

test('(c) the person writing in a chat where the agent has exactly one task waiting on them wakes it for that task', async () => {
  const h = turnSetup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Finish the sign-up', assigneeId: h.tom.id, createdBy: 'human' });
  h.tasks.claim(task.id, h.tom.id);
  h.tasks.setStatus(task.id, 'needs_you', h.tom.id, 'Log in with your account');
  h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map(w => w.id));

  h.chats.send({ conversationId: h.chat.id, body: 'I finished the login', authorId: 'human' });
  const [wake] = h.wakes.list(h.tom.id);
  assert.equal(wake.reason, 'message');
  assert.equal(wake.taskId, task.id);
  assert.equal(wake.note, HUMAN_WROTE_NOTE);
  const plan = await planTurn(h.services, h.request({ reason: 'message', taskId: wake.taskId, notes: [{ text: wake.note!, at: wake.createdAt }] }));
  assert.equal(plan?.task?.id, task.id, 'the turn is a turn on the waiting task');

  // Two tasks waiting on the person: the message belongs to neither.
  h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map(w => w.id));
  const second = h.tasks.create({ conversationId: h.chat.id, title: 'Scan the passport', assigneeId: h.tom.id, createdBy: 'human' });
  h.tasks.claim(second.id, h.tom.id);
  h.tasks.setStatus(second.id, 'needs_you', h.tom.id, 'Scan it');
  h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map(w => w.id));
  h.chats.send({ conversationId: h.chat.id, body: 'Done with one of them', authorId: 'human' });
  assert.deepEqual(h.wakes.list(h.tom.id).map(w => [w.reason, w.taskId, w.note]), [['message', undefined, undefined]]);
});

test('(c) a working task, or a message of another agent, is not attached to a task', () => {
  const f = ownershipFixture();
  drain(f);
  f.chats.send({ conversationId: f.chat.id, body: 'How is it going, @Tom?', authorId: 'human', mentions: ['ag_tom'] });
  assert.equal(f.wakes.list('ag_tom').find(w => w.reason === 'message')?.taskId, undefined, 'working, not waiting on the person');
  drain(f);
  f.tasks.setStatus(f.task.id, 'needs_you', 'ag_tom', 'Needs your input');
  drain(f);
  f.chats.send({ conversationId: f.chat.id, body: 'Tom, the logo is ready', authorId: 'ag_mara', authorKind: 'agent', mentions: ['ag_tom'] });
  assert.equal(f.wakes.list('ag_tom').find(w => w.reason === 'message')?.taskId, undefined, 'an agent message is not the person');
});

test('(d) the human reopening agent work wakes the owner with the note and records a ledger fact', () => {
  const f = ownershipFixture();
  f.tasks.complete(f.task.id, { summary: 'Cut', evidence: [{ kind: 'file', label: 'cut.mp4', ref: 'cut.mp4' }], verification: 'claimed_by_agent' }, 'ag_tom');
  drain(f);
  f.tasks.setStatus(f.task.id, 'open', 'human', 'Add the outro');
  assert.deepEqual(wakesOn(f, 'ag_tom', f.task.id).map(w => [w.reason, w.note]), [['task', 'The human reopened this task: Add the outro']]);
  assert.ok(f.current().ledger.facts?.includes('Reopened by the human: Add the outro'));

  // Blocked work the person moves back on is a reopen too.
  f.tasks.setStatus(f.task.id, 'blocked', 'ag_tom', 'No result after 12 attempts');
  drain(f);
  f.tasks.setStatus(f.task.id, 'working', 'human');
  assert.deepEqual(wakesOn(f, 'ag_tom', f.task.id).map(w => [w.reason, w.note]), [['task', 'The human reopened this task.']]);
  assert.equal(f.current().ledger.facts?.filter(fact => fact.startsWith('Reopened by the human')).length, 2);

  // A reviewing manager reopening finished work wakes the owner; it is no human fact.
  f.tasks.complete(f.task.id, { summary: 'Cut again', evidence: [{ kind: 'note', label: 'outro added' }], verification: 'claimed_by_agent' }, 'ag_tom');
  drain(f);
  f.tasks.setStatus(f.task.id, 'open', 'ag_mara', 'Shorter, please');
  assert.deepEqual(wakesOn(f, 'ag_tom', f.task.id).map(w => w.note), ['Mara reopened this task: Shorter, please']);
  assert.equal(f.current().ledger.facts?.filter(fact => fact.startsWith('Reopened by the human')).length, 2);

  // The owner moving its own work on wakes nobody.
  f.tasks.setStatus(f.task.id, 'waiting', 'ag_tom', 'Waiting for the render');
  drain(f);
  f.tasks.setStatus(f.task.id, 'working', 'ag_tom');
  assert.deepEqual(wakesOn(f, 'ag_tom', f.task.id), []);
});

test('a human reopen starts the stall count again', () => {
  const f = ownershipFixture();
  for (let i = 0; i < 6; i++) f.turn(false); // six turns without progress
  assert.ok((f.current().ledger.stalls ?? 0) >= 6);
  f.tasks.setStatus(f.task.id, 'blocked', 'ag_tom', 'No result yet');
  drain(f);
  f.tasks.setStatus(f.task.id, 'working', 'human', 'Try the other footage');
  const { ledger } = f.current();
  assert.equal(ledger.stalls, 0);
  assert.ok(ledger.tried!.length >= 6, 'the history of tried approaches stays');
});

