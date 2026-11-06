// B-044 integration: a composer fill ("/task " from the palette's New task in this chat and the task
// panel's Task – ui/lib/shell-state.ts composerFill) goes only into an empty composer; the person's
// draft is never overwritten (the composer then takes the focus and says COMPOSER_BUSY).
// Owns: these assertions only. Never: renders the composer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COMPOSER_BUSY, composerFillText } from '../../../src/ui/lib/shell-state.ts';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');

test('a fill goes only into an empty composer; a draft stays as it is', () => {
  assert.equal(composerFillText('', '/task '), '/task ');
  assert.equal(composerFillText('  \n', '/task '), '/task ', 'only white space counts as empty');
  assert.equal(composerFillText('/task ', '/task '), '/task ', 'the same fill twice changes nothing');
  assert.equal(composerFillText('Please book the venue', '/task '), null, 'the draft is left untouched');
  assert.equal(composerFillText('/task Book the venue', '/task '), null);
  assert.equal(COMPOSER_BUSY, 'Finish or clear your message first');
});

test('the composer applies the rule and toasts instead of replacing; no filler asks to replace', () => {
  const composer = readFileSync(path.join(UI, 'chat', 'Composer.tsx'), 'utf8');
  assert.match(composer, /composerFillText\(text, fill\.text\)/);
  assert.match(composer, /pushToast\(\{ title: COMPOSER_BUSY/);
  for (const file of [path.join('shell', 'CommandPalette.tsx')]) {
    const source = readFileSync(path.join(UI, file), 'utf8');
    assert.match(source, /composerFill\.value = \{ conversationId(?:: chatId)?, text: '\/task ' \}/, file);
    assert.doesNotMatch(source, /mode: '(?:replace|append)'/, file);
  }
});
