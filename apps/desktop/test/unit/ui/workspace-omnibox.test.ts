// The address field's suggestions (ui/workspace/omnibox.ts): what Enter opens first (the address, or a Google search for
// words; a known host for one word that starts it), then open tabs and history holding every typed word, best first (host
// start > part / title word start > anywhere > path; frecency lifts frequent and recent pages; an open tab a little), each
// address once, at most eight rows, no "switch" to the field's own tab; the shortcuts' tab choice in strip order.
// Owns: these assertions. Never: a DOM, a bridge or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_URL, type HistoryEntry } from '../../../src/shared/api/workspace-browser.ts';
import { SUGGESTIONS_MAX, matchScore, rankSuggestions, typedSuggestion } from '../../../src/ui/workspace/omnibox.ts';
import { tabFor } from '../../../src/ui/workspace/browser-model.ts';

const NOW = 10 * 86_400_000;
const entry = (url: string, title: string, visits = 1, daysAgo = 0): HistoryEntry => ({ url, title, visits, at: NOW - daysAgo * 86_400_000 });

test('the typed row: an address opens, words search Google, a refused address has no row', () => {
  assert.deepEqual(typedSuggestion('example.com'), { kind: 'go', url: 'https://example.com', title: 'https://example.com' });
  assert.deepEqual(typedSuggestion('best pizza'), { kind: 'search', url: `${SEARCH_URL}best+pizza`, title: 'best pizza' });
  assert.equal(typedSuggestion('javascript:alert(1)'), undefined);
  assert.equal(typedSuggestion('  '), undefined);
});

test('matchScore: every word must match; the host start counts most', () => {
  assert.equal(matchScore(['git'], 'https://github.com/', 'GitHub'), 6);
  assert.equal(matchScore(['git'], 'https://www.github.com/', ''), 6, 'www. aside');
  assert.equal(matchScore(['docs'], 'https://api.docs.test/', ''), 3, 'the start of a part of the host');
  assert.equal(matchScore(['started'], 'https://a.test/', 'Getting started'), 3, 'the start of a title word');
  assert.equal(matchScore(['tart'], 'https://a.test/', 'Getting started'), 1.5, 'inside the title');
  assert.equal(matchScore(['cart'], 'https://shop.test/cart', ''), 1, 'the path');
  assert.equal(matchScore(['git', 'zzz'], 'https://github.com/', 'GitHub'), 0, 'one word missing: no match');
});

test('ranking: typed row first, then tabs and history by score and frecency; each address once; at most eight', () => {
  const history = [
    entry('https://news.test/world', 'World news', 1, 9),
    entry('https://news.test/sports', 'Sports news', 12, 0),
    entry('https://other.test/', 'Other', 50, 0),
  ];
  const rows = rankSuggestions('news', history, [], NOW);
  assert.equal(rows[0]!.kind, 'history', 'one word that starts a known host goes first (Enter opens it, as in Chrome)');
  assert.equal(rows[0]!.url, 'https://news.test/sports', 'the frequent, recent one');
  assert.equal(rows[1]!.kind, 'search', 'then what typing it means');
  assert.deepEqual(rows.slice(2).map((row) => row.url), ['https://news.test/world']);
  const words = rankSuggestions('world news', history, [], NOW);
  assert.deepEqual(words.map((row) => row.kind), ['search', 'history'], 'several words: the search first');
  const tabs = [{ id: 'web-1', url: 'https://news.test/sports', title: 'Sports news' }, { id: 'web-me', url: 'https://news.test/world', title: 'World news' }];
  const withTabs = rankSuggestions('sports', history, tabs, NOW, 'web-me');
  assert.deepEqual(withTabs.map((row) => [row.kind, row.tabId ?? row.url]), [['search', `${SEARCH_URL}sports`], ['tab', 'web-1']],
    'an open tab instead of its history row (with its frecency); never a switch to the field\'s own tab');
  const many = Array.from({ length: 20 }, (_, index) => entry(`https://site${index}.test/`, `Site ${index}`));
  assert.equal(rankSuggestions('site', many, [], NOW).length, SUGGESTIONS_MAX);
  const exact = rankSuggestions('news.test/sports', [entry('https://news.test/sports', 'Sports')], [], NOW);
  assert.deepEqual(exact.map((row) => row.kind), ['go'], 'an address: the typed row – its history row is the same address');
  assert.deepEqual(rankSuggestions('', history, [], NOW), []);
});

test('Ctrl+Tab and Ctrl+1…9 go along the tabs in strip order (Ctrl+9 the last)', () => {
  const order = ['web-a', 'web-b', 'web-c'];
  assert.equal(tabFor('next-tab', order, 'web-a'), 'web-b');
  assert.equal(tabFor('next-tab', order, 'web-c'), 'web-a', 'round');
  assert.equal(tabFor('previous-tab', order, 'web-a'), 'web-c');
  assert.equal(tabFor('next-tab', order, 'work'), 'web-a', 'from a tab not in the list: the first');
  assert.equal(tabFor('previous-tab', order, 'work'), 'web-c');
  assert.equal(tabFor('tab-2', order, 'web-a'), 'web-b');
  assert.equal(tabFor('tab-5', order, 'web-a'), undefined, 'no fifth tab: stay');
  assert.equal(tabFor('tab-9', order, 'web-a'), 'web-c');
  assert.equal(tabFor('next-tab', [], 'web-a'), undefined);
});
