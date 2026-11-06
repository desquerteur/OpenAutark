// B-048 E1: the ledger view (what the next native rebuild contains) with condensed and hidden marks and the
// verbatim restore stamp; marks (pins hold against the gardener, a condensed mark needs text); needsRebuild /
// rebuilt (what the native session holds).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerSetup } from './ledger-fixture.ts';

function filled() {
  const t = ledgerSetup();
  const asked = t.say('Fix the login bug, keep port 8443.');
  const run = t.turn(asked.seq);
  t.journal.item(run, { kind: 'reasoning', data: { summary: 'Look at auth.ts first.', live: false }, effectStatus: 'none' });
  t.ourCall(run, 'shell.exec', { command: 'npm install' }, 'added 812 packages\n'.repeat(50), 'c1');
  t.ourCall(run, 'files.read', { path: 'src/auth.ts' }, 'export function login() {}', 'c2');
  t.journal.item(run, { kind: 'note', name: 'Answer', data: { answer: true, text: 'Fixed: the token check.' }, effectStatus: 'none' });
  return { ...t, asked, run };
}

test('view: originals in order, hidden left out, condensed text with the stamp appended verbatim', () => {
  const t = filled();
  try {
    const { ledger, tom, chat, asked } = t;
    const before = ledger.view(tom.id, chat.id);
    assert.deepEqual(before.map((item) => [item.itemId, item.role]), [[`m${asked.seq}`, 'user'], ['r1', 'assistant'], ['t2', 'tool'], ['f3', 'tool'], ['a4', 'assistant']]);
    assert.match(before[0].text, /Alex: Fix the login bug, keep port 8443\./, 'a chat line as the agent reads it');
    assert.deepEqual(before[2].call, { name: 'shell.exec', args: { command: 'npm install' }, callId: 'c1', output: 'added 812 packages\n'.repeat(50) });
    assert.equal(before[3].call?.name, 'files.read');
    assert.equal(before[2].origin.engine, 'codex');

    const tokens = ledger.items(tom.id, chat.id).find((item) => item.itemId === 't2')!.tokens;
    ledger.mark(tom.id, chat.id, [
      { itemId: 't2', state: 'condensed', condensed: 'npm install: 812 packages added', reason: 'install log', by: 'subconscious' },
      { itemId: 'r1', state: 'hidden', reason: 'superseded', by: 'subconscious' },
      { itemId: 'f3', state: 'condensed', reason: 'no text given', by: 'subconscious' },
      { itemId: 'x9', state: 'hidden', reason: 'unknown id', by: 'subconscious' },
    ]);
    const after = ledger.view(tom.id, chat.id);
    assert.deepEqual(after.map((item) => item.itemId), [`m${asked.seq}`, 't2', 'f3', 'a4'], 'hidden r1 is left out');
    const stamp = `{"compacted":"t2","was":"${tokens} tokens","restore":"context.restore"}`;
    assert.equal(after[1].stamp, stamp);
    assert.equal(after[1].text, `npm install: 812 packages added\n${stamp}`);
    assert.equal(after[1].call?.output, after[1].text, 'the call stays paired; its output is the condensed text');
    assert.equal(after[1].state, 'condensed');
    assert.equal(after[2].state, 'keep', 'a condensed mark without any text is skipped');
    const item = ledger.items(tom.id, chat.id).find((entry) => entry.itemId === 't2')!;
    assert.equal(item.markedBy, 'subconscious');
    assert.equal(item.markReason, 'install log');
    assert.equal(ledger.original(tom.id, chat.id, 't2')!.text, 'added 812 packages\n'.repeat(50), 'the original stays restorable');
  } finally { t.cleanup(); }
});

