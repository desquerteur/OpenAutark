// B-057 foundation: a split's thread key – `split:<splitId>` before chat, task and source (shared/model/origin.ts
// threadKey; a split id or a SplitTurn such as ToolContext.split) – and the split.upserted event's topic.
// Owns: these shape checks. Never: split lifecycle behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadKey } from '../../../src/shared/model/origin.ts';
import { isSplitThread, SPLIT_LIMITS, SPLIT_TERMINAL, splitThread, type SplitTurn } from '../../../src/shared/model/splits.ts';
import { topicOf } from '../../../src/shared/api/events.ts';

const turn: SplitTurn = {
  splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 3, title: 'Check the tests', parentRunId: 'rn_1', parentThread: 'cv_1',
  parentConversationId: 'cv_1', context: 'fork', firstTurn: true,
};

test('a split thread comes first, before chat, task and origin', () => {
  assert.equal(splitThread('sp_1'), 'split:sp_1');
  assert.equal(threadKey({ split: 'sp_1', conversationId: 'cv_1', taskId: 'tk_1', origin: { source: 'news', label: 'Task news' } }), 'split:sp_1');
  assert.equal(threadKey({ split: turn, conversationId: 'cv_1' }), 'split:sp_1', 'a SplitTurn (ToolContext.split) names its split');
  assert.equal(threadKey({ split: undefined, conversationId: 'cv_1' }), 'cv_1');
  assert.equal(threadKey({ split: '', taskId: 'tk_1' }), 'task:tk_1');
  assert.equal(threadKey({ origin: { source: 'news', label: 'Task news' } }), 'src:news');
  assert.equal(threadKey({}), '');
  assert.ok(isSplitThread(threadKey({ split: 'sp_1' })));
  assert.ok(!isSplitThread('cv_1') && !isSplitThread('task:tk_1') && !isSplitThread('src:news'));
});

test('limits and terminal states', () => {
  assert.deepEqual([...SPLIT_TERMINAL].sort(), ['done', 'failed', 'skipped', 'stopped']);
  assert.equal(SPLIT_LIMITS.partsPerCall, 12);
  assert.equal(SPLIT_LIMITS.resultChars, 24_000);
});

test('split.upserted goes on the agent\'s runs topic, like run.upserted', () => {
  assert.equal(topicOf('split.upserted', { agentId: 'ag_ava', id: 'sg_1' }), 'runs:ag_ava');
  assert.equal(topicOf('run.upserted', { agentId: 'ag_ava', id: 'rn_1' }), 'runs:ag_ava');
});
