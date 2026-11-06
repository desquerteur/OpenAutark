// B-050 K4: the three levels of a message (normal, important, silent) map onto priority + silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelFields, messageLevel, type MessageLevel } from '../../../src/shared/model/chat.ts';

test('messageLevel reads priority and silent; quiet wins over important', () => {
  assert.equal(messageLevel({ priority: 'normal', silent: false }), 'normal');
  assert.equal(messageLevel({ priority: 'important', silent: false }), 'important');
  assert.equal(messageLevel({ priority: 'normal', silent: true }), 'silent');
  assert.equal(messageLevel({ priority: 'important', silent: true }), 'silent');
});

test('levelFields is the inverse of messageLevel', () => {
  assert.deepEqual(levelFields('normal'), { priority: 'normal', silent: false });
  assert.deepEqual(levelFields('important'), { priority: 'important', silent: false });
  assert.deepEqual(levelFields('silent'), { priority: 'normal', silent: true });
  for (const level of ['normal', 'important', 'silent'] as MessageLevel[]) assert.equal(messageLevel(levelFields(level)), level);
});
