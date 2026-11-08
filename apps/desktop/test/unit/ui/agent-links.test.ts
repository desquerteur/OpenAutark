// AF-017: agent names in message text become links to the agent (src/ui/agents/agent-links.ts) – plain names as
// written, @mentions in any case, the longest name first, and never inside code, links, URLs or other words.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAgentLinker, splitAgentNames } from '../../../src/ui/agents/agent-links.ts';

const AGENTS = [{ id: 'mk', name: 'Making' }, { id: 'an', name: 'Ana' }, { id: 'ab', name: 'Anabel' }, { id: 'x', name: 'X' }];
const link = makeAgentLinker(AGENTS);

test('a plain name as written and an @mention become links to the agent page', () => {
  assert.equal(link('I hired Making for this.'), 'I hired [Making](#/team/mk) for this.');
  assert.equal(link('@Making, please start.'), '[@Making](#/team/mk), please start.');
  assert.equal(link('ask @making'), 'ask [@making](#/team/mk)');
  assert.equal(link('**Making** is on it'), '**[Making](#/team/mk)** is on it');
  assert.equal(link("Making's plan"), "[Making](#/team/mk)'s plan");
});

test('a lower-case plain word is no name; parts of words, e-mails and hyphenated words stay text', () => {
  assert.equal(link('making progress'), 'making progress');
  assert.equal(link('Makings and Remaking'), 'Makings and Remaking');
  assert.equal(link('mail ops@Making.io'), 'mail ops@Making.io');
  assert.equal(link('Re-Making'), 'Re-Making');
});

test('the longest name wins and one-letter names are never linked', () => {
  assert.equal(link('Anabel and Ana'), '[Anabel](#/team/ab) and [Ana](#/team/an)');
  assert.equal(link('Plan X'), 'Plan X');
});

test('code spans, fenced-free inline code over lines, links, images, autolinks, URLs and indented code stay as they are', () => {
  assert.equal(link('run `Making --fast` now'), 'run `Making --fast` now');
  assert.equal(link('a ``Making\nAna`` b Ana'), 'a ``Making\nAna`` b [Ana](#/team/an)');
  assert.equal(link('see [Making](https://example.com) and Ana'), 'see [Making](https://example.com) and [Ana](#/team/an)');
  assert.equal(link('![Making](data:image/png;base64,AA)'), '![Making](data:image/png;base64,AA)');
  assert.equal(link('<https://making.dev/Making>'), '<https://making.dev/Making>');
  assert.equal(link('https://example.com/Making/x'), 'https://example.com/Making/x');
  assert.equal(link('    Making = 1'), '    Making = 1');
});

test('several lines keep their breaks; no agents or empty text change nothing', () => {
  assert.equal(link('Hi\n\n- Making\n- Ana'), 'Hi\n\n- [Making](#/team/mk)\n- [Ana](#/team/an)');
  assert.equal(makeAgentLinker([])('Making'), 'Making');
  assert.equal(link(''), '');
});

test('names with link characters are escaped in the link text', () => {
  assert.equal(makeAgentLinker([{ id: 'q', name: 'Bo]b' }])('ask @Bo]b'), 'ask [@Bo\\]b](#/team/q)');
});

test('splitAgentNames marks the names in plain text (a chat row title, a tree row)', () => {
  assert.deepEqual(splitAgentNames('Manager · Making', [{ id: 'mg', name: 'Manager' }, { id: 'mk', name: 'Making' }]), [
    { text: 'Manager', agentId: 'mg' }, { text: ' · ' }, { text: 'Making', agentId: 'mk' },
  ]);
  assert.deepEqual(splitAgentNames('Launch plan', AGENTS), [{ text: 'Launch plan' }]);
  assert.deepEqual(splitAgentNames('', AGENTS), [{ text: '' }]);
});
