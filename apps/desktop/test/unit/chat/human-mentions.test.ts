// Review #35 – an agent's @mention of the person reaches them under every name agents use for
// them: the profile name (what agents see in their context), "CEO", "Human" and "You". A quiet
// background turn that mentions the person is posted loud and notifies them as important; an
// agent named like the person loses the tie; agent-only rooms and the person's own messages
// never mention the person. Titles and status lines still say "You" (nameOf unchanged).
// Owns: these assertions only. Never: real engines, accounts or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { humanAliases, mentionCandidates } from '../../../src/runtime/chat/mentions.ts';
import { chatTitleFor } from '../../../src/runtime/chat/titles.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { agent, harness } from './harness.ts';
import { setup } from '../agents/fixture.ts';

const profile = (name?: string) => ({ get: () => ({ profile: { name, timezone: 'UTC' } }) }) as unknown as RuntimeServices['settings'];

test('humanAliases / mentionCandidates: profile name first, fixed aliases, only when the person is a member', () => {
  assert.deepEqual(humanAliases(profile('  Gerd ')), ['Gerd', 'CEO', 'Human', 'You']);
  assert.deepEqual(humanAliases(undefined), ['CEO', 'Human', 'You']);
  assert.deepEqual(humanAliases({ get: () => { throw new Error('not ready'); } }), ['CEO', 'Human', 'You']);
  const names = (id: string) => (id === 'ag_tom' ? 'Tom' : id);
  assert.deepEqual(mentionCandidates([{ memberId: HUMAN_ID }, { memberId: 'ag_tom' }, { memberId: 'ag_mara' }], 'ag_mara', names, profile('Gerd')), [
    { id: HUMAN_ID, name: 'Gerd' }, { id: HUMAN_ID, name: 'CEO' }, { id: HUMAN_ID, name: 'Human' }, { id: HUMAN_ID, name: 'You' }, { id: 'ag_tom', name: 'Tom' },
  ]);
  assert.deepEqual(mentionCandidates([{ memberId: 'ag_tom' }, { memberId: 'ag_mara' }], 'ag_mara', names, profile('Gerd')), [{ id: 'ag_tom', name: 'Tom' }], 'agent-only room');
});

test('a quiet agent message that mentions the person by profile name is loud, mentions them and notifies them', () => {
  const h = harness();
  Object.assign(h.services, { settings: profile('Gerd') });
  const tom = h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: [tom.id], createdBy: HUMAN_ID });
  const begun = h.chats.beginAgentMessage(chat.id, tom.id, 'run_1');
  const done = h.chats.finishAgentMessage(begun.id, { body: '@Gerd the upload needs your login code', state: 'final', silent: true });
  assert.deepEqual(done.mentions, [HUMAN_ID]);
  assert.equal(done.silent, false);
  assert.equal(h.notified.at(-1)?.kind, 'important');
  assert.equal(h.chats.summary(chat.id).unread, 1);
});

test('"@CEO" without a profile name, and chat.send by an agent, mention the person; their own "@You" does not', () => {
  const h = harness();
  const tom = h.org.add(agent('ag_tom', 'Tom'));
  const mara = h.org.add(agent('ag_mara', 'Mara'));
  const chat = h.chats.create({ agentIds: [tom.id, mara.id], createdBy: HUMAN_ID });
  const begun = h.chats.beginAgentMessage(chat.id, tom.id, 'run_1');
  assert.deepEqual(h.chats.finishAgentMessage(begun.id, { body: 'Done. @CEO please review.', state: 'final', silent: true }).mentions, [HUMAN_ID]);
  const sent = h.chats.send({ conversationId: chat.id, authorId: mara.id, body: '@Human and @Tom: the draft is in the folder.' });
  assert.deepEqual(new Set(sent.mentions), new Set([HUMAN_ID, tom.id]));
  assert.deepEqual(h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: '@You is me, @Mara go' }).mentions, [mara.id]);

  const room = h.chats.create({ agentIds: [tom.id, mara.id], humans: false, createdBy: tom.id });
  assert.deepEqual(h.chats.send({ conversationId: room.id, authorId: mara.id, body: '@CEO will like this' }).mentions, [], 'agent-only room');
});

test('an agent named like the person loses the tie; a longer agent name still wins', () => {
  const h = harness();
  Object.assign(h.services, { settings: profile('Gerd') });
  const tom = h.org.add(agent('ag_tom', 'Tom'));
  const twin = h.org.add(agent('ag_gerd', 'Gerd'));
  const long = h.org.add(agent('ag_gerdm', 'Gerd Miller'));
  const chat = h.chats.create({ agentIds: [tom.id, twin.id, long.id], createdBy: HUMAN_ID });
  assert.deepEqual(h.chats.send({ conversationId: chat.id, authorId: tom.id, body: '@Gerd can you sign this?' }).mentions, [HUMAN_ID]);
  assert.deepEqual(h.chats.send({ conversationId: chat.id, authorId: tom.id, body: '@Gerd Miller has the file' }).mentions, [long.id]);
  assert.deepEqual(chatTitleFor(h.services, chat.id, HUMAN_ID).split(', ').sort(), ['Gerd', 'Gerd Miller', 'Tom'], 'titles still use member names (B-050 K2: per viewer)');
});

test('quiet turns: a retry turn that writes "@Gerd …" reaches the person', async () => {
  const h = setup();
  Object.assign(h.services, { settings: profile('Gerd'), router: { route: async () => h.route } });
  Object.assign(h.services.accounts, { list: () => [], markUnavailable: () => false, markLimited: () => {} });
  Object.assign(h.services.catalog, { list: () => [] });
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Upload the cut', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  h.tasks.claim(task.id, h.tom.id);
  h.state.script = async () => ({ text: '@Gerd the upload needs your login code', stop: 'done' });
  const before = h.notified.length;
  await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_retry', taskId: task.id, reason: 'retry' }));
  const last = h.chats.messages(h.chat.id).filter((message) => message.authorId === h.tom.id && message.kind === 'text').at(-1)!;
  assert.equal(last.body, '@Gerd the upload needs your login code');
  assert.equal(last.silent, false, 'a mention of the person always reaches');
  assert.ok(last.mentions.includes(HUMAN_ID));
  assert.equal(h.notified.slice(before).at(-1)?.kind, 'important');
});
