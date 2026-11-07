// Feedback delivery in words (src/ui/feedback/delivery.ts): the one action says Send only where this build can send
// (Save while that is unknown), and the result line names where the report is – on a phone "your PC".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSendAgain, doneText, sendAgainLabel, sendLabel, SHOT_HINT, SHOT_LABEL, SHOT_MISSING } from '../../../src/ui/feedback/delivery.ts';

test('the one action says Send only where this build can send, Save while unknown or not set up', () => {
  assert.equal(sendLabel(true, false), 'Send');
  assert.equal(sendLabel(true, true), 'Sending…');
  assert.equal(sendLabel(false, false), 'Save');
  assert.equal(sendLabel(undefined, false), 'Save', 'unknown: only saves');
  assert.equal(sendLabel(false, true), 'Saving…');
});

test('the result line: sent, received, or saved on the PC (a phone names "your PC")', () => {
  assert.equal(doneText('sent', true, true), 'Sent to the team.');
  assert.equal(doneText('received', true, false), 'Received.');
  assert.equal(doneText('local', true, true), 'Not sent. Your report is saved on this PC.', 'AF-003: an unconfirmed attempt says Not sent first');
  assert.equal(doneText('local', false, true), 'Saved on this PC – sending is not set up.');
  assert.equal(doneText('local', false, false), 'Saved on your PC – sending is not set up.');
});

test('an unconfirmed send offers "Send again" in the Close cell, only where sending works', () => {
  assert.equal(canSendAgain('local', true), true);
  assert.equal(canSendAgain('queued', true), true);
  assert.equal(canSendAgain('sent', true), false, 'confirmed: Close');
  assert.equal(canSendAgain('received', true), false);
  assert.equal(canSendAgain('local', false), false, 'sending is not set up: Close');
  assert.equal(canSendAgain('local', undefined), false, 'unknown: nothing that could send');
  assert.equal(sendAgainLabel(false), 'Send again');
  assert.equal(sendAgainLabel(true), 'Sending…');
});

test('the screenshot row is short and promises nothing public', () => {
  assert.equal(SHOT_LABEL, 'Screenshot');
  assert.equal(SHOT_HINT, 'Paint over anything private.');
  assert.equal(SHOT_MISSING, 'The window could not be captured.');
  for (const text of [SHOT_LABEL, SHOT_HINT, SHOT_MISSING]) assert.doesNotMatch(text, /GitHub|public/i);
});
