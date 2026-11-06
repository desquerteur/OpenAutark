// The person's Forget reaches the context ledger (context/ledger/forget.ts via rpc knowledge.forget): a fact that sits only in a
// long tool output's blob (past the run item's first 4,000 characters), or in a condensed text, never comes back through
// context.restore or a native rebuild's view. Unrelated items stay whole.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerSetup } from './ledger-fixture.ts';
import { journalRow } from '../../../src/runtime/context/ledger/originals.ts';
import { fingerprint, mentions } from '../../../src/runtime/privacy/mentions.ts';
import { LEDGER_FORGOTTEN } from '../../../src/runtime/context/ledger/forget.ts';

const FACT = 'Invoice INV-55821 for Brightwave is disputed';

async function setup() {
  const t = ledgerSetup();
  const run = t.turn();
  t.ourCall(run, 'web.fetch', { url: 'https://example.com/a' }, `${'x'.repeat(5_000)}\n${FACT}\n`, 'c1'); // t1: only in the blob
  t.ourCall(run, 'files.read', { path: 'notes.txt' }, `${FACT}\n${'y'.repeat(5_000)}`, 'c2'); // f2: in the row's first 4,000 too
  t.ourCall(run, 'shell.exec', { command: 'npm test' }, 'z'.repeat(6_000), 'c3'); // t3: unrelated, condensed below
  t.ourCall(run, 'shell.exec', { command: 'ls' }, 'w'.repeat(6_000), 'c4'); // t4: unrelated, stays whole
  await t.journal.settled();
  t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 't3', state: 'condensed', condensed: `tests pass; ${FACT}`, reason: 'log', by: 'subconscious' }]);
  const itemOf = (itemId: string) => journalRow(t.db, t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === itemId)!.ref!.slice(5))!;
  return { t, itemOf };
}

test('ledger.forget: blob originals that mention it are pruned and no longer named; condensed copies read [forgotten]; others stay', async () => {
  const { t, itemOf } = await setup();
  try {
    const { ledger, tom, chat } = t;
    const blob1 = itemOf('t1').data.outputBlob as string;
    const blob4 = itemOf('t4').data.outputBlob as string;
    assert.match(ledger.original(tom.id, chat.id, 't1')!.text, /INV-55821/, 'before: the blob holds it');
    const print = fingerprint([FACT]);
    const result = ledger.forget((text) => mentions(text, print));
    assert.equal(result.truncated, false);
    assert.equal(result.originals, 2, 't1 (blob) and f2 (row and blob)');

    const t1 = ledger.original(tom.id, chat.id, 't1')!;
    assert.equal(t1.pruned, true);
    assert.doesNotMatch(t1.text, /INV-55821|Brightwave/);
    assert.equal(itemOf('t1').data.outputBlob, undefined, 'the run item no longer names the blob');
    assert.ok(t.reclaimed.includes(blob1), 'the blob goes back to the clean-up');
    const t3 = ledger.items(tom.id, chat.id).find((item) => item.itemId === 't3')!;
    assert.equal(t3.condensed, LEDGER_FORGOTTEN);
    const view = ledger.view(tom.id, chat.id);
    for (const id of ['t1', 't3']) assert.doesNotMatch(JSON.stringify(view.find((item) => item.itemId === id)), /INV-55821|Brightwave/, `a rebuild carries none of ${id}`);
    assert.doesNotMatch(JSON.stringify(view.find((item) => item.itemId === 'f2')), /INV-55821|Brightwave/, 'f2 stayed in full until now; a rebuild carries none of it');
    assert.equal(itemOf('t4').data.outputBlob, blob4);
    assert.equal(ledger.original(tom.id, chat.id, 't4')!.text, 'w'.repeat(6_000), 'an unrelated original stays whole');
    assert.ok(!t.reclaimed.includes(blob4));
  } finally { t.cleanup(); }
});

test('ledger.forget: a fact only in a call\'s arguments (knowledge.remember) leaves a rebuild too, its pair stays', async () => {
  const t = ledgerSetup();
  try {
    const run = t.turn();
    t.ourCall(run, 'knowledge.remember', { title: 'Dispute', body: FACT }, 'saved', 'c1');
    await t.journal.settled();
    assert.match(JSON.stringify(t.ledger.view(t.tom.id, t.chat.id)), /INV-55821/, 'before: the call names it');
    const print = fingerprint([FACT]);
    t.ledger.forget((text) => mentions(text, print));
    const view = t.ledger.view(t.tom.id, t.chat.id);
    assert.doesNotMatch(JSON.stringify(view), /INV-55821|Brightwave/);
    assert.equal(view[0].call?.callId, 'c1', 'the pair stays whole');
    assert.equal(typeof view[0].call?.output, 'string');
    assert.equal(t.ledger.original(t.tom.id, t.chat.id, view[0].itemId)?.pruned, true);
  } finally { t.cleanup(); }
});
