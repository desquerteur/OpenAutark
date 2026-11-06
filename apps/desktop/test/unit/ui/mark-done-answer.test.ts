// "Mark done" on a mini-app to-do (HumanItem.tsx, wave-8 F06 leftover): the answer it sends is
// told apart from a real wf.complete result in the person's line (B-076: the agent reads that line too).
// The answer is read from HumanItem.tsx's source (a .tsx file the node test runner cannot
// import), so a change there – `manual` dropped, another note – fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerText, oneLine } from '../../../src/shared/blocks/answer-text.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const item = readFileSync(path.join(root, 'src/ui/tasks/HumanItem.tsx'), 'utf8');

/** HumanItem.tsx's MARKED_DONE_ANSWER object literal, parsed as JSON (quoted strings, bare keys). */
function markedDoneAnswer(): Record<string, unknown> {
  const literal = item.match(/const MARKED_DONE_ANSWER = (\{[^}]*\})/)?.[1];
  assert.ok(literal, 'HumanItem.tsx declares MARKED_DONE_ANSWER');
  const json = literal
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_match, text: string) => JSON.stringify(text.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
  return JSON.parse(json) as Record<string, unknown>;
}

test('a hand-marked mini-app to-do says so in the person\'s line', () => {
  const answer = markedDoneAnswer();
  assert.deepEqual(answer, { done: true, manual: true, note: 'Marked done by hand (not finished in the app)' });
  assert.match(item, /rpc\.call\('tasks\.complete', \{ id: task\.id, answer: MARKED_DONE_ANSWER,/, '"Mark done" sends exactly that answer');

  const app = { type: 'app', app: 'counter' };
  assert.equal(answerText(app, answer), 'Marked done by hand (not finished in the app)', 'the agent sees that no app data came');
  assert.equal(answerText(app, { done: true }), 'Done in mini-app', 'a plain finish says nothing more');
  assert.equal(oneLine(answerText(app, { take: 2 })), 'Done in mini-app · take: 2');
});
