// Delegation (T13, src/runtime/agents/handoff.ts): the depth limit; a colleague joins the chat
// and the work stays there; the delegator's task waits on the child and is woken with its result
// and evidence ('child'), with two children only after the last; mode work of oneself runs in a
// hidden work chat per parent and mode that the next delegation reuses (archived or not, like a
// delegation from an archived chat, C2); a task waiting on
// delegated work is never escalated; a wait on the person is never replaced; a chat the delegator
// is not a member of (any more) is refused before anything happens (review #32) – as the run's chat it is no
// source at all (B-054: the child is chat-free). B-078 D7: out of a 1:1 the work goes to the delegator's own 1:1 with them.
// Owns: these assertions only. Never: real timers, engines or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPTH_LIMIT_TEXT, delegate, handoff } from '../../../src/runtime/agents/handoff.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { Evidence } from '../../../src/shared/model/tasks.ts';
import { agent } from '../chat/harness.ts';
import { findDirect, findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import { ownershipFixture } from '../tasks/ownership-fixture.ts';

const MODES = [{ key: 'general', name: 'General' }, { key: 'video', name: 'Video' }, { key: 'computer', name: 'Computer' }];

function fixture() {
  const f = ownershipFixture();
  f.org.add(agent('ag_lea', 'Lea', { managerId: 'ag_mara' }));
  f.org.add(agent('ag_ben', 'Ben', { managerId: 'ag_mara' }));
  (f.services as { modes: unknown }).modes = { list: () => MODES };
  /** Tom's tool context, on his task unless another task is given. */
  const ctx = (taskId: string | undefined = f.task.id): ToolContext => ({
    agent: f.org.get('ag_tom')!, runId: 'run_t13', conversationId: f.chat.id, taskId, mode: 'general',
    services: f.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  });
  const wakes = (agentId: string) => f.wakes.list(agentId).filter((wake) => wake.claimedAt === undefined);
  const drain = (agentId: string) => f.wakes.done(f.wakes.claim(agentId, Number.MAX_SAFE_INTEGER).map((wake) => wake.id));
  return { ...f, ctx, wakes, drain };
}

test('depth limit: a task three levels down may not delegate further', () => {
  const f = fixture();
  let parentId = f.task.id;
  for (const title of ['Level 1', 'Level 2', 'Level 3']) {
    parentId = f.tasks.create({ conversationId: f.chat.id, parentId, title, assigneeId: 'ag_tom', createdBy: 'ag_tom' }).id;
  }
  assert.throws(() => delegate(f.ctx(parentId), { to: 'ag_lea', title: 'One more level' }), (error: Error) => error.message === DEPTH_LIMIT_TEXT);
  assert.doesNotThrow(() => delegate(f.ctx(), { to: 'ag_lea', title: 'Find the music' }), 'the top level may delegate');
});

test('to a colleague: they join this chat, the work stays here, the delegating task waits on it', () => {
  const f = fixture();
  assert.ok(!f.chats.members(f.chat.id).some((member) => member.memberId === 'ag_lea'));
  const out = delegate(f.ctx(), { to: 'ag_lea', title: 'Find the music' });
  assert.equal(out.chatId, undefined, 'no work chat for a colleague');
  const child = f.tasks.get(out.taskId)!;
  assert.equal(child.conversationId, f.chat.id);
  assert.equal(child.parentId, f.task.id);
  assert.equal(child.assigneeId, 'ag_lea');
  assert.ok(f.chats.members(f.chat.id).some((member) => member.memberId === 'ag_lea' && !member.leftAt), 'Lea joined the chat');
  const parent = f.current();
  assert.equal(parent.status, 'waiting');
  assert.deepEqual({ kind: parent.waitingOn?.kind, id: parent.waitingOn?.id }, { kind: 'task', id: child.id });
  assert.equal(parent.waitingOn?.reason, 'Waiting for Lea: Find the music');
  assert.ok(f.lines().includes('Tom → Lea'));
  assert.equal(f.wakes('ag_lea').filter((wake) => wake.taskId === child.id && wake.reason === 'handoff').length, 1, 'Lea is woken for it');
});

test('the child finishes: the waiting task resumes and its owner gets the result with evidence', () => {
  const f = fixture();
  const { taskId } = delegate(f.ctx(), { to: 'ag_lea', title: 'Find the music' });
  f.drain('ag_tom');
  const evidence: Evidence[] = [{ kind: 'file', label: 'calm-track.mp3', ref: 'fi_track' }];
  f.tasks.complete(taskId, { summary: 'Picked three calm tracks', evidence, verification: 'claimed_by_agent' }, 'ag_lea');
  const parent = f.current();
  assert.equal(parent.status, 'working');
  assert.equal(parent.waitingOn, undefined);
  const wake = f.wakes('ag_tom').find((item) => item.taskId === f.task.id && item.reason === 'child');
  assert.ok(wake, 'Tom is woken with reason child');
  assert.match(wake.note!, /Lea finished "Find the music"/);
  assert.match(wake.note!, /Result: Picked three calm tracks/);
  assert.match(wake.note!, /calm-track\.mp3: fi_track/);
});

test('two children: the task waits on both and continues after the last', () => {
  const f = fixture();
  const music = delegate(f.ctx(), { to: 'ag_lea', title: 'Find the music' });
  const cover = delegate(f.ctx(), { to: 'ag_ben', title: 'Design the cover' });
  assert.deepEqual([...(f.current().waitingOn?.ids ?? [])].sort(), [music.taskId, cover.taskId].sort(), 'both children are waited on');
  f.tasks.complete(music.taskId, { summary: 'Music picked', evidence: [{ kind: 'note', label: 'track 2' }], verification: 'claimed_by_agent' }, 'ag_lea');
  assert.equal(f.current().status, 'waiting', 'the cover is still open');
  assert.equal(f.current().waitingOn?.id, cover.taskId);
  f.tasks.complete(cover.taskId, { summary: 'Cover done', evidence: [{ kind: 'file', label: 'cover.png' }], verification: 'claimed_by_agent' }, 'ag_ben');
  assert.equal(f.current().status, 'working');
});

test('mode work of oneself: a hidden work chat per task and mode, reused, still a step of the task', () => {
  const f = fixture();
  const first = delegate(f.ctx(), { to: 'video', title: 'Cut the intro' });
  assert.ok(first.chatId, 'a work chat was opened');
  const work = f.chats.summary(first.chatId);
  assert.equal(work.title, 'Cut the launch video · Video');
  assert.equal(work.settings.hiddenFromList, true);
  assert.equal(work.settings.mode, 'video');
  assert.deepEqual(work.members.filter((member) => !member.leftAt).map((member) => member.memberId), ['ag_tom'], 'the agent only');
  const child = f.tasks.get(first.taskId)!;
  assert.equal(child.conversationId, first.chatId);
  assert.equal(child.mode, 'video');
  assert.equal(child.assigneeId, 'ag_tom');
  assert.ok(f.current().steps.some((step) => step.id === first.taskId), 'listed as a step of the task');
  assert.ok(f.lines().includes('Tom · video'), 'the line is in the chat the person follows');
  assert.equal(f.wakes('ag_tom').filter((wake) => wake.taskId === child.id && wake.conversationId === first.chatId).length, 1, 'the work runs in the work chat');

  const again = delegate(f.ctx(), { to: 'video', title: 'Add captions' });
  assert.equal(again.chatId, first.chatId, 'the next video delegation reuses the work chat');
  const other = delegate(f.ctx(), { to: 'computer', title: 'Upload the draft' });
  assert.notEqual(other.chatId, first.chatId, 'another mode gets its own work chat');
  assert.equal(f.chats.summary(other.chatId!).title, 'Cut the launch video · Computer');
});

test('archived chats count like any other (C2): delegation from one works, an archived work chat is reused', () => {
  const f = fixture();
  const first = delegate(f.ctx(), { to: 'video', title: 'Cut the intro' });
  f.chats.archive(first.chatId!);
  const again = delegate(f.ctx(), { to: 'video', title: 'Add captions' });
  assert.equal(again.chatId, first.chatId, 'no second hidden work chat after the person archived the first');

  f.chats.archive(f.chat.id);
  const child = delegate(f.ctx(), { to: 'ag_lea', title: 'Find the music' });
  assert.equal(f.tasks.get(child.taskId)!.conversationId, f.chat.id, 'the work stays in the archived chat');
});

test('a task waiting on delegated work only waits; a wait on the person is never replaced', () => {
  const f = fixture();
  delegate(f.ctx(), { to: 'ag_lea', title: 'Find the music' });
  for (let i = 0; i < 12; i++) f.turn(false, 'failed', 'Nothing to do yet');
  const parent = f.current();
  assert.equal(parent.status, 'waiting', 'still waiting on Lea');
  assert.equal(f.wakes('ag_mara').length, 0, 'the manager is not pulled in');

  const g = fixture();
  g.tasks.setStatus(g.task.id, 'needs_you', 'ag_tom', 'Which logo?');
  delegate(g.ctx(), { to: 'ag_lea', title: 'Find the music' });
  assert.equal(g.current().status, 'needs_you');
  assert.equal(g.current().waitingOn?.kind, 'human', 'the person is still the one waited on');
});

test('a chat the delegator is not in: refused before anyone joins or anything is created (also to itself or a mode)', () => {
  const f = fixture();
  const secret = f.chats.create({ title: 'Private with Mara', agentIds: ['ag_mara'], createdBy: 'human' });
  const state = (chatId: string) => ({
    members: f.chats.members(chatId).filter((member) => !member.leftAt).map((member) => member.memberId).sort(),
    tasks: f.db.all('SELECT id FROM tasks WHERE conversation_id = ?', [chatId]).length,
    messages: f.chats.messages(chatId, { limit: 100 }).length,
  });
  const before = state(secret.id);
  const refused = (error: Error & { code?: string }) => error.code === 'forbidden' && error.message === `I am not a member of chat ${secret.id}.`;
  for (const to of ['ag_lea', 'ag_tom', 'video']) {
    assert.throws(() => delegate(f.ctx(), { to, title: 'Read the private chat', chatId: secret.id }), refused, `to ${to}`);
    assert.throws(() => delegate({ ...f.ctx(), taskId: undefined }, { to, title: 'No parent either', chatId: secret.id }), refused);
  }
  assert.deepEqual(state(secret.id), before, 'nobody joined, no task, no line');
  assert.equal(f.wakes('ag_lea').length, 0, 'nobody is woken');
  assert.equal(f.current().status, 'working', 'the delegator\'s task does not wait on anything');

  // A chat it left counts the same: no re-join through delegation. Named, it is refused; as the run's chat,
  // B-054: it is not the source – the child is chat-free and the left chat stays as it was.
  f.chats.setMembers(f.chat.id, { remove: ['ag_tom'] }, 'human');
  const left = state(f.chat.id);
  assert.throws(() => delegate(f.ctx(), { to: 'ag_lea', title: 'Find the music', chatId: f.chat.id }), (error: Error & { code?: string }) => error.code === 'forbidden');
  const free = delegate(f.ctx(), { to: 'ag_lea', title: 'Find the music' });
  assert.equal(f.tasks.get(free.taskId)!.conversationId, undefined, 'a chat-free child');
  const after = state(f.chat.id);
  assert.deepEqual({ members: after.members, tasks: after.tasks }, { members: left.members, tasks: left.tasks }, 'nobody joined, no task there');
  const added = f.chats.messages(f.chat.id, { limit: 100 }).slice(left.messages);
  assert.deepEqual(added.map((m) => [m.kind, m.body]), [['status', 'Waiting: Cut the launch video']], 'only the parent\'s own wait line');
  const leftNow = state(f.chat.id);
  // Nor through a handoff of a task in that chat.
  assert.throws(() => handoff(f.ctx(), { to: 'ag_lea' }), (error: Error & { code?: string }) => error.code === 'forbidden');
  assert.equal(f.current().assigneeId, 'ag_tom', 'the task stays where it was');
  assert.deepEqual(state(f.chat.id), leftNow, 'Lea did not join');
});

test('B-078 D7: out of a 1:1 the colleague joins nothing – the work goes to our own 1:1, the line stays in the 1:1', () => {
  const f = fixture();
  const owners = findOrCreateDirect(f.services as RuntimeServices, 'human', 'ag_tom', { createdBy: 'human' });
  const ctx = { ...f.ctx(), conversationId: owners };
  const out = delegate(ctx, { to: 'ag_lea', title: 'Find the music' });
  const ours = findDirect(f.services as RuntimeServices, 'ag_tom', 'ag_lea');
  assert.ok(ours, 'Tom and Lea have their 1:1');
  assert.equal(out.chatId, ours, 'the result names where the work is');
  assert.equal(f.tasks.get(out.taskId)!.conversationId, ours);
  assert.deepEqual(f.chats.members(owners).map((member) => member.memberId).sort(), ['ag_tom', 'human'], 'the 1:1 stays two');
  const line = f.chats.messages(owners).filter((message) => message.kind === 'status').at(-1);
  assert.equal(line?.body, 'Tom → Lea');
  assert.equal(line?.meta.status?.details?.chatId, ours);
  assert.ok(f.wakes('ag_lea').some((wake) => wake.taskId === out.taskId && wake.conversationId === ours), 'Lea is woken in our 1:1');

  // handoff of a task that lives in the 1:1: Lea takes it over from our own 1:1, the 1:1 stays two
  const task = f.tasks.create({ conversationId: owners, title: 'Book the venue', assigneeKind: 'agent', assigneeId: 'ag_tom', createdBy: 'human' });
  handoff({ ...ctx, taskId: task.id }, { to: 'ag_lea' });
  const moved = f.tasks.get(task.id)!;
  assert.equal(moved.assigneeId, 'ag_lea');
  assert.equal(moved.conversationId, ours, 'the task moved with Lea into our 1:1');
  assert.deepEqual(f.chats.members(owners).map((member) => member.memberId).sort(), ['ag_tom', 'human']);
  const leas = f.wakes('ag_lea').filter((wake) => wake.taskId === task.id);
  assert.ok(leas.length > 0, 'Lea is woken for it');
  assert.ok(leas.every((wake) => wake.conversationId === ours), 'only in our 1:1, never in the 1:1 she is not in');
  assert.ok(leas.some((wake) => wake.note?.includes('our own 1:1')), 'her note says where the task lives now');
  const handLine = f.chats.messages(owners).filter((message) => message.kind === 'status' && message.taskId === task.id).at(-1);
  assert.equal(handLine?.meta.status?.details?.chatId, ours, 'the line stays in the 1:1 and names our room');
});
