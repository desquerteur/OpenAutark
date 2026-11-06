// The person's browser history (main/workspace-history.ts): only addresses the kept-address
// rule leaves unchanged – no user info, no token-like query or fragment, no credential link, no JWT
// or long opaque path segment, only http(s); one entry per address (newest title, last visit, count),
// newest first, every word of a search in title or address; at most MAX_HISTORY (the oldest goes);
// writes bundled behind one trailing timer, at once on Clear history and on flush; an unreadable or
// foreign file is read entry by entry.
// Owns: these assertions. Never: Electron, a real profile or a real timer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHistory, MAX_HISTORY, historyAddress, readHistory, type HistoryTimers } from '../../../src/main/workspace-history.ts';
import type { TabFiles } from '../../../src/main/workspace-tabs.ts';

function memory(initial?: string): TabFiles & { text?: string; writes: number } {
  const files = { text: initial, writes: 0, read: () => files.text, write: (_file: string, text: string) => { files.text = text; files.writes++; } };
  return files;
}

function manualTimers(): HistoryTimers & { run(): void; pending: number } {
  let queued: Array<() => void> = [];
  return {
    set: (run) => { queued.push(run); return queued.length; },
    clear: () => { queued = []; },
    run: () => { const now = queued; queued = []; for (const run of now) run(); },
    get pending() { return queued.length; },
  };
}

test('history keeps no address with a credential or token in it', () => {
  assert.equal(historyAddress('https://example.com/docs?page=2#intro'), 'https://example.com/docs?page=2#intro');
  assert.equal(historyAddress('https://Example.com'), 'https://example.com/', 'normalised');
  for (const secret of [
    'https://ann:pw@example.com/a', 'https://app.example.com/home?code=abc&state=xyz', 'https://example.com/#access_token=abc',
    'https://example.com/reset-password/abc', 'https://example.com/auth/callback', 'https://example.com/magic-link/xyz',
    `https://example.com/d/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc`, `https://example.com/f/${'a1'.repeat(40)}`,
    'https://example.com/?session=1', 'file:///C:/secret.txt', 'javascript:alert(1)', 'not a url',
  ]) assert.equal(historyAddress(secret), undefined, secret);
});

test('visits: one entry per address, newest first, title kept, count grows; tokens never written', () => {
  let now = 1000;
  const files = memory();
  const timers = manualTimers();
  const history = new BrowserHistory({ file: 'h.json', files, timers, now: () => now });
  history.visit('https://a.test/one');
  history.title('https://a.test/one', 'One');
  now = 2000; history.visit('https://b.test/two', 'Two');
  now = 3000; history.visit('https://a.test/one');
  history.visit('https://a.test/callback?code=secret&state=s');
  history.title('https://a.test/callback?code=secret&state=s', 'Signing in');
  assert.deepEqual(history.search().map((entry) => [entry.url, entry.title, entry.visits, entry.at]), [
    ['https://a.test/one', 'One', 2, 3000], ['https://b.test/two', 'Two', 1, 2000],
  ]);
  assert.equal(files.writes, 0, 'nothing written before the timer');
  assert.equal(timers.pending, 1, 'one trailing timer for every change');
  timers.run();
  assert.equal(files.writes, 1);
  assert.ok(!files.text!.includes('secret') && !files.text!.includes('Signing in'), 'the skipped address left nothing');
  const again = new BrowserHistory({ file: 'h.json', files: memory(files.text), timers: manualTimers() });
  assert.deepEqual(again.search().map((entry) => entry.url), ['https://a.test/one', 'https://b.test/two'], 'read back in order');
});

test('search: every word in the title or the address, newest first, limited', () => {
  let now = 0;
  const history = new BrowserHistory({ timers: manualTimers(), now: () => ++now });
  history.visit('https://docs.example.com/guide', 'Getting started guide');
  history.visit('https://shop.example.com/cart', 'Your cart');
  history.visit('https://news.test/', 'News');
  assert.deepEqual(history.search('example').map((entry) => entry.title), ['Your cart', 'Getting started guide']);
  assert.deepEqual(history.search('GUIDE docs').map((entry) => entry.title), ['Getting started guide'], 'all words, any case');
  assert.deepEqual(history.search('cart news'), [], 'every word must match');
  assert.equal(history.search('', 2).length, 2);
});

test('at most MAX_HISTORY addresses: the oldest goes; Clear history writes at once; flush writes a pending change', () => {
  const files = memory();
  const timers = manualTimers();
  let now = 0;
  const history = new BrowserHistory({ file: 'h.json', files, timers, now: () => ++now });
  for (let index = 0; index <= MAX_HISTORY; index++) history.visit(`https://site${index}.test/`);
  assert.equal(history.size, MAX_HISTORY);
  assert.equal(history.search('site0.test').length, 0, 'the oldest address went');
  history.flush();
  assert.equal(files.writes, 1, 'flush writes the pending change');
  assert.equal(timers.pending, 0, 'and its timer is gone');
  history.flush();
  assert.equal(files.writes, 1, 'nothing pending: nothing written');
  history.clear();
  assert.equal(history.size, 0);
  assert.equal(files.writes, 2);
  assert.deepEqual(JSON.parse(files.text!).entries, []);
});

test('a saved file is read entry by entry (unreadable or not keepable entries left out)', () => {
  assert.deepEqual(readHistory('not json'), []);
  assert.deepEqual(readHistory(JSON.stringify({ entries: 'x' })), []);
  const read = readHistory(JSON.stringify({ entries: [
    { url: 'https://ok.test/', title: 'Ok', at: 5, visits: 2 },
    { url: 'https://ok.test/?token=abc', title: 'Token', at: 6, visits: 1 },
    { url: 'https://late.test/', at: 9 },
    { url: 42, at: 1 }, { url: 'https://no-time.test/' },
  ] }));
  assert.deepEqual(read, [
    { url: 'https://ok.test/', title: 'Ok', at: 5, visits: 2 },
    { url: 'https://late.test/', title: '', at: 9, visits: 1 },
  ]);
});
