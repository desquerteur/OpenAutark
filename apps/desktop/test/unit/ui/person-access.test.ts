// F-52 (UI, ui/pwa/person-access.ts): a person's browser remembers that its token is a person's, so a
// removed person gets their own screen (whom to ask, no owner-PC steps) while the owner's phones keep
// "This phone was removed."; the mark follows every session answer and never holds the token.
// Owns: these assertions only. Never: the DOM or the runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarkStorage } from '../../../src/ui/lib/refusal.ts';
import { notePersonSession, PERSON_KEY, readPersonMark, removedPersonText, writePersonMark } from '../../../src/ui/pwa/person-access.ts';

function memory(): MarkStorage & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  const store = {
    data, writes: 0,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { store.writes++; data.set(key, value); },
    removeItem: (key: string) => { store.writes++; data.delete(key); },
  };
  return store;
}

test('a person\'s session marks the page (with the CEO\'s name); a phone\'s session clears it; no answer keeps it', () => {
  const storage = memory();
  notePersonSession({ kind: 'person' }, undefined, storage);
  assert.deepEqual(readPersonMark(storage), {}, 'marked before the directory is known');
  notePersonSession({ kind: 'person' }, 'Mara', storage);
  assert.deepEqual(readPersonMark(storage), { owner: 'Mara' });
  const writes = storage.writes;
  notePersonSession({ kind: 'person' }, 'Mara', storage);
  notePersonSession({ kind: 'person' }, undefined, storage);
  assert.equal(storage.writes, writes, 'unchanged: no write, and a known name is kept');
  notePersonSession(null, undefined, storage);
  assert.deepEqual(readPersonMark(storage), { owner: 'Mara' }, 'no answer (refused, offline): the mark stands');
  notePersonSession({ kind: 'device' }, undefined, storage);
  assert.equal(readPersonMark(storage), null, 'paired as an owner\'s phone: the phone wording again');
  writePersonMark({ owner: 'Mara' }, storage);
  notePersonSession({ kind: 'owner' }, undefined, storage);
  assert.equal(storage.data.has(PERSON_KEY), false);
});

test('the mark is only a name: unreadable values count as no mark, blocked storage as none', () => {
  const storage = memory();
  storage.data.set(PERSON_KEY, 'not json');
  assert.equal(readPersonMark(storage), null);
  storage.data.set(PERSON_KEY, JSON.stringify({ owner: 42 }));
  assert.deepEqual(readPersonMark(storage), {});
  writePersonMark({ owner: 'Mara' }, storage);
  assert.equal(storage.data.get(PERSON_KEY), '{"owner":"Mara"}');
  const blocked: MarkStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(readPersonMark(blocked), null);
  assert.doesNotThrow(() => writePersonMark({}, blocked));
  assert.equal(readPersonMark(null), null);
});

test('the removed person\'s wording names whom to ask and no owner-PC steps', () => {
  const named = removedPersonText({ owner: 'Mara' });
  assert.equal(named.title, 'Your access to this organisation was removed.');
  assert.equal(named.detail, 'To work here again, ask Mara, who invited you, for a new invite. Open its link, or enter its code here.');
  assert.match(removedPersonText({}).detail, /ask the person who invited you for a new invite/);
  assert.match(removedPersonText({ owner: 'CEO' }).detail, /ask the CEO for a new invite/, 'an owner without a profile name');
  for (const text of [named, removedPersonText({})]) {
    assert.doesNotMatch(`${text.title} ${text.detail}`, /phone|Settings|Remote|On your PC/, 'not the owner-phone wording');
  }
});
