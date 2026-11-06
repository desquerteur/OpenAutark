// The composer's Plus menu and the Send button's right-click menu (owner 04.11.2026: "warum sind die eigentlich fast immer
// ausgeblendet und ausgegraut?"): no entry is greyed out. With nothing to send, "Send as important" / "Send silently" set
// the draft's level like /important and /silent (a second pick sets it back, the tick shows it); with a draft they send
// at that level; in schedule mode they read "Schedule …". Task is always there – an empty field gets "/task ".
// Owns: these assertions only. Never: renders or calls a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageLevel } from '../../../src/shared/model/chat.ts';
import { sendMenuItems, type SendActions } from '../../../src/ui/chat/composer/slash.ts';
import { session } from '../../../src/ui/lib/session.ts';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const read = (file: string) => readFileSync(path.join(UI, file), 'utf8');

session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] };

/** The menu for a draft at `level`; `content`: there is something to send. Records what a pick did. */
function menu(level: MessageLevel, content: boolean, scheduling = false) {
  const done: string[] = [];
  const actions: SendActions = {
    level, setLevel: (next) => done.push(`level ${next}`), scheduling, schedule: () => done.push('schedule'),
    ...(content ? { sendAs: (next: MessageLevel) => done.push(`send ${next}`) } : {}),
  };
  const items = sendMenuItems(actions);
  const pick = (label: RegExp) => { items.find((item) => label.test(item.label))!.onSelect(); return done; };
  return { items, pick };
}

test('with nothing to send no entry is greyed out: the levels set the draft, a second pick sets it back', () => {
  const empty = menu('normal', false);
  assert.deepEqual(empty.items.map((item) => item.label), ['Send as important', 'Send silently', 'Schedule…']);
  assert.ok(empty.items.every((item) => !item.disabled), 'nothing disabled');
  assert.deepEqual(empty.pick(/important/), ['level important']);
  assert.deepEqual(menu('normal', false).pick(/silently/), ['level silent']);
  const important = menu('important', false);
  assert.deepEqual(important.items.map((item) => Boolean(item.checked)), [true, false, false], 'the tick shows the draft\'s level');
  assert.deepEqual(important.pick(/important/), ['level normal'], 'a second pick: back to normal');
  assert.deepEqual(menu('important', false).pick(/silently/), ['level silent']);
  assert.deepEqual(menu('normal', false).pick(/Schedule…/), ['schedule'], 'schedule mode opens with an empty field too');
});

test('with a draft the levels send at once; in schedule mode they schedule', () => {
  assert.deepEqual(menu('normal', true).pick(/important/), ['send important']);
  assert.deepEqual(menu('important', true).pick(/silently/), ['send silent']);
  const scheduling = menu('normal', false, true);
  assert.deepEqual(scheduling.items.map((item) => item.label), ['Schedule as important', 'Schedule silently', 'Schedule…']);
  assert.equal(scheduling.items[2].checked, true);
  assert.ok(scheduling.items.every((item) => !item.disabled), 'an unready schedule greys nothing out either');
  assert.deepEqual(scheduling.pick(/important/), ['level important']);
});

test('the Plus menu greys nothing out: Task is always there and fills "/task " into an empty field', () => {
  const plus = read('chat/composer/PlusMenu.tsx');
  const slash = read('chat/composer/slash.ts');
  assert.doesNotMatch(plus + slash, /disabled:/, 'no menu entry carries disabled');
  assert.match(plus, /\{ label: 'Task', onSelect: actions\.makeTask \}/);
  const composer = read('chat/Composer.tsx');
  assert.doesNotMatch(composer, /canMakeTask/);
  assert.match(composer, /if \(!body\) composerFill\.value = \{ conversationId: chat\.id, text: '\/task ' \}/);
  assert.match(composer, /level, setLevel: \(next: MessageLevel\) => updateDraft\(chat\.id, \{ level: next \}\)/);
});

test('Plus › Secret is the composer\'s secret mode above the text, no dialog', () => {
  const composer = read('chat/Composer.tsx');
  assert.match(composer, /\{secretOpen && <ChatSecretBar /);
  assert.doesNotMatch(composer, /SecretCapture|<Dialog/);
  const rows = read('settings/SecretRows.tsx');
  assert.doesNotMatch(rows, /<Dialog|from '\.\.\/lib\/dialog/);
  assert.doesNotMatch(read('settings/SecretsPage.tsx'), /<Dialog|SecretImport/);
});

test('a ticked level reads as ticked: rows with `checked` are menuitemcheckbox, and the arrow keys still reach them', () => {
  const popover = read('lib/popover.tsx');
  assert.match(popover, /role=\{item\.checked === undefined \? 'menuitem' : 'menuitemcheckbox'\}/);
  assert.match(popover, /aria-checked=\{item\.checked\}/);
  assert.equal(popover.match(/button\[role\^=menuitem\]:not\(:disabled\)/g)?.length, 2, 'focus-first and the arrow keys take both roles');
  assert.doesNotMatch(popover, /button\[role=menuitem\]/);
});
