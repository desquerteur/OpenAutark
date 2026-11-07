// AF-016 – the prompt queue's pure rules: what a run's end does to the queue (runtime/prompt-queue/rules.ts – a failure
// and a question pause it, everything else lets the next prompt go), the answer checks for a question, the order helpers
// (shared/model/prompt-queue.ts moveItem, promptPreview), the composer's send mode (ui/chat/composer/queue.ts sendMode)
// and the list's drop place and pause line (ui/chat/composer/QueueList.tsx).
// Owns: these assertions only. Never: a database or a window (service.test.ts, test/ui/composer-queue-window.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterRun, endsWithQuestion, hasAskBlock } from '../../../src/runtime/prompt-queue/rules.ts';
import { moveItem, promptPreview } from '../../../src/shared/model/prompt-queue.ts';
import { dropIndex, pausedText, sendMode } from '../../../src/ui/chat/composer/queue.ts';

test('after a run: a failure pauses (with its error), a question pauses, anything else lets the next prompt go', () => {
  assert.deepEqual(afterRun({ status: 'failed', error: 'Rate limited', asked: false }), { pause: 'error', note: 'Rate limited' });
  assert.deepEqual(afterRun({ status: 'failed', asked: false }), { pause: 'error', note: 'The agent\'s turn failed.' });
  assert.deepEqual(afterRun({ status: 'done', asked: true }), { pause: 'ask' });
  assert.equal(afterRun({ status: 'done', asked: false }), 'next');
  assert.equal(afterRun({ status: 'interrupted', asked: false }), 'next', 'an interrupt hands over to the next turn; the person\'s Stop paused already');
});

test('a question to the person: the last line outside code ends with a question mark; ask blocks and mini-app to-dos', () => {
  assert.equal(endsWithQuestion('Done.\n\nShould I deploy to staging or production?'), true);
  assert.equal(endsWithQuestion('Which one do you prefer?**'), true, 'behind emphasis');
  assert.equal(endsWithQuestion('Done – the notes are updated.'), false);
  assert.equal(endsWithQuestion('Is it ready?\n\nYes, all three files are written.'), false, 'only the last line counts');
  assert.equal(endsWithQuestion('Here:\n```js\nconst ok = a ? b : c?\n```'), false, 'code does not count');
  assert.equal(hasAskBlock('Pick one:\n```ui\n{"type":"choice","options":["A","B"]}\n```'), true);
  assert.equal(hasAskBlock('```ui\n{"type":"table","rows":[]}\n```'), false, 'a table asks nothing');
  assert.equal(hasAskBlock('```ui\n{"type":"table","todo":true}\n```'), true, 'a to-do block');
  assert.equal(hasAskBlock('```app title="Take" todo=true\n<button>Done</button>\n```'), true);
  assert.equal(hasAskBlock('```ui\nnot json\n```'), false);
});

test('order: move an item to an index (clamped), unknown ids leave the order; a one-line preview', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  assert.deepEqual(moveItem(items, 'd', 0).map((item) => item.id), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(items, 'a', 2).map((item) => item.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(items, 'b', 99).map((item) => item.id), ['a', 'c', 'd', 'b']);
  assert.deepEqual(moveItem(items, 'x', 0).map((item) => item.id), ['a', 'b', 'c', 'd']);
  assert.equal(promptPreview('\n\n  Update   the\tchangelog  \nsecond line'), 'Update the changelog');
  assert.equal(promptPreview('x'.repeat(200), 10), `${'x'.repeat(9)}…`);
});

test('send mode: the default while something works or waits, the other one with Ctrl; always now when nothing does', () => {
  assert.equal(sendMode({ busy: false, queued: 0, other: false, preferred: 'queue' }), 'now', 'nothing at work: it goes now');
  assert.equal(sendMode({ busy: false, queued: 0, other: true, preferred: 'queue' }), 'now');
  assert.equal(sendMode({ busy: true, queued: 0, other: false }), 'now', 'the default default: now, as Send always did');
  assert.equal(sendMode({ busy: true, queued: 0, other: true }), 'queue');
  assert.equal(sendMode({ busy: true, queued: 0, other: false, preferred: 'queue' }), 'queue');
  assert.equal(sendMode({ busy: true, queued: 0, other: true, preferred: 'queue' }), 'now');
  assert.equal(sendMode({ busy: false, queued: 2, other: false, preferred: 'queue' }), 'queue', 'behind the ones waiting');
});

test('the list: where a dragged row lands, and why a paused queue waits', () => {
  const mids = [10, 40, 70, 100];
  assert.equal(dropIndex(mids, 0, 0), 0);
  assert.equal(dropIndex(mids, 0, 65), 2, 'dragged below the third row');
  assert.equal(dropIndex(mids, 3, -95), 0, 'the last row to the top');
  assert.equal(dropIndex(mids, 1, 5), 1, 'a small move stays');
  assert.equal(pausedText({}), undefined);
  assert.equal(pausedText({ paused: { reason: 'ask', at: 1 } }), 'Paused – an agent asked you something');
  assert.equal(pausedText({ paused: { reason: 'stop', at: 1 } }), 'Paused after Stop');
});
