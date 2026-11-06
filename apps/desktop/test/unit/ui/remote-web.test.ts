// B-076 on the UI side: the remote website tab's helpers (src/ui/workspace/remote-web.ts) – a tab on a PC is one feed
// key and back (no device: this PC), the same input failure is said once in a while – and the feed's pull loop with
// `retryMs` (browser-feed.ts): a PC that cannot be reached shows its reason, the loop asks again after the wait and the
// picture comes back by itself; without a view nothing is asked any more. Offline, a tap is dropped at once and never
// replayed after the reconnect (whileOpen). The view's wiring is read from its source (no DOM here): its picture never
// takes the keyboard by itself (BrowserSurface autoFocus false – only a click does), the pane's tab shortcuts stay the
// app's, its toolbar keeps the address row's cells in their places with the pane's menu cell last, the offline line
// stands in the picture's place while the connection is down, and the page's dialog lies over the picture.
// Owns: these assertions only. Never: a DOM, runtime or socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFLINE, remoteKey, remoteTarget, sayOnce, whileOpen } from '../../../src/ui/workspace/remote-web.ts';
import { createInputSender } from '../../../src/ui/workspace/browser-input.ts';
import type { BrowserInput } from '../../../src/shared/model/browser.ts';
import { createBrowserFeed, type FeedView } from '../../../src/ui/workspace/browser-feed.ts';
import type { SideFrame, SideViewState } from '../../../src/shared/model/side-view.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/workspace');
const source = (file: string) => readFileSync(path.join(WORKSPACE, file), 'utf8');

test('a tab on a PC is one feed key and back; an empty device is this PC', () => {
  assert.equal(remoteKey('dev_a', 'web-1'), 'dev_a|web-1');
  assert.deepEqual(remoteTarget(remoteKey('dev_a', 'web-1')), { device: 'dev_a', tab: 'web-1' });
  assert.deepEqual(remoteTarget(remoteKey('', 'web-1')), { tab: 'web-1' });
});

test('the same failure is said once per period, a different one at once', () => {
  let now = 0;
  const fresh = sayOnce(5000, () => now);
  assert.equal(fresh('The page did not take that input.'), true);
  now = 4000;
  assert.equal(fresh('The page did not take that input.'), false);
  assert.equal(fresh('There is no picture of this tab yet.'), true);
  now = 9500;
  assert.equal(fresh('There is no picture of this tab yet.'), true);
});

test('a failed pull shows its reason and is tried again after retryMs while the view stays', async () => {
  const state: SideViewState = { tab: 'web-1', pc: 'office-pc', open: true, live: true, url: 'https://a.example/', title: 'A', back: false, forward: false, loading: false, at: 1 };
  let calls = 0;
  let viewers = 0;
  const feed = createBrowserFeed<SideViewState, SideFrame>({
    subscribe: () => Promise.reject(new Error('pulled')), unsubscribe: async () => undefined,
    onState: () => () => {}, onFrame: () => () => {}, onOpen: () => () => {},
    errorText: (error) => (error as Error).message,
    pulls: () => true,
    pull: async () => {
      calls++;
      if (calls === 1) throw new Error('office-pc is not reachable (seen 2 min ago).');
      if (calls === 2) return { state, frame: { tab: 'web-1', data: 'JPEG', width: 1280, height: 800, at: 2 } };
      await wait(viewers ? 5 : 0);
      return { state };
    },
    pullPart: async () => ({ data: '' }),
    retryMs: 20,
  });
  const seen: Array<FeedView<SideViewState, SideFrame>> = [];
  viewers = 1;
  const off = feed.subscribe('dev_a|web-1', (view) => { seen.push(view); });
  await wait(5);
  assert.equal(seen.at(-1)?.error, 'office-pc is not reachable (seen 2 min ago).');
  await wait(40);
  assert.equal(seen.at(-1)?.error, null, 'the picture came back by itself');
  assert.equal(seen.at(-1)?.frame?.data, 'JPEG');
  viewers = 0;
  off();
  const after = calls;
  await wait(40);
  assert.ok(calls <= after + 1, 'without a view the loop ends');
});

test('offline, a tap is dropped at once and never replayed after the reconnect; online it goes to the page', async () => {
  let open = false;
  const sent: string[] = [];
  const failed: string[] = [];
  const send = whileOpen(() => open, async (tab: string, input: BrowserInput) => { sent.push(`${tab} ${input.kind}`); return { ok: true }; });
  const sender = createInputSender(send, (error) => { failed.push((error as Error).message); });
  const tap: BrowserInput = { kind: 'mouse', type: 'down', x: 10, y: 20, width: 400, height: 300, button: 'left', clicks: 1 };
  sender.push('web-1', tap);
  sender.push('web-1', { ...tap, type: 'up' });
  await wait(0);
  assert.deepEqual(failed, [OFFLINE], 'said once');
  assert.equal(sender.pending(), 0, 'nothing waits for the connection');
  open = true;
  await wait(0);
  assert.deepEqual(sent, [], 'nothing is replayed when it is back');
  sender.push('web-1', tap);
  await wait(0);
  assert.deepEqual(sent, ['web-1 mouse']);
});

test('the remote tab: no keyboard grab on a picture appearing, the address row\'s cells in their places, offline line, the page\'s dialog', () => {
  const tab = source('RemoteWebTab.tsx');
  const surface = source('BrowserSurface.tsx');
  assert.match(tab, /<BrowserSurface [^]*?autoFocus=\{false\} appKeys /, 'the picture appearing (a tab switch on the other PC, a recovery) never takes the keyboard');
  assert.match(surface, /if \(props\.autoFocus !== false\) surface\.current\?\.focus/, 'only a takeover that asks for it focuses on mount');
  assert.match(surface, /onMouseDown=\{\(event\) => \{\s*surface\.current\?\.focus/, 'a click on the picture brings the keyboard');
  assert.match(source('pane-shortcuts.ts'), /closest\('\.browser-touch:not\(\[data-app-keys\]\)'\)/, 'the pane\'s tab shortcuts stay the app\'s in a remote picture');
  const toolbar = /<div class="browser-live-toolbar">([^]*?)\n {6}<\/div>/.exec(tab)?.[1] ?? '';
  const order = ['label="Back"', 'label="Forward"', 'label="Reload"', 'class="remote-web-mark"', '<Address', 'browser-live-trail'].map((cell) => toolbar.indexOf(cell));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)), `Back, Forward, Reload first, the menu cell last: ${order.join(', ')}`);
  assert.match(source('WorkspacePane.tsx'), /<RemoteWebTab [^>]*trail=\{<PaneMenu id=\{entry\.id\} \/>\}/, 'the pane\'s menu cell (All tabs, History, Full view) is there');
  assert.match(tab, /rpc\.status\.value !== 'open' \? OFFLINE/, 'the offline line takes the picture\'s place while the connection is down');
  assert.match(tab, /send=\{send\}/);
  assert.match(tab, /const send = whileOpen\(\(\) => rpc\.status\.peek\(\) === 'open'/);
  assert.match(tab, /state\?\.dialog && <PageDialog [^>]*onAnswer=\{\(answer\) => go\(\{ dialog: answer \}\)\}/, 'the page\'s dialog is answered from here');
});
