// Chat details › Notes (ui/chat/details/notes-line.ts): the row names who changed the notes last and when, and
// says nothing while nobody wrote any.
// Owns: these assertions only. Never: renders the row or reads notes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesLine } from '../../../src/ui/chat/details/notes-line.ts';

const name = (id: string) => (id === 'ag_mara' ? 'Mara' : 'Someone');
const at = new Date(2026, 9, 31, 12, 3).getTime();
const now = new Date(2026, 9, 31, 15, 0).getTime();

test('no notes yet (no meta or version 0) gives no line', () => {
  assert.equal(notesLine(null, name, now), '');
  assert.equal(notesLine({ version: 0 }, name, now), '');
});

test('the line names who and when; either alone is enough', () => {
  const line = notesLine({ version: 3, updatedAt: at, updatedBy: 'ag_mara' }, name, now);
  assert.match(line, /^Mara · /);
  assert.ok(line.length > 'Mara · '.length, 'the time follows the name');
  assert.equal(notesLine({ version: 1, updatedBy: 'ag_mara' }, name, now), 'Mara');
  assert.ok(notesLine({ version: 1, updatedAt: at }, name, now).length > 0);
});
