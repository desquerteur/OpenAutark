// The strip above the chat composer (B-078 D9, src/ui/tasks/ask-strip-model.ts): the newest open important to-do
// anchored to a message – this chat's first, else any chat's – and the quick answers it offers; the strip's
// component fills the composer as a reply (setReply + composerFill), the person sends.
// Owns: these assertions only. Never: the DOM or rpc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { STRIP_ANSWERS, isStripAsk, stripAnswers, stripAsk } from '../../../src/ui/tasks/ask-strip-model.ts';

let seq = 0;
const todo = (patch: Partial<TaskView> = {}): TaskView => {
  seq++;
  return {
    id: `task_${seq}`, title: `Ask ${seq}`, notes: '', status: 'open', assigneeKind: 'human', createdBy: 'ag_ava', priority: 1, ledger: {}, attempts: 0,
    sort: seq, rev: 1, createdAt: 1000 + seq, updatedAt: 1000 + seq, steps: [], progress: { done: 0, total: 0 }, conversationTitle: '', running: false,
    conversationId: 'ch_a', messageId: `msg_${seq}`, widget: { type: 'choice', question: 'q', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }, ...patch,
  } as TaskView;
};

test('only open, important asks anchored to a chat message are strip asks', () => {
  assert.equal(isStripAsk(todo()), true);
  assert.equal(isStripAsk(todo({ priority: 0 })), false, 'an ordinary to-do');
  assert.equal(isStripAsk(todo({ priority: 0, widget: { type: 'confirm', important: true } })), true, 'the block said important');
  assert.equal(isStripAsk(todo({ messageId: undefined })), false, 'nothing to jump to');
  assert.equal(isStripAsk(todo({ conversationId: undefined })), false, 'a chat-free to-do');
  assert.equal(isStripAsk(todo({ status: 'done' })), false);
  assert.equal(isStripAsk(todo({ assigneeKind: 'agent' })), false);
  assert.equal(isStripAsk(todo({ widget: { type: 'app' } as unknown as TaskView['widget'] })), false, 'a mini-app lives on My day');
});

test('this chat\'s newest important ask first, else the newest of any chat', () => {
  const older = todo({ conversationId: 'ch_b' });
  const here = todo({ conversationId: 'ch_b' });
  const elsewhere = todo({ conversationId: 'ch_c' });
  assert.equal(stripAsk([older, here, elsewhere], 'ch_b')?.id, here.id);
  assert.equal(stripAsk([older, here, elsewhere], 'ch_z')?.id, elsewhere.id);
  assert.equal(stripAsk([todo({ priority: 0 })], 'ch_a'), undefined);
});

test('the quick answers: a choice\'s options (at most three), a confirm\'s label, an old approve card\'s Yes / No', () => {
  assert.deepEqual(stripAnswers({ type: 'choice', options: ['One', { label: 'Two' }, 'Three', 'Four'] }), ['One', 'Two', 'Three'].slice(0, STRIP_ANSWERS));
  assert.deepEqual(stripAnswers({ type: 'confirm', instructions: 'x' }), ['Done']);
  assert.deepEqual(stripAnswers({ type: 'confirm', confirmLabel: 'Plugged in' }), ['Plugged in']);
  assert.deepEqual(stripAnswers({ type: 'approve', action: 'x' }), ['Yes', 'No']);
  assert.deepEqual(stripAnswers({ type: 'form', fields: [] }), [], 'a form is answered by a reply');
});

test('the strip fills the composer as a reply and sends nothing itself; it sits between the messages and the composer', () => {
  const root = path.resolve(import.meta.dirname, '../../../src/ui');
  const strip = readFileSync(path.join(root, 'chat/AskStrip.tsx'), 'utf8');
  assert.match(strip, /setReply\(chatId, messageId\)/);
  assert.match(strip, /composerFill\.value = \{ conversationId: chatId/);
  assert.match(strip, /jumpToMessage\(chatId, messageId\)/, 'the text jumps to the message');
  assert.doesNotMatch(strip, /submitAnswer|rpc\.call/, 'the person sends');
  const view = readFileSync(path.join(root, 'chat/ChatView.tsx'), 'utf8');
  assert.match(view, /<MessageList [^\n]*\/>\s*<AskStrip conversationId=\{conversationId\} \/>\s*<Composer chat=\{chat\} \/>/);
});
