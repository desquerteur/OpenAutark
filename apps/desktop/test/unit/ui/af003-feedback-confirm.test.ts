// AF-003 in the form's words: Bug or Idea (Bug unless chosen), "Sent to the team." with "Report no. …" after a
// delivery, "Not sent." first when a send was not confirmed, and the number in Settings › Feedback's report line.
// Owns: these assertions. Never: RPC or rendering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneText, receiptText } from '../../../src/ui/feedback/delivery.ts';
import { DRAFT_KINDS, draftKind, EMPTY_DRAFT } from '../../../src/ui/feedback/draft.ts';
import { reportLine } from '../../../src/ui/settings/feedback-text.ts';

const RECEIPT = '668fc8de-df52-405c-8743-d264e47cfadd';

test('the form offers Bug and Idea; a new draft is a Bug', () => {
  assert.deepEqual(DRAFT_KINDS.map((option) => [option.kind, option.label]), [['bug', 'Bug'], ['idea', 'Idea']]);
  assert.equal(draftKind(EMPTY_DRAFT), 'bug');
  assert.equal(draftKind({ kind: 'idea' }), 'idea');
  assert.equal(draftKind({ kind: undefined }), 'bug');
});

test('after Send: the confirmation with the number; an unconfirmed send never reads like a success', () => {
  assert.equal(doneText('sent', true, true), 'Sent to the team.');
  assert.equal(receiptText({ status: 'sent', receiptId: RECEIPT }), 'Report no. 668FC8DE');
  assert.equal(receiptText({ status: 'sent' }), '', 'no receipt, no number');
  assert.equal(receiptText({ status: 'local', receiptId: RECEIPT }), '', 'only a delivered report has a number');
  assert.equal(doneText('local', true, true), 'Not sent. Your report is saved on this PC.');
  assert.equal(doneText('local', true, false), 'Not sent. Your report is saved on your PC.');
  assert.equal(doneText('local', false, true), 'Saved on this PC – sending is not set up.');
});

test('Settings › Feedback: a delivered report shows its number', () => {
  const when = () => 'then';
  const base = { kind: 'idea' as const, author: 'human', status: 'sent' as const, createdAt: 1, receiptId: RECEIPT };
  assert.equal(reportLine(base, () => 'Ada', when), 'Idea · Sent to the team · No. 668FC8DE · then');
  assert.equal(reportLine({ ...base, status: 'local' }, () => 'Ada', when), 'Idea · Saved on this PC · then', 'not sent: no number');
});
