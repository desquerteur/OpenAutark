// C8 wiring of the real HttpServer: an external agent's token opens `/ws` as the scope kind
// 'external' (http/server.ts passes bridges/external-agents.ts externalAgentSockets to
// ClientSockets). From this PC always; from another machine only over a secure transport (the
// tailnet) – never over plain LAN http; an old pwa.enabled false gates nothing since B-078 (no phone
// switch); at most 2 sockets per external agent (more close
// with 1013); 'external.revoked' closes its sockets with 4403. Remote peers are stood in for by
// replacing the server's request-facts step (the sockets are real, on loopback).
// Owns: these checks. Never: opens a socket beyond loopback or uses real accounts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestInfo } from '../../../src/runtime/http/types.ts';
import { isLoopback, isTailnetAddress } from '../../../src/runtime/http/security.ts';
import { closeCode, fixture, nextMessage, openSocket } from './fixture.ts';

const TOKEN = `wfx_${'A'.repeat(43)}`;
const MEMBER = 'ext:api:0123456789:Research-Bot';
const CHAT = 'cnv_01jab3k9z7mx2c4q';

/** A fixture whose chat has the external member and whose tokens table holds its token; `from` moves the next peer. */
function externalFixture(pwaEnabled: boolean) {
  const f = fixture({ pwaEnabled });
  (f.services as unknown as { chats: Record<string, unknown> }).chats.members = (conversationId: string) =>
    conversationId === CHAT ? [{ memberId: MEMBER, kind: 'external', role: 'member', joinedAt: 0, readSeq: 0 }] : [];
  f.services.db.run('INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['tok_external0001', MEMBER, 'external-agent', createHash('sha256').update(TOKEN).digest('hex'), JSON.stringify({ conversationId: CHAT }), 'Research-Bot', 1000]);
  let remote = '127.0.0.1';
  const server = f.server as unknown as { requestFacts(req: IncomingMessage): (RequestInfo & { local: string }) | undefined };
  const original = server.requestFacts.bind(server);
  server.requestFacts = (req) => {
    const info = original(req);
    return info && { ...info, remote, local: isLoopback(remote) ? '127.0.0.1' : isTailnetAddress(remote) ? '100.100.1.1' : '192.168.1.5', loopback: isLoopback(remote) };
  };
  return { ...f, from(address: string) { remote = address; } };
}

/** Opens /ws, sends the Hello and one request: 'open' with the scope the RPC side saw, or the close code. */
async function hello(port: number, token = TOKEN) {
  const ws = await openSocket(`ws://127.0.0.1:${port}/ws`);
  const closed = closeCode(ws);
  ws.send(JSON.stringify({ protocol: 1, token, client: 'external' }));
  ws.send(JSON.stringify({ id: 1, method: 'messages.list' }));
  const outcome = await Promise.race([nextMessage(ws).then((reply: { result?: { scope?: string } }) => reply.result?.scope ?? 'none'), closed]);
  return { ws, outcome, closed };
}

test('an external token opens /ws from this PC as the external scope; unknown tokens hear 4401', async () => {
  const f = externalFixture(false);
  try {
    const { port } = await f.server.listen();
    const { ws, outcome } = await hello(port);
    assert.equal(outcome, 'external', 'phone access off does not matter on this PC');
    assert.deepEqual(f.rpc.attached.at(-1)?.scope, { kind: 'external', memberId: MEMBER, conversationId: CHAT, tokenId: 'tok_external0001' });
    assert.equal((await hello(port, `wfx_${'B'.repeat(43)}`)).outcome, 4401);
    ws.close();
  } finally {
    await f.close();
  }
});

test('from another machine: never over plain LAN http, over the tailnet always', async () => {
  const f = externalFixture(true);
  try {
    const { port } = await f.server.listen();
    (f.settings.pwa as { bind: string }).bind = 'lan';
    f.from('192.168.1.20');
    assert.equal((await hello(port)).outcome, 4401, 'plain LAN http would carry the token in cleartext');
    f.from('100.101.102.103');
    const remote = await hello(port);
    assert.equal(remote.outcome, 'external');
    f.from('127.0.0.1');
    const local = await hello(port);
    assert.equal(local.outcome, 'external');

    // B-078 (D5): an old pwa.enabled false gates nothing any more – the tailnet socket stays, a new one is taken.
    (f.settings.pwa as { enabled: boolean }).enabled = false;
    f.bus.emit('settings.updated', f.settings as never);
    const localGone = local.closed;
    local.ws.close(); // at most two sockets per external agent
    await localGone;
    f.from('100.101.102.103');
    const again = await hello(port);
    assert.equal(again.outcome, 'external');
    assert.equal(remote.ws.readyState, remote.ws.OPEN);
    for (const socket of [remote.ws, again.ws]) socket.close();
  } finally {
    await f.close();
  }
});

test('at most two sockets per external agent; external.revoked closes them with 4403', async () => {
  const f = externalFixture(false);
  try {
    const { port } = await f.server.listen();
    const first = await hello(port);
    const second = await hello(port);
    assert.deepEqual([first.outcome, second.outcome], ['external', 'external']);
    assert.equal((await hello(port)).outcome, 1013, 'the third one is refused, the slots of phones and windows stay free');
    f.bus.emit('external.revoked', { memberId: MEMBER, conversationId: CHAT });
    assert.deepEqual(await Promise.all([first.closed, second.closed]), [4403, 4403]);
  } finally {
    await f.close();
  }
});
