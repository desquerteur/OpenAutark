// The to-do change contract through the task tools (concept-generative-chat-ui-adaptive-widgets 22,
// tools/builtin/tasks.ts othersTodoGuard): in a group chat another agent can read the question an
// agent put to the person, but cannot retitle, cancel, complete, re-assign it or add steps under it;
// its author and a manager of the author can; a to-do the person wrote stays open to any agent the
// person asks for help.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { center, company } from '../task-center/fixture.ts';

function setup() {
  const h = center();
  company(h); // Mara manages Tom and Lea
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_lea', 'ag_mara'], createdBy: HUMAN_ID });
  const body = '```ui\n' + JSON.stringify({ type: 'choice', important: true, id: 'pick-cut', question: 'Which cut for the trailer?', options: [{ label: 'Short' }, { label: 'Long' }] }) + '\n```';
  const message = h.chats.send({ conversationId: chat.id, body, authorId: 'ag_tom', authorKind: 'agent' });
  const todo = h.tasks.ingestBlocks(message, uiBlocksOf(body).map((entry) => entry.block))[0]!;
  return { ...h, chat, todo };
}

test('its author and a manager of the author still change it; the person\'s own to-do stays open to helpers', async () => {
  const h = setup();
  assert.equal((await h.call('ag_tom', 'tasks.update', { taskId: h.todo.id, notes: 'The long cut has the new intro.' })).error, false, 'the author');
  assert.equal(h.tasks.get(h.todo.id)?.notes, 'The long cut has the new intro.');
  assert.equal((await h.call('ag_mara', 'tasks.update', { taskId: h.todo.id, priority: 1 })).error, false, 'a manager of the author');
  assert.equal(h.tasks.get(h.todo.id)?.priority, 1);

  const own = h.tasks.create({ conversationId: h.chat.id, title: 'Call the venue', assigneeKind: 'human', createdBy: HUMAN_ID });
  const helped = await h.call('ag_lea', 'tasks.update', { taskId: own.id, notes: 'Number: see the contract.' });
  assert.equal(helped.error, false, 'a to-do the person wrote is not covered by the author rule');
});
