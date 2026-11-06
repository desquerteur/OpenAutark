// End-to-end (MM2): agent files reach the chat, the media library and a phone over the real
// headless runtime (built app/runtime-cli.mjs, deterministic fake engine, real WebSocket RPC).
// The workspace is the --fake default <data>/workspace (src/runtime/cli.ts) and the runtime's
// home points into the temp profile, so the user's real folders are never touched.
// Covers: the fake engine answers with a media block naming a workspace file → the final
// message carries the stored fileId (path kept, no absolute path added); a second WebSocket
// client with device scope ('todo' + 'chat', like the PWA) reads that file by id and finds it
// under the chat in media.list; chat.send `files` arrive as an attachment the phone can read;
// a path outside the workspace is not stored.
// Run: npm run build && node --test test/e2e/runtime-agent-files.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect, startRuntime } from './lib/runtime-client.mjs';

/** A tiny valid PNG header (IHDR 4×3) – enough for type sniffing and the image size. */
function png() {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(4, 16);
  bytes.writeUInt32BE(3, 20);
  bytes[24] = 8; bytes[25] = 6;
  return bytes;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fromManager = (chatId, managerId, check) => (message) =>
  message.conversationId === chatId && message.authorId === managerId && message.state === 'final' && check(message);

/** Pairs a phone over the real HTTP pairing route; returns its token and device id. */
async function pair(runtime, name) {
  await runtime.client.call('pwa.enable', { enabled: true, bind: 'lan' }); // pairing needs phone access on and an address a phone reaches (B-075)
  const link = await runtime.client.call('pwa.link', { name });
  const secret = decodeURIComponent(new URL(link.url).hash.match(/pair=([^&]+)/)?.[1] ?? '');
  const exchange = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, method: 'pwa.exchange', params: { secret, name } }),
  }).then((response) => response.json());
  assert.ok(exchange.result?.token, 'the secret is exchanged for a device token');
  return exchange.result;
}

test('agent outputs: stored with a fileId, readable by a phone, listed under the chat', { timeout: 240_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-'));
  const home = path.join(dataDir, 'home');
  const workspace = path.join(dataDir, 'workspace'); // the --fake default (src/runtime/cli.ts), not ~/Workforce
  await mkdir(path.join(workspace, 'out'), { recursive: true });
  const image = png();
  await writeFile(path.join(workspace, 'out', 'chart.png'), image);
  await writeFile(path.join(workspace, 'out', 'report.txt'), 'Quarterly report');
  await writeFile(path.join(dataDir, 'outside.txt'), 'not for agents');

  // HOME (POSIX) / USERPROFILE (Windows) decide os.homedir(), so the runtime never sees the real home.
  const runtime = await startRuntime({ dataDir, env: { HOME: home, USERPROFILE: home } });
  t.after(() => runtime.stop());
  const { client } = runtime;
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await client.call('chats.create', { title: 'Deliverables', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });

  // 1. A media block naming a workspace file: the final message carries the stored file id.
  await client.call('messages.send', { conversationId: chat.id, body: 'Show it [[ui:{"type":"media","src":"out/chart.png","caption":"Chart"}]]' });
  const reply = await client.waitFor('message.updated', fromManager(chat.id, manager.id, (message) => message.body.includes('out/chart.png')), 90_000);
  const fileId = /"fileId":"([a-f0-9]{64})"/.exec(reply.body)?.[1];
  assert.equal(fileId, sha256(image), 'the block carries the stored file id');
  assert.ok(reply.body.includes('"src":"out/chart.png"'), 'the path stays for the desktop');
  // The blocks are JSON in the body, so on Windows the path would show up with doubled backslashes.
  assert.ok(!reply.body.includes(workspace) && !reply.body.includes(workspace.replaceAll('\\', '\\\\')), 'no absolute path is added to a media block');

  // 2. A paired phone (one tier: the owner's phone has full access) reads the file by id and sees it under the chat.
  const pairing = await pair(runtime, 'Phone');
  const phone = await connect(runtime.port, pairing.token, 'pwa');
  t.after(() => phone.close());
  const info = await phone.call('session.info');
  assert.ok(info.capabilities.includes('todo') && info.capabilities.includes('chat'), info.capabilities.join(', '));
  const read = await phone.call('files.read', { id: fileId });
  assert.equal(read.mime, 'image/png');
  assert.ok(Buffer.from(read.dataBase64, 'base64').equals(image), 'the phone gets the same bytes');
  const listed = await phone.call('media.list', { conversationId: chat.id });
  assert.ok(listed.some((row) => row.fileId === fileId && row.kind === 'image'), 'the media library lists it under the chat');

  // 3. chat.send files become an attachment the phone can read.
  await client.call('messages.send', { conversationId: chat.id, body: 'Send it [[tool:chat.send {"text":"Report attached","files":["out/report.txt"]}]]' });
  const sent = await client.waitFor('message.created', (message) => message.conversationId === chat.id && message.authorId === manager.id && message.body === 'Report attached', 90_000);
  assert.deepEqual(sent.attachments.map((file) => file.name), ['report.txt']);
  const report = await phone.call('files.read', { id: sent.attachments[0].fileId });
  assert.equal(Buffer.from(report.dataBase64, 'base64').toString('utf8'), 'Quarterly report');

  // 4. A path outside the workspace (an existing file next to it) is not stored.
  await client.call('messages.send', { conversationId: chat.id, body: 'Leak it [[ui:{"type":"file","path":"../outside.txt"}]]' });
  const leak = await client.waitFor('message.updated', fromManager(chat.id, manager.id, (message) => message.body.includes('outside.txt')), 90_000);
  assert.ok(!leak.body.includes('"fileId"'), 'no file id for a path outside the workspace');
  const all = await client.call('media.list', {});
  assert.ok(!all.some((row) => row.name === 'outside.txt'), 'nothing from outside reached the library');
});
