// B-054 (center-model.ts isReference): a task message in a chat is the task itself only when it is
// the task's anchor. A task handed over elsewhere, or in no chat at all (no anchor, no messageId),
// renders as a compact live reference – never as a second full card. Steps are never references.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReference } from '../../../src/ui/tasks/center-model.ts';

test('the anchor message is the task itself', () => {
  assert.equal(isReference({ id: 'msg_anchor' }, { messageId: 'msg_anchor' }), false);
});

test('a task anchored in another chat is a reference here', () => {
  assert.equal(isReference({ id: 'msg_b' }, { messageId: 'msg_a' }), true);
});

test('a chat-free task (no anchor) shared into a chat is a reference, not a full card', () => {
  assert.equal(isReference({ id: 'msg_shared' }, { messageId: undefined }), true);
  assert.equal(isReference({ id: 'msg_shared' }, {}), true);
});

test('a step stays part of its parent card, never a reference', () => {
  assert.equal(isReference({ id: 'msg_b' }, { messageId: 'msg_a', parentId: 'task_parent' }), false);
  assert.equal(isReference({ id: 'msg_b' }, { parentId: 'task_parent' }), false);
});
