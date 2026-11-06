// B-050 K2: the title each viewer sees (shared/text/chat-names.ts displayTitle, counterpartId) –
// a two-member room is named after the other member, the default 1:1 by that name alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatName, counterpartId, displayTitle, onlyNames } from '../../../src/shared/text/chat-names.ts';

const NAMES: Record<string, string> = { human: 'Karin', ag_tom: 'Tom', ag_mara: 'Mara', per_anna000000: 'Anna Berg' };
const nameOf = (id: string): string | undefined => NAMES[id];
const members = (...ids: string[]) => ids.map((memberId) => ({ memberId }));
const chat = (title: string, direct?: boolean) => ({ title, titleNamed: Boolean(title), settings: direct === undefined ? {} : { direct } });

test('counterpartId: the other member of exactly two, seen by one of them', () => {
  assert.equal(counterpartId(members('human', 'ag_tom'), 'human'), 'ag_tom');
  assert.equal(counterpartId(members('human', 'ag_tom'), 'ag_tom'), 'human');
  assert.equal(counterpartId(members('ag_tom', 'ag_mara'), 'human'), undefined);
  assert.equal(counterpartId(members('human', 'ag_tom', 'ag_mara'), 'human'), undefined);
  assert.equal(counterpartId(members('human'), 'human'), undefined);
});

test('default 1:1: only the other member\'s name, for each side; the stored title only as fallback', () => {
  const direct = chat('Can you check the invoice?', true);
  assert.equal(displayTitle(direct, members('human', 'ag_tom'), 'human', nameOf), 'Tom');
  assert.equal(displayTitle(direct, members('human', 'ag_tom'), 'ag_tom', nameOf), 'Karin');
  assert.equal(displayTitle(chat('', true), members('ag_tom', 'per_anna000000'), 'per_anna000000', nameOf), 'Tom');
  assert.equal(displayTitle(direct, members('human', 'ag_gone'), 'human', nameOf), 'Can you check the invoice?');
  assert.equal(displayTitle(chat('', true), members('human', 'ag_gone'), 'human', nameOf), '');
});

test('other two-member rooms: "Name · title" when titled, the name alone otherwise', () => {
  assert.equal(displayTitle(chat('Video editing'), members('human', 'ag_tom'), 'human', nameOf), 'Tom · Video editing');
  assert.equal(displayTitle(chat('  Video editing '), members('human', 'ag_tom'), 'ag_tom', nameOf), 'Karin · Video editing');
  assert.equal(displayTitle(chat(''), members('human', 'ag_tom'), 'human', nameOf), 'Tom');
  assert.equal(displayTitle(chat('Tom'), members('human', 'ag_tom'), 'human', nameOf), 'Tom', 'an old auto title that repeats the name');
  assert.equal(displayTitle(chat('Video editing'), members('human', 'ag_gone'), 'human', nameOf), 'Video editing');
});

test('a pair the viewer is not in: the title, else both names', () => {
  assert.equal(displayTitle(chat('', true), members('ag_tom', 'ag_mara'), 'human', nameOf), 'Tom & Mara');
  assert.equal(displayTitle(chat('Hand-off'), members('ag_tom', 'ag_mara'), 'human', nameOf), 'Hand-off');
  assert.equal(displayTitle(chat(''), members('ag_tom', 'ag_gone'), 'human', nameOf), 'Tom');
});

test('groups: the title, else the other members\' names; never undefined', () => {
  assert.equal(displayTitle(chat('Launch'), members('human', 'ag_tom', 'ag_mara'), 'human', nameOf), 'Launch');
  assert.equal(displayTitle(chat(''), members('human', 'ag_tom', 'ag_mara'), 'human', nameOf), 'Tom, Mara');
  assert.equal(displayTitle(chat(''), members('human', 'ag_tom', 'ag_mara'), 'ag_tom', nameOf), 'Karin, Mara');
  assert.equal(displayTitle(chat(''), members('human'), 'human', nameOf), '');
  assert.equal(displayTitle(chat(''), [], 'human', nameOf), '');
  assert.equal(displayTitle({ title: '', titleNamed: false }, members('human', 'ag_gone', 'ag_x'), 'human', nameOf), '');
});

test('two members whose title only lists their names: no topic for either side (an agent never reads its own name as the topic)', () => {
  assert.equal(displayTitle(chat('Tom'), members('human', 'ag_tom'), 'ag_tom', nameOf), 'Karin', 'auto title of a chat an agent made with the owner');
  assert.equal(displayTitle(chat('Tom, Mara'), members('ag_tom', 'ag_mara'), 'ag_tom', nameOf), 'Mara');
  assert.equal(displayTitle(chat('Tom, Mara'), members('ag_tom', 'ag_mara'), 'human', nameOf), 'Tom & Mara');
  assert.equal(displayTitle(chat('Tom, Mara'), members('human', 'ag_tom', 'ag_mara'), 'ag_mara', nameOf), 'Tom, Mara', 'a group keeps its stored title (K2)');
  assert.equal(displayTitle(chat('Tom, Video'), members('human', 'ag_tom'), 'human', nameOf), 'Tom · Tom, Video', 'a topic stays');
  assert.equal(onlyNames('Tom, Mara', ['Tom', 'Mara']), true);
  assert.equal(onlyNames('', ['Tom']), false);
  assert.equal(onlyNames('Tom,', ['Tom']), false);
});

test('a default 1:1 others joined (K1): the names of the others, never its stored title', () => {
  const direct = chat('Can you check the invoice?', true);
  assert.equal(displayTitle(direct, members('human', 'ag_tom', 'ag_mara'), 'human', nameOf), 'Tom, Mara');
  assert.equal(displayTitle(direct, members('human', 'ag_tom', 'ag_mara'), 'ag_mara', nameOf), 'Karin, Tom');
  assert.equal(displayTitle(direct, members('human', 'ag_gone', 'ag_x'), 'human', nameOf), 'Can you check the invoice?', 'no name known: the stored title');
});

test('chatName stays for its callers', () => {
  assert.equal(chatName('', false, ['Tom', 'Mara']), 'Tom, Mara');
  assert.equal(chatName('Launch', true, ['Tom']), 'Launch');
});
