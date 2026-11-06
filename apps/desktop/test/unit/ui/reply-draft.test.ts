// C6 – the composer's reply (ui/chat/composer/draft.ts): setReply marks the message the next send
// answers, in memory only (nothing is saved for it); it stays through typing and an emptied field,
// goes with clearDraft (the send) and comes back when a
// failed send restores the draft. The store (ui/lib/store.ts putMessage) keeps a row below the
// loaded pages' floor (a tombstone of an older message) out of the list, so paging older history
// skips nothing, while the tombstone of the oldest loaded message takes that message's place.
// Owns: these assertions only. Never: a real runtime (rpc.call and rpc.onOpen are fakes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../src/shared/model/chat.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';

const saves: Array<{ conversationId: string; text: string }> = [];
/** What the fake messages.list returns next. */
let page: Message[] = [];
(rpc as unknown as { onOpen: unknown }).onOpen = () => () => undefined;
(rpc as unknown as { call: unknown }).call = async (method: string, params: (typeof saves)[number]) => {
  if (method === 'ui.saveDraft') saves.push(params);
  if (method === 'messages.list') return page;
  return { ok: true };
};
const { clearDraft, draftFor, flushDraft, setReply, updateDraft } = await import('../../../src/ui/chat/composer/draft.ts');

const row = (conversationId: string, seq: number, patch: Partial<Message> = {}) => ({
  id: `msg_${seq}`, conversationId, seq, authorId: 'human', authorKind: 'human', kind: 'text', body: `#${seq}`, attachments: [], mentions: [],
  priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: seq, ...patch,
}) as Message;
/** The quiet tombstone chat/message-edits.ts leaves at a deleted message's seq. */
const stoneOf = (deleted: Message) => row(deleted.conversationId, deleted.seq, {
  id: `msg_stone_${deleted.seq}`, authorId: 'system', authorKind: 'system', kind: 'status', silent: true, body: 'Message deleted',
  meta: { status: { type: 'note', text: 'Message deleted', details: { tombstone: deleted.id } } },
});

test('a reply stays with the draft until it is sent or cancelled, and is never saved', () => {
  setReply('cv_a', 'msg_quoted');
  assert.equal(draftFor('cv_a').value.replyTo, 'msg_quoted');
  flushDraft('cv_a');
  assert.equal(saves.length, 0, 'setting a reply saves nothing');

  updateDraft('cv_a', { text: 'Shorter, please' });
  updateDraft('cv_a', { text: '' });
  assert.equal(draftFor('cv_a').value.replyTo, 'msg_quoted', 'an emptied field keeps the reply');
  flushDraft('cv_a');
  assert.deepEqual(Object.keys(saves[0]).sort(), ['attachments', 'conversationId', 'text'], 'the saved draft carries no reply');

  setReply('cv_a', null);
  assert.equal('replyTo' in draftFor('cv_a').value, false, 'cancelled');
  assert.equal(draftFor('cv_b').value.replyTo, undefined, 'per chat');
});

test('the send clears the reply; a failed send gives it back with the draft', () => {
  setReply('cv_c', 'msg_one');
  updateDraft('cv_c', { text: 'Agreed' });
  const saved = draftFor('cv_c').value;
  clearDraft('cv_c');
  assert.equal(draftFor('cv_c').value.replyTo, undefined);
  updateDraft('cv_c', { ...saved, text: 'Agreed' }); // Composer.send after a failed messages.send
  assert.equal(draftFor('cv_c').value.replyTo, 'msg_one');
  setReply('cv_c', 'msg_two');
  assert.equal(draftFor('cv_c').value.replyTo, 'msg_two', 'Reply on another message replaces it');
  assert.equal(draftFor('cv_c').value.text, 'Agreed', 'and keeps the text');
});

test('a tombstone for a message before the loaded page waits for loadOlder; with all history loaded it takes its place', async () => {
  const { historyComplete, messagesFor, putMessage } = await import('../../../src/ui/lib/store.ts');
  const list = messagesFor('cv_page');
  list.value = [row('cv_page', 61), row('cv_page', 62), row('cv_page', 63)]; // the newest page: 1–60 are not loaded
  historyComplete.delete('cv_page');
  putMessage(stoneOf(row('cv_page', 10)));
  assert.deepEqual(list.value.map((message) => message.seq), [61, 62, 63], 'the paging cursor stays at #61');
  putMessage(row('cv_page', 64));
  assert.deepEqual(list.value.map((message) => message.seq), [61, 62, 63, 64], 'a new message is appended as before');

  list.value = [row('cv_page', 9), row('cv_page', 11)];
  historyComplete.add('cv_page');
  putMessage(stoneOf(row('cv_page', 10)));
  assert.deepEqual(list.value.map((message) => message.id), ['msg_9', 'msg_stone_10', 'msg_11'], 'all history loaded: at its seq');
});

test('deleting the oldest loaded message: its tombstone takes its place, older rows still wait for loadOlder', async () => {
  const { historyComplete, loadMessages, loadOlder, messagesFor, putMessage } = await import('../../../src/ui/lib/store.ts');
  page = Array.from({ length: 60 }, (_, i) => row('cv_floor', 41 + i)); // a full page: #1–#40 are not loaded
  await loadMessages('cv_floor');
  assert.equal(historyComplete.has('cv_floor'), false);
  const list = messagesFor('cv_floor');
  const oldest = list.value[0];
  list.value = list.value.filter((message) => message.id !== oldest.id); // store-events.ts on 'message.removed'
  putMessage(stoneOf(oldest));
  assert.deepEqual(list.value.slice(0, 2).map((message) => message.id), ['msg_stone_41', 'msg_42'], 'the tombstone shows at once, at #41');
  putMessage(stoneOf(row('cv_floor', 40)));
  assert.equal(list.value[0].id, 'msg_stone_41', 'a row below the floor still waits');

  page = [row('cv_floor', 39), stoneOf(row('cv_floor', 40))]; // the rest of the history
  assert.equal(await loadOlder('cv_floor'), 2);
  assert.equal(historyComplete.has('cv_floor'), true);
  assert.deepEqual(list.value.slice(0, 3).map((message) => message.id), ['msg_39', 'msg_stone_40', 'msg_stone_41']);
});
