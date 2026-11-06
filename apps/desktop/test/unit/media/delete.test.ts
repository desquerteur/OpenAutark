// MM6 media.uses / media.delete (src/runtime/media/delete.ts via MediaService): the person
// deletes a stored file for good – at once, without the clean-up's grace – together with the
// messages they confirmed; refused ('conflict', details.uses) while another message, any other
// place or a running agent still uses it; never deletes a message that was not confirmed or
// does not attach or show the file – a message that only links to it stays. media.uses names
// each message's chat and line and the other files only those messages hold. Plus the shared
// wording of the uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { Blobs } from '../../../src/runtime/files/store.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { usesText, type MediaUses } from '../../../src/shared/model/media-uses.ts';
import { str } from './fixtures.ts';
import { mediaSetup } from './setup.ts';

async function conflict(promise: Promise<unknown>): Promise<MediaUses & { message: string }> {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof WorkforceError, 'refused with a WorkforceError');
  assert.equal(caught.code, 'conflict');
  return { ...(caught.details?.uses as MediaUses), message: caught.message };
}

test('a file in a message: listed by media.uses, refused without the message, deleted with it at once', async () => {
  const { h, temp, media, chat, put, attach } = mediaSetup();
  try {
    const file = await put(str('voice memo'), 'memo.txt');
    const message = attach(chat.id, file);
    assert.deepEqual(media.uses(file.id), { messages: [{ id: message.id, conversationId: chat.id, chat: 'Brand', preview: 'see attached' }], other: [] });

    const refused = await conflict(media.delete(file.id));
    assert.deepEqual(refused.messages.map((m) => m.id), [message.id]);
    assert.equal(refused.message, 'This file is still in a message.');
    assert.ok(h.services.files.get(file.id), 'nothing changed');

    const path = h.services.files.path(file.id);
    await media.delete(file.id, { messageIds: [message.id] });
    assert.equal(h.chats.message(message.id), undefined, 'the confirmed message is gone');
    assert.ok(h.of('message.removed').some((event) => event.id === message.id));
    assert.equal(h.services.files.get(file.id), undefined, 'no grace for the person: removed now');
    assert.equal(media.get(file.id), undefined);
    assert.ok(!existsSync(path), 'the blob is gone');
  } finally { temp.cleanup(); }
});

test('only confirmed messages that show the file are deleted; a newer use is refused', async () => {
  const { h, temp, media, chat, other, put, attach } = mediaSetup();
  try {
    const file = await put(str('photo'), 'photo.txt');
    const first = attach(chat.id, file);
    const unrelated = h.chats.send({ conversationId: chat.id, body: 'no files here', authorId: 'human' });
    const second = attach(other.id, file); // appeared after the person looked
    const refused = await conflict(media.delete(file.id, { messageIds: [first.id, unrelated.id] }));
    assert.equal(refused.message, 'This file is still in 2 messages.');
    assert.ok(h.chats.message(first.id) && h.chats.message(unrelated.id) && h.chats.message(second.id), 'nothing deleted');

    await media.delete(file.id, { messageIds: [first.id, second.id, unrelated.id] });
    assert.ok(h.chats.message(unrelated.id), 'a message that does not show the file stays');
    assert.equal(h.chats.message(second.id), undefined);
    assert.equal(h.services.files.get(file.id), undefined);
  } finally { temp.cleanup(); }
});

