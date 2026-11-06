// End-to-end (MM6): deleting media and reclaiming blobs over the real headless runtime (built
// app/runtime-cli.mjs, deterministic fake engine, real WebSocket RPC, temp profile).
// The test shortens the clean-up's 60 s grace with WORKFORCE_TEST_FILE_GRACE_MS (the seam only
// shortens it); chats have no agents, so no turn ever uses the files.
// Covers: media.uses lists the message that attaches a file (with its chat and line) and
// counts a message that only links to it; media.delete is refused ('conflict') without that
// message and removes message, row and blob with it, while the linking message stays; a deleted
// message frees its young file once the grace passed (one timer, no polling in the runtime);
// deleting a chat keeps a file another chat still shows and moves its library row there; an
// agent's avatar keeps a file (conflict); a deletion whose clean-up a quit interrupted is
// finished by the next start.
// Run: npm run build && node --test test/e2e/runtime-media-delete.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startRuntime } from './lib/runtime-client.mjs';

const GRACE_MS = 1500;

/** A tiny valid PNG header (IHDR 2×2) – enough for type sniffing (avatars must be images). */
function png() {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(2, 16);
  bytes.writeUInt32BE(2, 20);
  bytes[24] = 8; bytes[25] = 6;
  return bytes;
}

/** The test waits by checking again (the runtime itself never polls). */
async function until(check, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });
}

test('media delete and blob clean-up', { timeout: 240_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-'));
  const env = { WORKFORCE_TEST_FILE_GRACE_MS: String(GRACE_MS) };
  let runtime = await startRuntime({ dataDir, keepData: true, env });
  t.after(async () => {
    await runtime.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  let client = runtime.client;
  const blob = (id) => path.join(dataDir, 'blobs', id.slice(0, 2), id.slice(2, 4), id);
  const upload = (bytes, name, mime = 'text/plain') => client.call('files.upload', { name, mime, dataBase64: Buffer.from(bytes).toString('base64') });
  const send = (conversationId, file) => client.call('messages.send', { conversationId, body: 'see attached', attachments: [{ fileId: file.id, name: file.name }] });
  const stored = (id) => client.call('files.get', { id }).then(() => true, (error) => { if (error.code === 'not_found') return false; throw error; });
  const row = async (id) => (await client.call('media.list', { limit: 500 })).find((info) => info.fileId === id);

  const chat = await client.call('chats.create', { title: 'Recordings', agentIds: [] });
  const other = await client.call('chats.create', { title: 'Shared', agentIds: [] });

  // 1. A file in a message: listed, refused without the message, deleted with it at once.
  const secret = await upload('a sensitive recording', 'memo.txt');
  const message = await send(chat.id, secret);
  const link = await client.call('messages.send', { conversationId: other.id, body: `Report: the recording is ${secret.id}` });
  const uses = await client.call('media.uses', { fileId: secret.id });
  assert.deepEqual(uses.messages, [{ id: message.id, conversationId: chat.id, chat: 'Recordings', preview: 'see attached' }]);
  assert.equal(uses.mentions, 1, 'the linking message is a mention, not a message that goes');
  assert.deepEqual(uses.other, []);
  await rejectsWith(client.call('media.delete', { fileId: secret.id }), 'conflict');
  assert.ok(existsSync(blob(secret.id)), 'refused: nothing changed');
  assert.deepEqual(await client.call('media.delete', { fileId: secret.id, messageIds: [message.id] }), { ok: true });
  assert.equal(await stored(secret.id), false, 'the file is gone at once');
  assert.ok(!existsSync(blob(secret.id)), 'and its blob');
  assert.equal(await row(secret.id), undefined, 'and its library row');
  assert.ok(!(await client.call('messages.list', { conversationId: chat.id })).some((m) => m.id === message.id), 'the confirmed message went with it');
  assert.ok((await client.call('messages.list', { conversationId: other.id })).some((m) => m.id === link.id), 'the message that only links to it stays');

  // 2. A deleted message frees its (young) file once the grace passed.
  const oops = await upload('sent by mistake', 'oops.txt');
  const wrong = await send(chat.id, oops);
  await client.call('messages.delete', { id: wrong.id });
  assert.ok(existsSync(blob(oops.id)), 'younger than the grace: kept for now');
  await until(async () => !(await stored(oops.id)) && !existsSync(blob(oops.id)), 'the freed file is reclaimed');

  // 3. Deleting a chat keeps a file another chat still shows; its row moves there.
  const shared = await upload('shared chart', 'chart.txt');
  await send(chat.id, shared);
  await send(other.id, shared);
  assert.equal((await row(shared.id)).conversationId, chat.id, 'the first chat owns the row');
  await client.call('chats.delete', { id: chat.id });
  await until(async () => (await row(shared.id))?.conversationId === other.id, 'the row moves to the chat that still shows the file');
  assert.equal(await stored(shared.id), true);
  assert.ok(existsSync(blob(shared.id)));

  // 4. An agent's avatar keeps a file.
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const face = await upload(png(), 'face.png', 'image/png');
  await client.call('agents.update', { id: manager.id, patch: { avatar: { kind: 'image', value: face.id } } });
  assert.deepEqual((await client.call('media.uses', { fileId: face.id })).other, ['avatar']);
  await rejectsWith(client.call('media.delete', { fileId: face.id }), 'conflict');
  assert.equal(await stored(face.id), true);

  // 5. A clean-up a quit interrupted is finished by the next start.
  const late = await upload('deleted right before quitting', 'late.txt');
  const last = await send(other.id, late);
  await client.call('messages.delete', { id: last.id });
  await runtime.stop();
  assert.ok(existsSync(blob(late.id)), 'still young when the app quit');
  runtime = await startRuntime({ dataDir, keepData: true, env });
  client = runtime.client;
  await until(async () => !(await stored(late.id)) && !existsSync(blob(late.id)), 'the next start reclaims it');
  assert.equal(await stored(shared.id), true, 'files still in use stay');
  assert.equal(await stored(face.id), true);
});
