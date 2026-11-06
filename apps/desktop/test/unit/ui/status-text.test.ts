// A quiet status line's words in the chat (src/ui/chat/status-text.ts, C3 fix): a call cut off by a stop or a
// restart reads in the run line's words – never the raw tool name next to its own human verb ("bash – Ran a
// command"); the stored line keeps the name for the agents' history. Any other line shows as written.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../src/shared/model/chat.ts';
import { statusText } from '../../../src/ui/chat/status-text.ts';

const line = (text: string, details?: Record<string, unknown>) =>
  ({ body: text, meta: { status: { type: 'note', text, ...(details ? { details } : {}) } } }) as unknown as Pick<Message, 'body' | 'meta'>;
const cut = (text: string) => statusText(line(text, { unknownEffect: true, runId: 'r1' }));

test('statusText: a cut-off call in the run line\'s words', () => {
  assert.equal(cut('Cut off by your stop: bash – Ran a command'), 'Cut off by your stop: Ran a command');
  assert.equal(cut('Cut off by a restart: bash'), 'Cut off by a restart: Ran a command');
  assert.equal(cut('Cut off by a restart: bash – {"command":"git push"}'), 'Cut off by a restart: Ran git push');
  assert.equal(cut('Cut off by a restart: browser.act – click Pay 12 EUR (domains.example)'), 'Cut off by a restart: click Pay 12 EUR (domains.example)');
  assert.equal(cut('Cut off by your stop: browser.show'), 'Cut off by your stop: Showed a page');
});

test('statusText: any other line as written', () => {
  assert.equal(statusText(line('Cut off by your stop: bash – Ran a command')), 'Cut off by your stop: bash – Ran a command', 'not marked as a cut-off call');
  assert.equal(statusText(line('Mira joined')), 'Mira joined');
  assert.equal(statusText({ body: 'plain', meta: {} } as unknown as Pick<Message, 'body' | 'meta'>), 'plain');
});