test('a message that only links to the file stays; the other files of a deleted message are named and go with it', async () => {
  const { h, temp, media, chat, other, put } = mediaSetup();
  try {
    const recording = await put(str('sensitive recording'), 'memo.webm');
    const contract = await put(str('contract draft'), 'contract.pdf');
    const shared = await put(str('shared photo'), 'photo.png');
    const toAttachment = (file: typeof recording) => ({ fileId: file.id, name: file.name, mime: file.mime, size: file.size });
    const message = h.chats.send({ conversationId: chat.id, body: 'two files', authorId: 'human', attachments: [recording, contract, shared].map(toAttachment) });
    h.chats.send({ conversationId: other.id, body: 'same photo here', authorId: 'human', attachments: [toAttachment(shared)] });
    const report = h.chats.send({ conversationId: other.id, body: `Long agent report … see file ${recording.id} for details`, authorId: 'human' });

    const uses = media.uses(recording.id);
    assert.deepEqual(uses.messages, [{ id: message.id, conversationId: chat.id, chat: 'Brand', preview: 'two files' }], 'the report is no message use');
    assert.equal(uses.mentions, 1, 'it is counted as a mention');
    assert.deepEqual(uses.alongside, [{ fileId: contract.id, name: 'contract.pdf' }], 'the photo another chat keeps is not named');

    h.clock.advance(61_000);
    await media.delete(recording.id, { messageIds: [message.id, report.id] }); // a stale list naming the report too
    await (h.services.files as unknown as Blobs).cleanup.idle();
    assert.equal(h.services.files.get(recording.id), undefined);
    assert.equal(h.chats.message(message.id), undefined, 'the confirmed message went');
    assert.ok(h.chats.message(report.id), 'the message that only links to it stays');
    assert.equal(h.services.files.get(contract.id), undefined, 'the named other file went with its message');
    assert.ok(h.services.files.get(shared.id), 'a file another message shows stays');
  } finally { temp.cleanup(); }
});

test('other uses and a running agent refuse the deletion; unknown files are not found', async () => {
  const { h, temp, media, put } = mediaSetup();
  try {
    const avatar = await put(str('face'), 'face.txt');
    h.db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_x', 'X', ?, 'human', 0, 0)`,
      [JSON.stringify({ kind: 'image', value: avatar.id })]);
    h.chats.saveDraft(h.chats.list()[0].id, 'draft', [{ fileId: avatar.id, name: 'face.txt', mime: 'text/plain', size: 4 }]);
    const refused = await conflict(media.delete(avatar.id));
    assert.deepEqual(refused.other, ['draft', 'avatar']);
    assert.equal(refused.message, "This file is still used by an unsent draft and an agent's avatar. Remove it there first.");

    const busy = await put(str('busy'), 'busy.txt');
    h.db.run(`INSERT INTO runs (id, agent_id, trigger, status) VALUES ('run_1', 'ag_ada', 'message', 'running')`);
    h.db.run(`INSERT INTO run_items (id, run_id, seq, kind, data, created_at) VALUES ('ri_1', 'run_1', 1, 'tool_call', ?, 0)`, [JSON.stringify({ path: h.services.files.path(busy.id) })]);
    assert.equal(media.uses(busy.id).busy, true);
    const working = await conflict(media.delete(busy.id));
    assert.equal(working.message, 'An agent is working with this file right now. Try again when it is done.');
    assert.ok(h.services.files.get(busy.id));

    await assert.rejects(media.delete('f'.repeat(64)), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
    assert.throws(() => media.uses('not-a-file'), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
  } finally { temp.cleanup(); }
});

test('a file nothing uses is deleted right away; the description and cached text go with it', async () => {
  const { h, temp, media, put } = mediaSetup();
  try {
    const file = await put(str('private notes'), 'notes.txt');
    media.describe(file.id, { description: 'Private' }, 'human');
    assert.equal(await h.services.files.text(file.id), 'private notes');
    await media.delete(file.id);
    assert.equal(h.services.files.get(file.id), undefined);
    assert.equal(h.db.get('SELECT 1 AS ok FROM files WHERE id = ?', [file.id]), undefined, 'the text cache row is gone');
    assert.equal(h.db.get('SELECT 1 AS ok FROM media_fts WHERE file_id = ?', [file.id]), undefined, 'no search entry is left');
    assert.deepEqual(media.list({ text: 'Private' }), []);
  } finally { temp.cleanup(); }
});

test('usesText names what keeps a file', () => {
  assert.equal(usesText({ messages: [], other: [] }), '');
  assert.equal(usesText({ messages: [{ id: 'm1', conversationId: 'c' }], other: [] }), 'a message');
  assert.equal(usesText({ messages: [{ id: 'm1', conversationId: 'c' }, { id: 'm2', conversationId: 'c' }], moreMessages: true, other: ['knowledge'] }),
    'more than 2 messages and a memory');
  assert.equal(usesText({ messages: [], other: ['task', 'chat', 'app'] }), "a task or to-do, a chat's picture and saved mini-app data");
});
