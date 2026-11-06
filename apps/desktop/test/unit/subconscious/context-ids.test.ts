// B-074 (n2 c1 #88, 04.11.2026): a brain called context.hide {"ids":[33,38,44,47]} – the list's t33, t38 … as bare numbers –, got "context.hide needs
// ids." twice and ended its run. A bare number (33 or "33") is now the one item whose id carries it, in hide, condense, restore, read and the
// list's `after`; messages (m<seq>) and the other kinds count apart, so when two items carry the number the answer names both forms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextTools } from '../../../src/runtime/subconscious/context-tools.ts';
import type { FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import { ledgerSetup } from '../context/ledger-fixture.ts';

const tool = (name: string) => contextTools.find((entry) => entry.name === name)!;

/** A first turn with six long tool outputs, then three turns with one each: the first turn's items are older than the newest 2 turns. */
function chat() {
  const t = ledgerSetup();
  for (let index = 1; index <= 4; index++) {
    const run = t.turn(t.say(`Step ${index} please, with some words.`).seq);
    for (let call = 1; call <= (index === 1 ? 6 : 1); call++) {
      const n = `${index}${call}`;
      t.ourCall(run, 'shell.exec', { command: `build ${n}` }, `build ${n} finished in 4${n} seconds\n${'log line\n'.repeat(400)}`, `c${n}`);
    }
    t.done(run);
    t.clock.advance(1000);
  }
  const run = {
    services: t.services, agent: t.tom, conversationId: t.chat.id, thread: t.chat.id, kind: 'after-turn', signal: new AbortController().signal,
    hits: new Map(), searches: [], show: () => {}, route: () => {}, finish: () => {},
  } as unknown as FlowRun;
  const ids = new Set(t.ledger.items(t.tom.id, t.chat.id).map((item) => item.itemId));
  const firstTurn = t.ledger.items(t.tom.id, t.chat.id).filter((item) => item.kind === 'tool').sort((a, b) => a.order - b.order).slice(0, 6).map((item) => Number(item.itemId.slice(1)));
  const alone = firstTurn.filter((n) => !ids.has(`m${n}`));
  const shared = firstTurn.filter((n) => ids.has(`m${n}`));
  assert.ok(alone.length >= 2 && shared.length >= 1, `the fixture has numbers only a tool carries and one a message carries too: ${[...ids].join(' ')}`);
  const state = (id: string) => t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === id)?.state;
  return { t, run, alone, shared, state };
}

test('context.hide takes bare numbers as the ids they stand for, as numbers and as text', async () => {
  const { t, run, alone, state } = chat();
  try {
    const [a, b] = alone;
    const out = String(await tool('context.hide').run({ ids: [a, String(b)] }, run));
    assert.match(out, new RegExp(`^hidden: t${a}, t${b}\\n`));
    assert.deepEqual([state(`t${a}`), state(`t${b}`)], ['hidden', 'hidden']);
    assert.equal(String(await tool('context.hide').run({}, run)), 'context.hide needs ids.', 'no ids at all: as before');
    assert.equal(String(await tool('context.hide').run({ ids: [{ id: 't1' }] }, run)), 'context.hide needs ids.');
  } finally { t.cleanup(); }
});

test('a number a message and a tool item both carry is not guessed: the answer names both forms', async () => {
  const { t, run, shared, state } = chat();
  try {
    const [n] = shared;
    const hidden = String(await tool('context.hide').run({ ids: [n] }, run));
    assert.match(hidden, new RegExp(`^left as they are: ${n} \\((m${n} or t${n}|t${n} or m${n}): give the id with its letter\\)`));
    assert.equal(state(`t${n}`), 'keep');
    const condensed = String(await tool('context.condense').run({ ids: [n] }, run));
    assert.match(condensed, new RegExp(`^${n} is (m${n} or t${n}|t${n} or m${n}): give the id with its letter\\.`));
    assert.match(String(await tool('context.condense').run({ ids: ['zz9'] }, run)), /^No such item: zz9\./, 'an unknown id: as before');
  } finally { t.cleanup(); }
});

test('context.condense, context.restore, context.read and the list\'s after take a bare number too', async () => {
  const { t, run, alone, state } = chat();
  try {
    const [a, b] = alone;
    const original = String(await tool('context.read').run({ id: a }, run));
    assert.match(original, new RegExp(`^t${a} tool \\d+t `), 'read: the item the number stands for');
    const given = original.split('\n')[1]; // "build 1x finished in 41x seconds"
    const condensed = String(await tool('context.condense').run({ ids: [a], text: given }, run));
    assert.match(condensed, new RegExp(`^condensed t${a}: about \\d+ tokens saved`));
    assert.equal(state(`t${a}`), 'condensed');
    assert.match(String(await tool('context.restore').run({ ids: [a] }, run)), new RegExp(`^back in full: t${a}`));
    assert.equal(state(`t${a}`), 'keep');
    const page = String(await tool('context.list').run({ after: a }, run));
    assert.doesNotMatch(page, new RegExp(`\\nt${a} `), 'the page starts after the item the number stands for');
    assert.match(page, new RegExp(`\\nt${b} `));
  } finally { t.cleanup(); }
});
