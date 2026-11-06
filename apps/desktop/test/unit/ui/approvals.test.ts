// Ask answers in the UI: an approve card is a plain answer (B-078: its receipt says Yes or No), a
// choice's receipt is the picked text and an answered block in the chat shows what it asked (B-076), and the
// draft keys are cleared after an answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiBlock } from '../../../src/shared/blocks/catalog.ts';
import { askedText, receiptFor } from '../../../src/ui/blocks/ask.ts';
import { clearDrafts, WIDGET_DRAFT_SUFFIXES, writeDraft } from '../../../src/ui/blocks/host.ts';

test('receiptFor: an (older) approve card says Yes or No, nothing is remembered', () => {
  const block = { type: 'approve', action: 'Publish the post' } as UiBlock;
  assert.equal(receiptFor(block, { approved: true }), 'Yes');
  assert.equal(receiptFor(block, { approved: true, remember: true }), 'Yes');
  assert.equal(receiptFor(block, { approved: false, note: 'Not today' }), 'No · Not today');
});

test('B-076: a choice receipt is the picked text (no "Chose:"); an answered block in the chat shows what it asked', () => {
  const block = { type: 'choice', question: 'Wie weit darf ich auf diesem PC gehen?', options: ['Voller Zugriff', 'Nur lesen'] } as UiBlock;
  assert.equal(receiptFor(block, { choice: 'Voller Zugriff' }), 'Voller Zugriff');
  assert.equal(askedText(block), 'Wie weit darf ich auf diesem PC gehen?');
  assert.equal(askedText({ type: 'approve', action: 'Publish **the** post' } as UiBlock), 'Publish the post');
  assert.equal(askedText({ type: 'record', mode: 'audio' } as UiBlock), undefined, 'nothing asked in words: the receipt stands');
});

test('clearDrafts: removes the shell key and every widget sub-key, tolerates blocked storage', () => {
  const store = new Map<string, string>();
  const fake = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    const key = 'msg_1#0';
    writeDraft(key, { a: 1 });
    for (const suffix of WIDGET_DRAFT_SUFFIXES) writeDraft(`${key}.${suffix}`, ['x']);
    writeDraft('msg_1#1.values', { keep: true });
    assert.deepEqual([...WIDGET_DRAFT_SUFFIXES].sort(), ['checked', 'files', 'note', 'picked', 'values']);
    clearDrafts(key);
    assert.deepEqual([...store.keys()], ['wf.draft.msg_1#1.values'], 'only the other block keeps its draft');

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError'); },
    });
    assert.doesNotThrow(() => clearDrafts(key));
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
