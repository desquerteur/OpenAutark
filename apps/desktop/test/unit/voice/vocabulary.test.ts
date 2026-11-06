// Adding to the learned words (shared/voice/vocabulary.ts withWords), the one rule of the Settings word list and the
// subconscious's voice.words: the newest at the end, a word already there moves in its new spelling, a full list drops
// its oldest; spaces and control characters become one space (wordOf), on both sides of the comparison.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WORDS, WORD_CHARS, vocabularyWords, withWords, wordOf } from '../../../src/shared/voice/vocabulary.ts';

test('added words are the newest; one already there, in any case, moves to the end in the new spelling', () => {
  assert.deepEqual(withWords(['Teydra', 'kling studio', 'Remotion'], ['Kling Studio', 'Parakeet']), ['Teydra', 'Remotion', 'Kling Studio', 'Parakeet']);
  assert.deepEqual(withWords([], ['  Kling \n Studio ']), ['Kling Studio'], 'spaces as one');
});

test('a control character counts as a space, and a stored spelling with stray spaces still moves', () => {
  assert.equal(wordOf(' Bad\u001bWord\t'), 'Bad Word');
  assert.deepEqual(withWords(['Teydra'], ['Kling\u0000Studio']), ['Teydra', 'Kling Studio']);
  assert.deepEqual(withWords(['Teydra ', 'Kling  Studio', 'Remotion'], ['teydra', 'Kling Studio']), ['Remotion', 'teydra', 'Kling Studio']);
  assert.deepEqual(vocabularyWords(['Kling\u001bStudio ']), ['Kling Studio']);
});

test('words over 80 characters, empty words and duplicates within one call are dropped', () => {
  const long = 'x'.repeat(WORD_CHARS + 1);
  assert.deepEqual(withWords(['Teydra'], [long, '', '   ', 'Kling', 'kling', 'KLING', 'x'.repeat(WORD_CHARS)]), ['Teydra', 'Kling', 'x'.repeat(WORD_CHARS)]);
});

test('with 1,000 words, adding one drops the oldest', () => {
  const full = Array.from({ length: MAX_WORDS }, (_v, i) => `word${i}`);
  const next = withWords(full, ['Teydra']);
  assert.equal(next.length, MAX_WORDS);
  assert.deepEqual([next[0], next.at(-2), next.at(-1)], ['word1', `word${MAX_WORDS - 1}`, 'Teydra']);
  assert.equal(full.length, MAX_WORDS, 'the given list stays as it was');
});
