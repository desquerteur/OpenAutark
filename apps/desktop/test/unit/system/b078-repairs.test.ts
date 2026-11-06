// B-078 one-time repairs of data from before the build (system/b078-repairs.ts): a marked 1:1 loses the agents outside
// its pair and their open work moves into their own 1:1 with the giver (chat/direct-repair.ts); the agents' approval-era
// to-dos close and each asking agent gets one wake with the self-check note, the host's and identity asks stay
// (tasks/approval-close.ts); the personal manager of a lived-in organisation gets one look at the team, a fresh one
// nothing (org/org-review.ts). Each runs once.
// Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { pairOf } from '../../../src/runtime/chat/direct.ts';
import { repairDirectChats } from '../../../src/runtime/chat/direct-repair.ts';
import { CLOSED_NOTE, closeApprovalTodos } from '../../../src/runtime/tasks/approval-close.ts';
import { ORG_REVIEW_NOTE, wakeOrgReview } from '../../../src/runtime/org/org-review.ts';
import { SELF_CHECK_NOTE } from '../../../src/runtime/tools/builtin/human.ts';
import { agent, harness } from '../chat/harness.ts';

function rig() {
  const h = harness();
  h.org.add(agent('ag_mara', 'Mara'));
  h.org.add(agent('ag_konrad', 'Konrad', { template: 'manager', mode: 'manager' }));
  return h;
}

test('a 1:1 with a third agent goes back to two; its open work moves into its own 1:1 with the giver; once', () => {
  const h = rig();
  const chat = h.chats.create({ agentIds: ['ag_mara', 'ag_konrad'], createdBy: HUMAN_ID, settings: { direct: true, directPair: pairOf(HUMAN_ID, 'ag_mara') } });
  const work = h.tasks.create({ conversationId: chat.id, title: 'Check the invoice', assigneeKind: 'agent', assigneeId: 'ag_konrad', createdBy: HUMAN_ID });
  const hers = h.tasks.create({ conversationId: chat.id, title: 'Draft the post', assigneeKind: 'agent', assigneeId: 'ag_mara', createdBy: HUMAN_ID });
  assert.equal(repairDirectChats(h.services), 1);
  const active = h.chats.members(chat.id).filter((member) => member.leftAt === undefined).map((member) => member.memberId).sort();
  assert.deepEqual(active, [HUMAN_ID, 'ag_mara'].sort());
  const moved = h.tasks.get(work.id)!;
  assert.notEqual(moved.conversationId, chat.id, 'Konrad works on it in his own 1:1 with the owner');
  const room = h.chats.members(moved.conversationId!).filter((member) => member.leftAt === undefined).map((member) => member.memberId).sort();
  assert.deepEqual(room, [HUMAN_ID, 'ag_konrad'].sort());
  assert.equal(h.tasks.get(hers.id)!.conversationId, chat.id, 'the pair\'s own work stays');
  assert.ok(h.chats.messages(chat.id).some((message) => /Konrad continues one task from here in a 1:1 of its own/.test(message.body)));
  assert.equal(repairDirectChats(h.services), 0, 'once');
});

test('the agents\' approval-era to-dos close with one self-check wake per agent; the host\'s, identity and the person\'s stay', () => {
  const h = rig();
  const chat = h.chats.create({ agentIds: ['ag_mara'], createdBy: HUMAN_ID });
  const ask = (title: string, createdBy: string, humanReason: string, widget: Record<string, unknown>) =>
    h.tasks.create({ conversationId: chat.id, title, assigneeKind: 'human', createdBy, humanReason: humanReason as never, widget: widget as never });
  const vps = ask('Clean the VPS disk?', 'ag_mara', 'approval', { type: 'approve', action: 'Clean the disk' });
  const post = ask('Publish the LinkedIn post?', 'ag_mara', 'taste', { type: 'approve', action: 'Publish' });
  const lease = ask('Sign the lease', 'ag_mara', 'identity', { type: 'approve', action: 'Sign' });
  const host = ask('Access request', SYSTEM_ID, 'approval', { type: 'approve', accessRequestId: 'acc_1' });
  const own = ask('Buy milk', HUMAN_ID, 'approval', { type: 'confirm' });
  assert.equal(closeApprovalTodos(h.services), 2);
  assert.equal(h.tasks.get(vps.id)!.status, 'cancelled');
  assert.equal(h.tasks.get(post.id)!.status, 'cancelled');
  for (const kept of [lease, host, own]) assert.equal(h.tasks.get(kept.id)!.status, 'open', kept.title);
  const wakes = h.wakeRows().filter((row) => row.agent_id === 'ag_mara' && row.reason === 'event');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].note!, /"Clean the VPS disk\?", "Publish the LinkedIn post\?"/);
  assert.ok(wakes[0].note!.endsWith(SELF_CHECK_NOTE));
  assert.ok(h.chats.messages(chat.id).some((message) => message.body.includes(CLOSED_NOTE)));
  assert.equal(closeApprovalTodos(h.services), 0, 'once');
});

test('the personal manager of a lived-in organisation gets one look at the team; a fresh one gets none', () => {
  const fresh = rig();
  assert.equal(wakeOrgReview(fresh.services), false, 'nobody wrote a line yet');
  const h = rig();
  const chat = h.chats.create({ agentIds: ['ag_konrad'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: chat.id, body: 'Hello', authorId: HUMAN_ID, authorKind: 'human' });
  h.db.run('DELETE FROM wakes');
  assert.equal(wakeOrgReview(h.services), true);
  assert.equal(wakeOrgReview(h.services), false, 'once');
  const wakes = h.wakeRows().filter((row) => row.agent_id === 'ag_konrad' && row.note === ORG_REVIEW_NOTE);
  assert.equal(wakes.length, 1);
  assert.match(ORG_REVIEW_NOTE, /^Since the update/);
  assert.doesNotMatch(ORG_REVIEW_NOTE, /\bmay\b|allowed|only if/i);
});
