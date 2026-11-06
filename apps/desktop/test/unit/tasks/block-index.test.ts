// Human to-dos from ask blocks are keyed by the PARSE index (the chat's blockIndex), so an
// ```app fence or an invalid ```ui block before an ask block never shifts the numbering and an
// answer by messageId + blockIndex always completes the right to-do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { agent, harness } from '../chat/harness.ts';

test('answers by blockIndex reach the right to-do when other fences come first', () => {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const body = [
    'Two things:',
    '```app\n<p>preview</p>\n```',
    '```ui\n{"type":"nope"}\n```',
    '```ui\n{"type":"confirm","important":true,"instructions":"Plug in the camera"}\n```',
    '```ui\n{"type":"choice","important":true,"question":"Which intro?","options":["A","B"]}\n```',
  ].join('\n\n');
  const message = h.chats.send({ conversationId: chat.id, body, authorId: 'ag_ava', authorKind: 'agent' });
  const blocks = uiBlocksOf(body);
  assert.deepEqual(blocks.map((item) => item.index), [2, 3], 'the app and the invalid fence take parse indexes 0 and 1');

  const todos = h.tasks.ingestBlocks(message, blocks.map((item) => item.block), blocks.map((item) => item.index));
  assert.equal(todos.length, 2);
  const choice = todos.find((todo) => todo.widget?.type === 'choice')!;
  const confirm = todos.find((todo) => todo.widget?.type === 'confirm')!;

  const answered = h.tasks.answer({ messageId: message.id, blockIndex: 3, answer: { choice: 'B' }, by: 'human' });
  assert.equal(answered?.id, choice.id, 'blockIndex 3 is the choice block, not the confirm block');
  assert.equal(h.tasks.get(confirm.id)?.status, 'open', 'the other to-do stays open');
});
