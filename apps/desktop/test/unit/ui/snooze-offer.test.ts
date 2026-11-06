// Where an ask widget offers Snooze (src/ui/blocks/snooze.ts, F03): only where a to-do stands behind it – a to-do, or
// an agent's chat block that became one (B-078 D9: important, "todo": true or a timer); any other block is a quick
// reply in its message and would always fail with "To-do not found".
// Owns: these assertions only. Never: the DOM or rpc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { canSnooze } from '../../../src/ui/blocks/snooze.ts';

const body = [
  '```ui\n{"type":"timer","duration":"PT10M","label":"Tea","todo":false}\n```',
  '```ui\n{"type":"timer","duration":"PT10M","label":"Bread"}\n```',
  '```ui\n{"type":"choice","question":"Which logo?","options":["A","B"]}\n```',
  '```ui\n{"type":"choice","question":"Sign the contract?","options":["Yes","No"],"important":true}\n```',
].join('\n');

test('only a chat block that became a to-do offers Snooze', () => {
  const [inline, timer, quick, important] = uiBlocksOf(body);
  const at = (index: number) => ({ kind: 'block' as const, messageId: 'msg_1', blockIndex: index });
  assert.equal(canSnooze(inline.block, at(inline.index)), false, '"todo": false');
  assert.equal(canSnooze(timer.block, at(timer.index)), true, 'a timer rings from the list');
  assert.equal(canSnooze(quick.block, at(quick.index)), false, 'an ordinary quick reply stays in the message');
  assert.equal(canSnooze(important.block, at(important.index)), true, 'an important ask is a to-do');
});

test('a to-do offers Snooze', () => {
  assert.equal(canSnooze({}, { kind: 'task', taskId: 'task_1' }), true);
  assert.equal(canSnooze({ todo: false }, { kind: 'task', taskId: 'task_1' }), true);
});
