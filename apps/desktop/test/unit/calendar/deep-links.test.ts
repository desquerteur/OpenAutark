// B-041 foundation: a to-do push opens My day (runtime/pwa/push.ts).
// Owns: checks of that link rule only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushTarget } from '../../../src/runtime/pwa/push.ts';

test('a to-do or blocker push opens My day unless it may open its chat; other kinds open Home', () => {
  assert.equal(pushTarget({ kind: 'todo', taskId: 'task_1' }).url, '/#/day');
  assert.equal(pushTarget({ kind: 'blocker', conversationId: 'ch_1' }, { chat: false }).url, '/#/day');
  assert.equal(pushTarget({ kind: 'todo', conversationId: 'ch_1' }).url, '/#/chat/ch_1');
  assert.equal(pushTarget({ kind: 'done' }).url, '/#/home');
});