test('needsRebuild names the first changed order and the savings; rebuilt applies marks up to an order', () => {
  const t = filled();
  try {
    const { ledger, tom, chat } = t;
    assert.equal(ledger.needsRebuild(tom.id, chat.id), undefined, 'a live session holds everything as captured');
    const items = ledger.items(tom.id, chat.id);
    const t2 = items.find((item) => item.itemId === 't2')!;
    const a4 = items.find((item) => item.itemId === 'a4')!;
    ledger.mark(tom.id, chat.id, [
      { itemId: 't2', state: 'hidden', reason: 'log', by: 'subconscious' },
      { itemId: 'a4', state: 'condensed', condensed: 'Fixed token check', reason: 'short', by: 'subconscious' },
    ]);
    const need = ledger.needsRebuild(tom.id, chat.id)!;
    assert.equal(need.since, t2.order);
    assert.equal(need.reason, '1 condensed, 1 hidden since the last rebuild');
    assert.ok(need.saves > t2.tokens - 30 && need.saves < t2.tokens, `${need.saves}: the hidden log saves its tokens, the stamped short answer costs a little`);
    ledger.rebuilt(tom.id, chat.id, t2.order);
    assert.equal(ledger.needsRebuild(tom.id, chat.id)!.since, a4.order, 'only the marks up to upTo were applied');
    ledger.rebuilt(tom.id, chat.id, a4.order);
    assert.equal(ledger.needsRebuild(tom.id, chat.id), undefined);
    ledger.mark(tom.id, chat.id, [{ itemId: 't2', state: 'keep', reason: 'context.restore', by: 'restore' }]);
    const back = ledger.needsRebuild(tom.id, chat.id)!;
    assert.equal(back.reason, '1 restored since the last rebuild');
    assert.ok(back.saves < 0, 'a restore brings tokens back');
  } finally { t.cleanup(); }
});

test('pins: a restore pins for 3 turns – the gardener cannot mark it until then; the agent can', () => {
  const t = filled();
  try {
    const { ledger, tom, chat } = t;
    ledger.mark(tom.id, chat.id, [{ itemId: 't2', state: 'keep', reason: 'context.restore', by: 'restore' }]);
    const pinned = ledger.items(tom.id, chat.id).find((item) => item.itemId === 't2')!;
    assert.equal(pinned.pinnedUntil, 1 + 3, 'turn 1 plus 3');
    ledger.mark(tom.id, chat.id, [{ itemId: 't2', state: 'hidden', reason: 'old', by: 'subconscious' }]);
    assert.equal(ledger.items(tom.id, chat.id).find((item) => item.itemId === 't2')!.state, 'keep', 'the pin holds');
    for (let turn = 0; turn < 3; turn++) t.ledger.record(tom.id, chat.id, { kind: 'assistant', runId: t.turn(), ref: `item:extra_${turn}`, text: 'more' });
    assert.ok(ledger.items(tom.id, chat.id).find((item) => item.itemId === 't2')!.pinnedUntil, 'still pinned in turn 4');
    t.ledger.record(tom.id, chat.id, { kind: 'assistant', runId: t.turn(), ref: 'item:extra_last', text: 'more' });
    assert.equal(ledger.items(tom.id, chat.id).find((item) => item.itemId === 't2')!.pinnedUntil, undefined, 'expired after 3 more turns');
    ledger.mark(tom.id, chat.id, [{ itemId: 't2', state: 'hidden', reason: 'old', by: 'subconscious' }]);
    assert.equal(ledger.items(tom.id, chat.id).find((item) => item.itemId === 't2')!.state, 'hidden');
  } finally { t.cleanup(); }
});

test('the person\'s edit retitles the message item; a deleted message keeps none of its words and leaves the view', () => {
  const t = filled();
  try {
    const { ledger, tom, chat, asked } = t;
    const id = `m${asked.seq}`;
    t.chats.edit(asked.id, 'Fix the signup bug instead.', 'human');
    let item = ledger.items(tom.id, chat.id).find((entry) => entry.itemId === id)!;
    assert.equal(item.title, 'Alex: Fix the signup bug instead.');
    assert.equal(ledger.original(tom.id, chat.id, id)!.text, 'Fix the signup bug instead.', 'the original is the current text');
    t.chats.removeMessage(asked.id, 'human');
    item = ledger.items(tom.id, chat.id).find((entry) => entry.itemId === id)!;
    assert.equal(item.title, 'Deleted message');
    assert.equal(item.state, 'hidden');
    assert.equal(item.pruned, true);
    assert.deepEqual(ledger.original(tom.id, chat.id, id), { text: 'Deleted message', pruned: true });
    assert.ok(!ledger.view(tom.id, chat.id).some((entry) => entry.itemId === id));
    assert.match(ledger.needsRebuild(tom.id, chat.id)!.reason, /1 hidden/, 'a rebuild drops it from the native session too');
  } finally { t.cleanup(); }
});
