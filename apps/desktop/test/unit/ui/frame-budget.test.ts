// FrameBudget: at most N live ```app frames, LRU eviction, pinning, release and unregister.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameBudget } from '../../../src/ui/blocks/frame-budget.ts';

function tracked(budget: FrameBudget, ids: string[]) {
  const state = new Map<string, boolean>();
  const events: string[] = [];
  const off = new Map<string, () => void>();
  for (const id of ids) {
    off.set(id, budget.register(id, (live) => { state.set(id, live); events.push(`${id}:${live ? 'on' : 'off'}`); }));
  }
  return { state, events, off };
}

test('grants slots up to the limit', () => {
  const budget = new FrameBudget(3);
  const { state } = tracked(budget, ['a', 'b', 'c']);
  assert.equal(budget.acquire('a'), true);
  assert.equal(budget.acquire('b'), true);
  assert.equal(budget.acquire('c'), true);
  assert.deepEqual(budget.liveIds(), ['a', 'b', 'c']);
  assert.equal(state.get('a'), true);
});

test('evicts the least recently activated frame when full', () => {
  const budget = new FrameBudget(3);
  const { state, events } = tracked(budget, ['a', 'b', 'c', 'd', 'e']);
  for (const id of ['a', 'b', 'c']) budget.acquire(id);
  budget.acquire('d');
  assert.equal(state.get('a'), false);
  assert.deepEqual(budget.liveIds(), ['b', 'c', 'd']);
  budget.acquire('b'); // re-activation moves b to the end
  budget.acquire('e');
  assert.equal(state.get('c'), false);
  assert.deepEqual(budget.liveIds(), ['d', 'b', 'e']);
  assert.ok(events.includes('a:off') && events.includes('c:off'));
});

test('acquire of a live frame does not notify again', () => {
  const budget = new FrameBudget(2);
  const { events } = tracked(budget, ['a']);
  budget.acquire('a');
  budget.acquire('a');
  assert.deepEqual(events, ['a:on']);
});

test('pinned frames are never evicted; all pinned → acquire fails', () => {
  const budget = new FrameBudget(2);
  const { state } = tracked(budget, ['a', 'b', 'c']);
  budget.acquire('a');
  budget.pin('a', true);
  budget.acquire('b');
  budget.acquire('c');
  assert.equal(state.get('b'), false);
  assert.deepEqual(budget.liveIds(), ['a', 'c']);
  budget.pin('c', true);
  assert.equal(budget.acquire('b'), false);
  assert.equal(budget.isLive('b'), false);
});

test('release frees the slot but not for pinned frames', () => {
  const budget = new FrameBudget(2);
  const { state } = tracked(budget, ['a', 'b']);
  budget.acquire('a');
  budget.acquire('b');
  budget.pin('b', true);
  budget.release('a');
  budget.release('b');
  assert.equal(state.get('a'), false);
  assert.deepEqual(budget.liveIds(), ['b']);
  budget.pin('b', false);
  budget.release('b');
  assert.deepEqual(budget.liveIds(), []);
});

test('unregister frees the slot silently and ignores stale unregister calls', () => {
  const budget = new FrameBudget(1);
  const { off, events } = tracked(budget, ['a']);
  budget.acquire('a');
  off.get('a')!();
  assert.deepEqual(budget.liveIds(), []);
  assert.deepEqual(events, ['a:on']);
  // A newer registration under the same id is not removed by the old unregister.
  const again: boolean[] = [];
  budget.register('a', (live) => again.push(live));
  off.get('a')!();
  budget.acquire('a');
  assert.deepEqual(again, [true]);
});

test('a throwing listener does not break the budget', () => {
  const budget = new FrameBudget(1);
  budget.register('a', () => { throw new Error('boom'); });
  budget.register('b', () => undefined);
  budget.acquire('a');
  assert.doesNotThrow(() => budget.acquire('b'));
  assert.deepEqual(budget.liveIds(), ['b']);
});
