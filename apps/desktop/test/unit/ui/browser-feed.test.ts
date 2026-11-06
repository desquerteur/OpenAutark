// MP8 agent browser feed (src/ui/workspace/browser-feed.ts): however many views show the same agent
// browser, browser.subscribe runs once and browser.unsubscribe when the last view goes; state and
// frames reach only the views of that agent; a new view gets the last state and frame at once;
// a reconnect subscribes again; the agents' open browsers and the session list after browser.sessions.
// X02 pull mode (phones): one pull in flight per browser, parts joined, no unsubscribe call, a
// reconnect starts a new loop, an error shows once; a browser without a view is forgotten with its frame
// once its loop ended (B-076: a remote tab's key is one per tab on its PC).
// Owns: these assertions only. Never: a runtime, socket or DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentBrowsers, createBrowserFeed, frameSrc, mergeLocal } from '../../../src/ui/workspace/browser-feed.ts';
import type { BrowserFeedView } from '../../../src/ui/workspace/browser-feed.ts';
import type { BrowserFrame, BrowserPull, BrowserSessionInfo, BrowserViewState } from '../../../src/shared/model/browser.ts';

function harness(options: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const states = new Set<(state: BrowserViewState) => void>();
  const frames = new Set<(frame: BrowserFrame) => void>();
  const opens = new Set<() => void>();
  const state = (agentId: string, extra: Partial<BrowserViewState> = {}): BrowserViewState => ({ agentId, open: true, tabs: [], live: true, at: 1, ...extra });
  const feed = createBrowserFeed({
    subscribe: async (agentId) => {
      calls.push(`subscribe ${agentId}`);
      if (options.fail) throw new Error('not allowed');
      return { state: state(agentId) };
    },
    unsubscribe: async (agentId) => { calls.push(`unsubscribe ${agentId}`); },
    onState: (fn) => { states.add(fn); return () => states.delete(fn); },
    onFrame: (fn) => { frames.add(fn); return () => frames.delete(fn); },
    onOpen: (fn) => { opens.add(fn); return () => opens.delete(fn); },
    errorText: (error) => (error as Error).message,
  });
  const pushState = (value: BrowserViewState) => { for (const fn of states) fn(value); };
  const pushFrame = (agentId: string, data: string) => { for (const fn of frames) fn({ agentId, tab: 't1', data, width: 1280, height: 720, at: 2 }); };
  const reconnect = () => { for (const fn of opens) fn(); };
  const views = (): { seen: BrowserFeedView[]; listener: (view: BrowserFeedView) => void } => {
    const seen: BrowserFeedView[] = [];
    return { seen, listener: (view) => seen.push(view) };
  };
  return { feed, calls, state, pushState, pushFrame, reconnect, views };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('one subscription per browser however many views; the last view unsubscribes', async () => {
  const { feed, calls, views } = harness();
  const a = views();
  const b = views();
  const offA = feed.subscribe('ag_1', a.listener);
  const offB = feed.subscribe('ag_1', b.listener);
  await settle();
  assert.deepEqual(calls, ['subscribe ag_1']);
  assert.equal(a.seen.at(-1)?.state?.open, true);
  offA();
  assert.deepEqual(calls, ['subscribe ag_1'], 'another view still shows it');
  offB();
  offB();
  assert.deepEqual(calls, ['subscribe ag_1', 'unsubscribe ag_1']);
  assert.deepEqual(feed.active(), []);
});

test('state and frames reach only the views of that agent; a new view gets the last ones at once', async () => {
  const { feed, views, pushState, pushFrame, state } = harness();
  const one = views();
  const two = views();
  feed.subscribe('ag_1', one.listener);
  feed.subscribe('ag_2', two.listener);
  await settle();
  pushFrame('ag_2', '/9j/TWO');
  pushFrame('ag_3', '/9j/OTHER');
  assert.equal(one.seen.at(-1)?.frame, null);
  assert.equal(two.seen.at(-1)?.frame?.data, '/9j/TWO');
  pushState(state('ag_1', { tab: 't2' }));
  assert.equal(one.seen.at(-1)?.state?.tab, 't2');
  assert.equal(two.seen.at(-1)?.state?.tab, undefined);
  const late = views();
  feed.subscribe('ag_2', late.listener);
  assert.equal(late.seen[0]?.frame?.data, '/9j/TWO');
  assert.equal(frameSrc(late.seen[0]!.frame!), 'data:image/jpeg;base64,/9j/TWO');
});

test('a reconnect subscribes the shown browsers again; a refused subscription shows the reason', async () => {
  const ok = harness();
  const view = ok.views();
  ok.feed.subscribe('ag_1', view.listener);
  const off = ok.feed.subscribe('ag_2', ok.views().listener);
  off();
  await settle();
  ok.reconnect();
  await settle();
  assert.deepEqual(ok.calls, ['subscribe ag_1', 'subscribe ag_2', 'unsubscribe ag_2', 'subscribe ag_1']);

  const refused = harness({ fail: true });
  const seen = refused.views();
  refused.feed.subscribe('ag_1', seen.listener);
  await settle();
  assert.equal(seen.seen.at(-1)?.error, 'not allowed');
});

/** X02 pull mode: pulls wait until the test answers them; parts are kept per frame `at`. */
function pulling() {
  const calls: string[] = [];
  const waiting: Array<{ agentId: string; resolve: (reply: BrowserPull) => void; reject: (error: unknown) => void }> = [];
  const parts = new Map<number, string[]>();
  const opens = new Set<() => void>();
  let inFlight = 0;
  let most = 0;
  const feed = createBrowserFeed({
    subscribe: async (agentId) => { calls.push(`subscribe ${agentId}`); return { state: { agentId, open: true, tabs: [], live: true, at: 1 } }; },
    unsubscribe: async (agentId) => { calls.push(`unsubscribe ${agentId}`); },
    onState: () => () => undefined,
    onFrame: () => () => undefined,
    onOpen: (fn) => { opens.add(fn); return () => opens.delete(fn); },
    errorText: (error) => (error as Error).message,
    pulls: () => true,
    pull: (agentId, after) => new Promise<BrowserPull>((resolve, reject) => {
      calls.push(`pull ${agentId} ${JSON.stringify(after)}`);
      most = Math.max(most, ++inFlight);
      waiting.push({ agentId, resolve: (reply) => { inFlight--; resolve(reply); }, reject: (error) => { inFlight--; reject(error); } });
    }),
    pullPart: async (_agentId, at, index) => {
      calls.push(`part ${at} ${index}`);
      const list = parts.get(at);
      if (!list) throw Object.assign(new Error('That picture is gone. Look again.'), { code: 'not_found' });
      return { data: list[index] };
    },
  });
  const state = (at: number): BrowserViewState => ({ agentId: 'ag_1', open: true, tabs: [], live: true, at });
  const frame = (at: number, data: string): BrowserFrame => ({ agentId: 'ag_1', tab: 't1', data, width: 1280, height: 720, at });
  const answer = async (reply: BrowserPull) => { waiting.shift()!.resolve(reply); await settle(); await settle(); };
  return { feed, calls, waiting, parts, state, frame, answer, reconnect: () => { for (const fn of opens) fn(); }, most: () => most };
}

test('pull mode: one pull in flight per browser, replies published, parts joined; past the last state and frame', async () => {
  const p = pulling();
  const a: BrowserFeedView[] = [];
  const b: BrowserFeedView[] = [];
  p.feed.subscribe('ag_1', (view) => a.push(view));
  p.feed.subscribe('ag_1', (view) => b.push(view));
  await settle();
  assert.equal(p.waiting.length, 1, 'one loop for both views');
  await p.answer({ state: p.state(1) });
  assert.equal(a.at(-1)?.state?.at, 1);
  p.parts.set(5, ['AA', 'BB', 'CC']);
  await p.answer({ state: p.state(1), frame: p.frame(5, 'AA'), parts: 3 });
  assert.equal(b.at(-1)?.frame?.data, 'AABBCC', 'the parts are joined');
  await p.answer({ state: p.state(1), frame: p.frame(7, 'GONE'), parts: 2 }); // part 1 is gone meanwhile
  assert.equal(a.at(-1)?.frame?.data, 'AABBCC', 'a frame with a gone part is dropped');
  assert.deepEqual(p.calls.filter((call) => call.startsWith('pull')), ['pull ag_1 {}', 'pull ag_1 {"state":1}', 'pull ag_1 {"state":1,"frame":5}', 'pull ag_1 {"state":1,"frame":5}']);
  assert.deepEqual(p.calls.filter((call) => call.startsWith('part')), ['part 5 1', 'part 5 2', 'part 7 1']);
  assert.equal(p.most(), 1, 'never two pulls at once');
  assert.equal(p.calls.some((call) => call.startsWith('subscribe')), false, 'no pushed subscription');
});

test('pull mode: the last view leaving ends the loop without an unsubscribe call; a new view reuses the running pull', async () => {
  const p = pulling();
  const off = p.feed.subscribe('ag_1', () => undefined);
  await settle();
  off();
  const back = p.feed.subscribe('ag_1', () => undefined);
  assert.equal(p.waiting.length, 1, 'the pull in flight carries on for the new view');
  await p.answer({ state: p.state(2) });
  assert.equal(p.waiting.length, 1);
  back();
  await p.answer({ state: p.state(3) });
  assert.equal(p.waiting.length, 0, 'no view, no pull');
  assert.equal(p.calls.some((call) => call.startsWith('unsubscribe')), false);
});

test('pull mode: once its loop ended, a browser no view shows is forgotten with its frame – a later view starts fresh', async () => {
  const p = pulling();
  const off = p.feed.subscribe('ag_1', () => undefined);
  await settle();
  await p.answer({ state: p.state(1), frame: p.frame(2, 'OLD') });
  off();
  await p.answer({ state: p.state(1) }); // the last pull comes back: no view, the loop ends
  assert.equal(p.waiting.length, 0);
  const seen: BrowserFeedView[] = [];
  p.feed.subscribe('ag_1', (view) => seen.push(view));
  assert.deepEqual(seen, [], 'no old frame shows (or takes a click) before the new pull answers');
  assert.equal(p.waiting.length, 1, 'a new loop asks');
});

test('pull mode: a reconnect starts a new loop and the old one stops; an error shows once and waits for the next reconnect', async () => {
  const p = pulling();
  const seen: BrowserFeedView[] = [];
  p.feed.subscribe('ag_1', (view) => seen.push(view));
  await settle();
  p.reconnect();
  await settle();
  assert.equal(p.waiting.length, 2, 'the new loop pulls');
  await p.answer({ state: p.state(9) }); // the old loop's late answer
  assert.equal(seen.length, 0, 'the old loop publishes nothing');
  assert.equal(p.waiting.length, 1, 'and pulls no more');
  await p.answer({ state: p.state(10) });
  assert.equal(seen.at(-1)?.state?.at, 10);
  p.waiting.shift()!.reject(new Error('This phone can use an agent\'s browser only while that agent has an open to-do for you.'));
  await settle();
  assert.match(seen.at(-1)?.error ?? '', /open to-do/);
  const count = seen.length;
  await settle();
  assert.equal(p.waiting.length, 0, 'the loop stopped');
  assert.equal(seen.length, count, 'shown once');
  p.reconnect();
  await settle();
  assert.equal(p.waiting.length, 1, 'pulls again after the next reconnect');
});

test("the agents' open browsers and the session list after browser.sessions", () => {
  const sessions: BrowserSessionInfo[] = [
    { agentId: 'ag_web', tabs: 2, url: 'https://b.test/', title: 'B' },
    { agentId: 'ag_other', tabs: 1, url: 'https://c.test/', title: 'C' },
  ];
  assert.deepEqual(agentBrowsers(sessions, ['ag_mira', 'ag_web']).map((entry) => entry.agentId), ['ag_web']);
  assert.deepEqual(mergeLocal(sessions, ['ag_web', 'ag_new']).map((entry) => [entry.agentId, entry.title]), [['ag_web', 'B'], ['ag_new', '']], 'closed ones drop out, new ones appear');
});
