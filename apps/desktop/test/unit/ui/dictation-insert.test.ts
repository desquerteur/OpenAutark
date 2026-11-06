// D13 – where dictated text goes (ui/chat/composer/dictation-insert.ts): at the caret (start,
// middle, end), over a selection, appended when the field was not focused (regression: every take
// was appended, wherever the caret was), with smart spacing and a capital letter at a sentence
// start, and moved along edits made while recording.
// Owns: these assertions only. Never: a DOM, a microphone or a bridge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertDictation, shiftTarget } from '../../../src/ui/chat/composer/dictation-insert.ts';

const at = (start: number, end = start) => ({ start, end, focused: true });

test('insertDictation: at the start, in the middle and at the end of the text, with one space at each seam', () => {
  assert.deepEqual(insertDictation('world', at(0), 'hello'), { text: 'Hello world', offset: 0, caret: 5, dictated: 'Hello' });
  const middle = insertDictation('Send the offer today', at(14), 'to Teydra');
  assert.equal(middle.text, 'Send the offer to Teydra today');
  assert.equal(middle.caret, 'Send the offer to Teydra'.length);
  assert.equal(middle.text.slice(middle.offset, middle.caret), 'to Teydra');
  const end = insertDictation('Send the offer', at(14), 'to Teydra');
  assert.equal(end.text, 'Send the offer to Teydra');
  assert.equal(end.caret, end.text.length);
});

test('insertDictation: a selection is replaced; a field that was not focused gets the take appended', () => {
  assert.equal(insertDictation('Send the offer to Bob today', at(18, 21), 'Teydra').text, 'Send the offer to Teydra today');
  const unfocused = insertDictation('Send the offer', { start: 0, end: 0, focused: false }, 'to Teydra');
  assert.equal(unfocused.text, 'Send the offer to Teydra');
  assert.equal(insertDictation('Send the offer', null, 'to Teydra').text, 'Send the offer to Teydra', 'no target: append');
  assert.equal(insertDictation('', null, 'hallo zusammen').text, 'Hallo zusammen', 'an empty field starts a sentence');
});

test('insertDictation: smart spacing – none before punctuation, none after an opening bracket, a space before following text', () => {
  assert.equal(insertDictation('Hello ', at(6), ', world').text, 'Hello, world', 'the space before a comma goes');
  assert.equal(insertDictation('Call (', at(6), 'Teydra').text, 'Call (Teydra');
  assert.equal(insertDictation('Call ()', at(6), 'Teydra').text, 'Call (Teydra)', 'no space before a closing bracket');
  assert.equal(insertDictation('ab', at(1), 'x').text, 'a x b');
  assert.equal(insertDictation('first line\n', at(11), 'zweite Zeile').text, 'first line\nZweite Zeile', 'a new line starts a sentence');
  assert.equal(insertDictation('Done. ', at(6), 'next one').text, 'Done. Next one');
  assert.equal(insertDictation('ich habe', at(8), 'Hunger').text, 'ich habe Hunger', 'never lowered (German nouns)');
  assert.equal(insertDictation('text', at(4), '   ').text, 'text', 'nothing heard changes nothing');
});

test('shiftTarget: edits while recording move the target – before it shifts, after it stays, touching the selection appends', () => {
  const before = 'Send the offer today';
  const caret = at(14);
  assert.deepEqual(shiftTarget(before, before, caret), caret);
  assert.deepEqual(shiftTarget(before, 'Please send the offer today', caret), { ...caret, start: 21, end: 21 }, 'typed before the caret');
  assert.deepEqual(shiftTarget(before, 'Send the offer today!', caret), caret, 'typed after it');
  assert.deepEqual(shiftTarget(before, 'Send the offer now today', caret), { ...caret, start: 18, end: 18 }, 'typed at the caret: the take follows the typed words');
  assert.deepEqual(shiftTarget(before, 'Send offer today', caret), { ...caret, start: 10, end: 10 }, 'deleted before it');
  const selection = at(9, 14);
  assert.equal(shiftTarget(before, 'Send the proposal today', selection), null, 'the selected words were edited: append');
  const typed = 'Please send the offer today';
  const moved = shiftTarget(before, typed, caret);
  assert.equal(insertDictation(typed, moved, 'to Teydra').text, 'Please send the offer to Teydra today');
});
