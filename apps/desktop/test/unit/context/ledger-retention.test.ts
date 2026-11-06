// B-048 E1 retention: blob originals of condensed/hidden items stay at least 14 days after the mark, within the
// budget per (agent, chat) – the oldest hidden go first, then the oldest condensed; kept items never; the row
// stays (title, condensed text); the blob goes back to the store's clean-up unless another ledger row holds the
// same bytes. The start-up pass catches up; a removed chat's rows go and give their blobs back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerSetup } from './ledger-fixture.ts';
import { RETENTION_BYTES, RETENTION_FLOOR_MS } from '../../../src/runtime/context/ledger/retention.ts';
import { journalRow } from '../../../src/runtime/context/ledger/originals.ts';

const DAY = 24 * 60 * 60_000;

async function four(budget: number) {
  const t = ledgerSetup({ budget });
  const run = t.turn();
  for (const [index, letter] of ['a', 'b', 'c', 'd'].entries()) t.ourCall(run, 'shell.exec', { command: `step ${index}` }, letter.repeat(6_000), `c${index}`);
  await t.journal.settled();
  return t;
}

const blobOf = (t: Awaited<ReturnType<typeof four>>, itemId: string): string => {
  const ref = t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === itemId)!.ref!;
  return journalRow(t.db, ref.slice(5))!.data.outputBlob as string;
};

test('defaults: 64 MB per agent and chat, 14 days after the mark', () => {
  assert.equal(RETENTION_BYTES, 64 * 1024 * 1024);
  assert.equal(RETENTION_FLOOR_MS, 14 * DAY);
});

test('over the budget: oldest hidden first, then the oldest condensed, never before 14 days, never a kept item', async () => {
  const t = await four(10_000);
  try {
    const { ledger, tom, chat } = t;
    assert.equal(ledger.items(tom.id, chat.id)[0].tokens > 1500, true);
    ledger.mark(tom.id, chat.id, [
      { itemId: 't1', state: 'condensed', condensed: 'step 0 ok', reason: 'log', by: 'subconscious' },
      { itemId: 't2', state: 'hidden', reason: 'noise', by: 'subconscious' },
      { itemId: 't3', state: 'hidden', reason: 'noise', by: 'subconscious' },
    ]);
    assert.ok(ledger.items(tom.id, chat.id).every((item) => !item.pruned), 'younger than 14 days: kept although over the budget');
    t.clock.advance(15 * DAY);
    ledger.mark(tom.id, chat.id, [{ itemId: 't4', state: 'keep', reason: 'still needed', by: 'agent' }]);
    const after = ledger.items(tom.id, chat.id);
    assert.deepEqual(after.map((item) => [item.itemId, Boolean(item.pruned)]), [['t1', false], ['t2', true], ['t3', true], ['t4', false]],
      '18,000 held: the two hidden go (oldest first) until 6,000 ≤ 10,000; the condensed one and the kept one stay');
    assert.deepEqual(t.reclaimed.sort(), [blobOf(t, 't2'), blobOf(t, 't3')].sort(), 'their blobs go back to the clean-up');
    assert.equal(ledger.original(tom.id, chat.id, 't1')!.text, 'a'.repeat(6_000), 'the condensed one is still whole');
    assert.deepEqual(ledger.original(tom.id, chat.id, 't2'), { text: after[1].title, pruned: true });
    assert.ok(after[1].title, 'the row keeps its title, so t2 never dangles');
  } finally { t.cleanup(); }
});

test('a blob another unpruned ledger row holds (same bytes) is not given back', async () => {
  const t = ledgerSetup({ budget: 1_000 });
  try {
    const run = t.turn();
    t.ourCall(run, 'files.read', { path: 'a.txt' }, 'same'.repeat(2_000), 'c1');
    t.ourCall(run, 'files.read', { path: 'b.txt' }, 'same'.repeat(2_000), 'c2');
    await t.journal.settled();
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 'f1', state: 'hidden', reason: 'dup', by: 'subconscious' }]);
    t.clock.advance(15 * DAY);
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 'f2', state: 'keep', reason: 'needed', by: 'agent' }]);
    assert.equal(t.ledger.items(t.tom.id, t.chat.id)[0].pruned, true);
    assert.deepEqual(t.reclaimed, [], 'f2 still holds the same bytes');
    assert.equal(t.ledger.original(t.tom.id, t.chat.id, 'f2')!.text.length, 8_000);
  } finally { t.cleanup(); }
});

test('the start-up pass prunes chats over the budget; a removed chat\'s rows go and give their blobs back', async () => {
  const t = await four(10_000);
  try {
    const { ledger, tom, chat } = t;
    ledger.mark(tom.id, chat.id, [{ itemId: 't1', state: 'hidden', reason: 'x', by: 'subconscious' }, { itemId: 't2', state: 'hidden', reason: 'x', by: 'subconscious' }]);
    t.clock.advance(15 * DAY);
    const stop = ledger.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    stop();
    assert.equal(ledger.items(tom.id, chat.id)[0].pruned, true, 'the bounded start-up pass');
    assert.equal(ledger.items(tom.id, chat.id)[1].pruned, undefined, '6,000 ≤ 10,000 after one');
    t.reclaimed.length = 0;
    t.chats.remove(chat.id);
    assert.deepEqual(ledger.items(tom.id, chat.id), []);
    assert.deepEqual(t.reclaimed.sort(), [blobOf4(t, 1), blobOf4(t, 2), blobOf4(t, 3)].sort(), 'the unpruned originals\' blobs');
  } finally { t.cleanup(); }
});

/** The blob of our n-th call's result (the ledger rows are gone after the chat's removal). */
function blobOf4(t: Awaited<ReturnType<typeof four>>, n: number): string {
  return t.db.get<{ blob: string }>(`SELECT json_extract(data, '$.outputBlob') AS blob FROM run_items WHERE kind = 'tool_result' AND json_extract(data, '$.callId') = ?`, [`c${n}`])!.blob;
}
