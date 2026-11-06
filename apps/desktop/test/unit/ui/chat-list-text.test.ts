// The chat list's texts (B-044 visual pass): a row's preview never ends in a bare "Mira:" (row-preview.ts),
// previews and message-search hits show text as written – escapes resolved, underscores inside words
// kept (lib/format.ts plainPreview) – and the searched words are found for marking (lib/mark-ranges.ts).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import { plainPreview } from '../../../src/ui/lib/format.ts';
import { markRanges } from '../../../src/ui/lib/mark-ranges.ts';
import { rowPreview } from '../../../src/ui/chat/row-preview.ts';
import { hitSnippet } from '../../../src/ui/chat/search-snippet.ts';

test('plainPreview: escapes resolved, underscores inside words kept, markup around words stripped', () => {
  assert.equal(plainPreview('Done the task. \\[18:21] Sam Keller: [task task_1m5z62] Approve'), 'Done the task. [18:21] Sam Keller: [task task_1m5z62] Approve');
  assert.equal(plainPreview('**Bold** and _italic_ and *this* – `code`'), 'Bold and italic and this – code');
  assert.equal(plainPreview('# Heading\n> quote\n* item with snake_case_name'), 'Heading quote item with snake_case_name');
  assert.equal(plainPreview('See [the plan](https://example.com) ![img](a.png)'), 'See the plan');
  assert.equal(plainPreview('a \\* b and 5 * 3'), 'a * b and 5 * 3', 'an escaped or lone asterisk is text');
  assert.equal(plainPreview('```js\nconst x = 1;\n```\nafter'), 'after');
  assert.equal(plainPreview('x'.repeat(10), 5), 'xxxx…');
});

const NAMES: Record<string, string> = { ag_mira: 'Mira', ag_ava: 'Ava' };
const nameOf = (id: string) => NAMES[id];

function chat(over: Partial<ConversationSummary>): ConversationSummary {
  const members = ['human', 'ag_mira', 'ag_ava'].map((memberId) => ({ memberId, kind: memberId === 'human' ? 'human' : 'agent' }));
  return { id: 'c1', title: 'Launch', members, working: [], lastPreview: undefined, ...over } as unknown as ConversationSummary;
}

test('rowPreview: the sender in groups, never a bare "Name:" for a message without text yet', () => {
  assert.equal(rowPreview(chat({ lastPreview: { text: 'Draft is **ready**', authorId: 'ag_mira', at: 1 } as never }), nameOf), 'Mira: Draft is ready');
  assert.equal(rowPreview(chat({ lastPreview: { text: 'ok', authorId: 'human', at: 1 } as never }), nameOf), 'You: ok');
  assert.equal(rowPreview(chat({ lastPreview: { text: '', authorId: 'ag_mira', at: 1 } as never, working: ['ag_mira'] }), nameOf), 'Mira is working…');
  assert.equal(rowPreview(chat({ lastPreview: { text: '', authorId: 'ag_mira', at: 1 } as never }), nameOf), '', 'done without text: an empty line, no "Mira:"');
  assert.equal(rowPreview(chat({ draft: 'my _draft_' }), nameOf), 'Draft: my draft');
});

test('rowPreview: while agents work on a message without text, the chat header\'s live line (one source for who works)', () => {
  const live = () => 'Ava: running a command, Mira: running a command';
  const working = chat({ lastPreview: { text: '', authorId: 'ag_mira', at: 1 } as never, working: ['ag_mira', 'ag_ava'] });
  assert.equal(rowPreview(working, nameOf, live), 'Ava: running a command, Mira: running a command');
  assert.equal(rowPreview(working, nameOf, () => ''), 'Mira is working…', 'no live line yet: the writer');
  assert.equal(rowPreview(chat({ lastPreview: { text: '', authorId: 'ag_mira', at: 1 } as never }), nameOf, live), '', 'nobody works: no live line');
  assert.equal(rowPreview(chat({ lastPreview: { text: 'ok', authorId: 'ag_ava', at: 1 } as never, working: ['ag_ava'] }), nameOf, live), 'Ava: ok', 'a message with text stays the preview');
});

test('markRanges: every query word (2+ characters, any case), merged and in order', () => {
  assert.deepEqual(markRanges('Launch plan for the launch', 'launch'), [[0, 6], [20, 26]]);
  assert.deepEqual(markRanges('Launch plan', 'LA pl'), [[0, 2], [7, 9]], 'a word start wins: "la" only in "Launch", not also inside "plan"');
  assert.deepEqual(markRanges('Replan', 'plan'), [[2, 6]], 'found only inside a word: marked there');
  assert.deepEqual(markRanges('abcd', 'abc bcd'), [[0, 4]], 'overlapping hits are one mark');
  assert.deepEqual(markRanges('Launch', 'l'), [], 'one letter marks nothing');
  assert.deepEqual(markRanges('', 'launch'), []);
});

test('hitSnippet: a long message shows its first match near the start of the hit, never only its opening', () => {
  const body = 'Done the task. [20:07] Sam Keller: [task task_1m5zc5amjjs0kb0df] Approve the date \\· Ava: we can launch on Monday';
  const text = hitSnippet(body, 'launch', 'fallback');
  assert.match(text, /^…\S/, 'cut at a word boundary, marked as cut');
  assert.ok(text.indexOf('launch') <= 26, text);
  assert.deepEqual(markRanges(text, 'launch').length, 1);
  assert.equal(hitSnippet('launch it', 'launch', 'fallback'), 'launch it', 'an early match: the text from its start');
  assert.equal(hitSnippet('Ünïcode', 'unicode', '…Ünïcode…'), '…Ünïcode…', 'no visible match: the runtime snippet');
  assert.ok(hitSnippet(`${'word '.repeat(80)}launch`, 'launch', '').length <= 160);
});
