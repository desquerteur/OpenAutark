// The change contract of agent-made to-do surfaces (concept-generative-chat-ui-adaptive-widgets 22):
// a later ask block with the same "id" replaces only its own author's open to-do – in a group chat
// another agent's block with that id becomes a to-do of its own and leaves the first one (its widget,
// title, anchor and author) untouched; the same author still replaces its own, and a finished to-do
// is never revived.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { agent, harness } from '../chat/harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_ben', 'Ben'));
  const chat = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID });
  const post = (authorId: string, block: Record<string, unknown>) => {
    const body = '```ui\n' + JSON.stringify(block) + '\n```';
    const message = h.chats.send({ conversationId: chat.id, body, authorId, authorKind: 'agent' });
    return { message, todo: h.tasks.ingestBlocks(message, uiBlocksOf(body).map((entry) => entry.block))[0] };
  };
  return { ...h, chat, post };
}

const choice = (question: string) => ({ type: 'choice', important: true, id: 'pick-color', question, options: [{ label: 'Red' }, { label: 'Blue' }] });

test('another agent\'s block with the same id makes its own to-do and leaves the first one untouched', () => {
  const h = setup();
  const first = h.post('ag_ava', choice('Which color for the logo?'));
  const second = h.post('ag_ben', choice('Which color for the banner?'));
  assert.ok(first.todo && second.todo);
  assert.notEqual(second.todo.id, first.todo.id, 'Ben gets a to-do of his own');
  const kept = h.tasks.get(first.todo.id)!;
  assert.equal(kept.createdBy, 'ag_ava');
  assert.equal(kept.messageId, first.message.id, 'still anchored to Ava\'s message');
  assert.equal(kept.widget?.question, 'Which color for the logo?', 'Ava\'s widget unchanged');
  assert.equal(h.tasks.todos().filter((todo) => todo.conversationId === h.chat.id).length, 2, 'both wait for the person');
});

test('the same author still replaces its own open to-do; a finished one is never revived', () => {
  const h = setup();
  const first = h.post('ag_ava', choice('Which color for the logo?'));
  const again = h.post('ag_ava', choice('Which color for the new logo?'));
  assert.equal(again.todo?.id, first.todo?.id, 'the same to-do');
  assert.equal(h.tasks.get(first.todo!.id)?.widget?.question, 'Which color for the new logo?');
  assert.equal(h.tasks.get(first.todo!.id)?.messageId, again.message.id, 'moved to the newer message');

  h.tasks.answer({ taskId: first.todo!.id, answer: { choice: 'Red' }, by: HUMAN_ID });
  assert.equal(h.tasks.get(first.todo!.id)?.status, 'done');
  const later = h.post('ag_ava', choice('Which color now?'));
  assert.notEqual(later.todo?.id, first.todo?.id, 'a finished to-do stays finished – the block is a new one');
});
