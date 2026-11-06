// The composer's dictated mark on send (ui/chat/composer/draft-speech.ts takeDraftSpeech): a dictated draft goes
// out marked as spoken (spokenMeta(false)), the mark leaves at once, and a failed send gives it back with the text,
// so the retry is still sent as dictated; a typed draft carries nothing.
// Owns: these assertions only. Never: a real microphone or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictatedDrafts, markDictated, takeDraftSpeech } from '../../../src/ui/chat/composer/draft-speech.ts';
import { spokenMeta } from '../../../src/shared/voice/conversation.ts';

test('takeDraftSpeech: a dictated draft is sent as spoken, the mark leaves, restore() gives it back', () => {
  markDictated('ch_1');
  const taken = takeDraftSpeech('ch_1');
  assert.deepEqual(taken.speech, spokenMeta(false));
  assert.equal(dictatedDrafts.value.has('ch_1'), false, 'gone while the send is in flight');
  taken.restore(); // the send failed
  assert.equal(dictatedDrafts.value.has('ch_1'), true, 'back with the draft text');

  const typed = takeDraftSpeech('ch_2');
  assert.equal(typed.speech, undefined);
  typed.restore();
  assert.equal(dictatedDrafts.value.has('ch_2'), false, 'nothing is invented for a typed draft');
});
