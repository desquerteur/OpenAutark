// Where a tab is scrolled to (src/ui/workspace/view-sync.ts, B-076): a burst of scrolling sends its first value at once
// and then at most one – the newest – every VIEW_MS, per tab, and the last value always goes; a spot is the fraction
// of the height plus the top line, and a received spot scrolls by the line when both show the same text, else by the
// fraction; a value from elsewhere waits while the person's own input here is younger than LOCAL_MS; the runtime's last
// values, arriving after the first view opened, move that view (tabs.positions).
// Owns: these assertions only. Never: a DOM or a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TabPosition } from '../../../src/shared/api/methods-tabs.ts';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';
import { Gather, listen, LOCAL_MS, spotOf, start, takesRemote, topOf, VIEW_MS } from '../../../src/ui/workspace/view-sync.ts';

test('a burst of scrolling: the first value at once, then the newest every VIEW_MS, the last one always', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Array<[string, number]> = [];
  const gather = new Gather<number>((key, value) => sent.push([key, value]));
  assert.equal(VIEW_MS, 300);
  gather.put('file:/a', 1);
  assert.deepEqual(sent, [['file:/a', 1]], 'the first goes at once');
  for (let value = 2; value <= 9; value++) { t.mock.timers.tick(40); gather.put('file:/a', value); } // 320 ms of scrolling
  gather.put('folder:/b', 1);
  assert.deepEqual(sent.map(([key, value]) => `${key}=${value}`), ['file:/a=1', 'file:/a=8', 'folder:/b=1'], 'one more after 300 ms (its newest); another tab on its own');
  t.mock.timers.tick(300);
  assert.deepEqual(sent.map(([key, value]) => `${key}=${value}`), ['file:/a=1', 'file:/a=8', 'folder:/b=1', 'file:/a=9'], 'the last value goes');
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 4, 'and nothing after it');
  gather.put('file:/a', 10);
  assert.equal(sent.length, 5, 'a new burst starts at once');
});

test('a spot is the fraction and the top line; a received one scrolls by the line for the same text, else by the fraction', () => {
  assert.deepEqual(spotOf(0, 1000, 400), { fraction: 0 });
  assert.deepEqual(spotOf(300, 1000, 400), { fraction: 0.5 });
  assert.deepEqual(spotOf(300, 1000, 400, 20), { fraction: 0.5, line: 16 }, 'line 16 is at the top (1-based)');
  assert.deepEqual(spotOf(0, 300, 400), { fraction: 0 }, 'nothing to scroll');
  assert.equal(topOf({ fraction: 0.5, line: 16 }, 2000, 400, 20), 300, 'by the line: the same text at another height');
  assert.equal(topOf({ fraction: 0.5, line: 16 }, 2000, 400), 800, 'by the fraction where the view shows no lines');
  assert.equal(topOf({ fraction: 0.5 }, 2000, 400, 20), 800);
  assert.equal(topOf({ fraction: 1, line: 500 }, 2000, 400, 20), 1600, 'never past the end');
});

test('the person\'s own input wins for LOCAL_MS', () => {
  assert.equal(LOCAL_MS, 1000);
  assert.equal(takesRemote(10_000, 10_500), false);
  assert.equal(takesRemote(10_000, 11_000), true);
  assert.equal(takesRemote(0, Date.now()), true, 'no input here yet');
});

test('the first view after a start moves once the runtime\'s last values arrive', async () => {
  const stored: TabPosition = { tab: 'file:/long.md', fraction: 0.8, line: 800, from: 'pc_window' };
  let answer: (list: TabPosition[]) => void = () => undefined;
  Object.assign(rpc, {
    call: (method: string) => (method === 'tabs.positions' ? new Promise<TabPosition[]>((resolve) => { answer = resolve; }) : Promise.resolve({ ok: true })),
    on: () => () => undefined,
    onOpen: () => () => undefined,
  });
  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] } as unknown as SessionInfo;
  assert.equal(start(), true);
  const heard: TabPosition[] = [];
  listen('file:/long.md', (position) => heard.push(position)); // the view is open; the list is still on its way
  answer([stored]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(heard, [stored], 'the open view goes where its tab was');
});
