// `/ws` client sockets (Hello handshake, scopes, timeouts, revocation) and `/peer` upgrades.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CLOSE, ClientSockets, Keepalive } from '../../../src/runtime/http/ws.ts';
import type { RpcConnection } from '../../../src/runtime/http/types.ts';
import { silentLog } from '../devices/fakes.ts';
import { DEVICE_TOKEN, LAUNCH_TOKEN, REMOVED_TOKEN, closeCode, fixture, nextMessage, openSocket } from './fixture.ts';

const hello = (token: string) => JSON.stringify({ protocol: 1, token, client: 'pwa' });

test('owner token in the Hello attaches with owner scope; frames flow both ways', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const ws = await openSocket(`ws://127.0.0.1:${port}/ws`);
    ws.send(hello(LAUNCH_TOKEN));
    // Sent right after the Hello, like the UI client does.
    ws.send(JSON.stringify({ id: 1, method: 'events.subscribe', params: { topics: ['chats'] } }));
    const reply = await nextMessage(ws);
    assert.deepEqual(reply, { id: 1, result: { method: 'events.subscribe', scope: 'owner' } });
    assert.deepEqual(f.rpc.attached.map((entry) => entry.scope), [{ kind: 'owner' }]);
    const closing = closeCode(ws);
    ws.close();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.rpc.detached, 1);
  } finally {
    await f.close();
  }
});

test('device token → device scope; unknown token → 4401; missing Hello → closed after the timeout', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const device = await openSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://localhost:${port}` });
    device.send(hello(DEVICE_TOKEN));
    device.send(JSON.stringify({ id: 2, method: 'todos.list' }));
    assert.deepEqual(await nextMessage(device), { id: 2, result: { method: 'todos.list', scope: 'device' } });
    assert.deepEqual(f.rpc.attached[0].scope, { kind: 'device', deviceId: 'dev_phone0000001', capabilities: ['todo'], secure: true }, 'loopback counts as a secure transport');

    const stranger = await openSocket(`ws://127.0.0.1:${port}/ws`);
    const strangerClosed = closeCode(stranger);
    stranger.send(hello('not-a-valid-token-at-all-000000'));
    assert.equal(await strangerClosed, 4401);

    // A removed phone (revoked token) hears 4403 – also on a later Hello, so it shows 'This phone was removed'.
    const removed = await openSocket(`ws://127.0.0.1:${port}/ws`);
    const removedClosed = closeCode(removed);
    removed.send(hello(REMOVED_TOKEN));
    assert.equal(await removedClosed, 4403);

    const silent = await openSocket(`ws://127.0.0.1:${port}/ws`);
    assert.equal(await closeCode(silent), 4408);

    const garbage = await openSocket(`ws://127.0.0.1:${port}/ws`);
    const garbageClosed = closeCode(garbage);
    garbage.send('not json');
    assert.equal(await garbageClosed, 4400);
    assert.equal(f.rpc.attached.length, 1);
    device.close();
  } finally {
    await f.close();
  }
});

test('upgrade is refused for foreign hosts and origins', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/ws`, { host: 'evil.example' }), /status 403/);
    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' }), /status 403/);
    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/nope`), /status 404/);
  } finally {
    await f.close();
  }
});

test('revoking a device drops its live connections', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const device = await openSocket(`ws://127.0.0.1:${port}/ws`);
    device.send(hello(DEVICE_TOKEN));
    device.send(JSON.stringify({ id: 1, method: 'todos.list' }));
    await nextMessage(device);
    const owner = await openSocket(`ws://127.0.0.1:${port}/ws`);
    owner.send(hello(LAUNCH_TOKEN));
    owner.send(JSON.stringify({ id: 1, method: 'x' }));
    await nextMessage(owner);
    const closed = closeCode(device);
    f.bus.emit('device.upserted', { id: 'dev_phone0000001', name: 'Phone', kind: 'phone', role: 'client', fingerprint: '', addresses: [], caps: {}, status: 'revoked', self: false });
    assert.equal(await closed, 4403);
    assert.equal(owner.readyState, owner.OPEN);
    owner.close();
  } finally {
    await f.close();
  }
});

test('B-078 (D5): an old pwa.enabled false in settings no longer signs a device out; its accepted row decides', async () => {
  for (const event of ['settings.updated', 'pwa.updated'] as const) {
    const f = fixture({ pwaEnabled: true });
    try {
      const { port } = await f.server.listen();
      const device = await openSocket(`ws://127.0.0.1:${port}/ws`);
      device.send(hello(DEVICE_TOKEN));
      device.send(JSON.stringify({ id: 1, method: 'todos.list' }));
      await nextMessage(device);
      f.settings.pwa.enabled = false;
      if (event === 'settings.updated') f.bus.emit('settings.updated', f.settings as never);
      else f.bus.emit('pwa.updated', { enabled: false, urls: [], secure: false, devices: [], pushReady: false });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(device.readyState, device.OPEN, event);
      device.close();
    } finally {
      await f.close();
    }
  }
});

test('/peer upgrades are handed to the mesh; close() ends every socket', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const peer = await openSocket(`ws://127.0.0.1:${port}/peer`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.accepted.length, 1);
    const client = await openSocket(`ws://127.0.0.1:${port}/ws`);
    client.send(hello(LAUNCH_TOKEN));
    const peerClosed = closeCode(peer);
    const clientClosed = closeCode(client);
    await f.server.close();
    assert.ok([1001, 1006].includes(await peerClosed));
    assert.ok([1001, 1006].includes(await clientClosed));
  } finally {
    await f.close();
  }
});

test('one Hello per socket: frames queued behind a refused Hello are never authenticated', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const ws = await openSocket(`ws://127.0.0.1:${port}/ws`);
    const closed = closeCode(ws);
    ws.send(hello('wrong-token-0123456789abcdef'));
    ws.send(hello(DEVICE_TOKEN)); // a second guess on the same connection
    assert.equal(await closed, 4401);
    assert.deepEqual(f.authCalls, ['wrong-token-0123456789abcdef']);
    assert.equal(f.rpc.attached.length, 0);
  } finally {
    await f.close();
  }
});

test('an upload chunk frame (4 MB raw as base64) fits; larger frames close the socket', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const ws = await openSocket(`ws://127.0.0.1:${port}/ws`);
    ws.send(hello(LAUNCH_TOKEN));
    const chunk = 'A'.repeat(Math.ceil((4 * 1024 * 1024) / 3) * 4);
    ws.send(JSON.stringify({ id: 9, method: 'files.uploadChunk', params: { uploadId: 'up_01jab3k9z7mx2c4q', index: 0, dataBase64: chunk, name: 'clip.webm' } }));
    assert.deepEqual(await nextMessage(ws), { id: 9, result: { method: 'files.uploadChunk', scope: 'owner' } });
    const closed = closeCode(ws);
    ws.send('A'.repeat(7 * 1024 * 1024));
    assert.equal(await closed, 1009);
  } finally {
    await f.close();
  }
});

/** Minimal `ws` stand-in: frames are "written" only when `flush()` runs. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  closedWith?: number;
  private pending: Array<() => void> = [];
  send(text: string, done?: () => void): void {
    const bytes = Buffer.byteLength(text);
    this.bufferedAmount += bytes;
    this.pending.push(() => { this.bufferedAmount -= bytes; done?.(); });
  }
  flush(): void { for (const write of this.pending.splice(0)) write(); }
  close(code: number): void { this.closedWith ??= code; }
  ping(): void {}
  terminate(): void {}
}

test('a large reply in flight does not count as a slow consumer; a growing backlog does', () => {
  const keepalive = new Keepalive();
  let connection: RpcConnection | undefined;
  const sockets = new ClientSockets({
    rpc: { attach: (next) => { connection = next; return () => {}; }, handleHttp: async () => ({ id: 0 }) },
    authenticate: () => ({ kind: 'owner' }),
    keepalive,
    log: () => silentLog,
  });
  const ws = new FakeSocket();
  try {
    sockets.accept(ws as never, true);
    ws.emit('message', Buffer.from(hello(LAUNCH_TOKEN)), false);
    assert.ok(connection);
    connection.send({ id: 1, result: { dataBase64: 'x'.repeat(12 * 1024 * 1024) } }); // e.g. files.read
    connection.send({ event: 'notify', data: { title: 'small' } });
    assert.equal(ws.closedWith, undefined);
    ws.flush();
    // The client stops reading: small frames pile up beyond the limit.
    const delta = { event: 'message.delta', data: { text: 'y'.repeat(64 * 1024) } };
    for (let i = 0; i < 140 && ws.closedWith === undefined; i++) connection.send(delta);
    assert.equal(ws.closedWith, CLOSE.slowConsumer);
  } finally {
    keepalive.stop();
  }
});

/** Like `ws`: close() only starts the handshake (CLOSING) and frames may still arrive. */
class ClosingSocket extends FakeSocket {
  override close(code: number): void { super.close(code); this.readyState = 2; }
}

test('frames a locked-out device sends during the close handshake are not delivered', () => {
  const keepalive = new Keepalive();
  const delivered: unknown[] = [];
  const sockets = new ClientSockets({
    rpc: { attach: (connection) => { connection.onMessage((data) => delivered.push(data)); return () => {}; }, handleHttp: async () => ({ id: 0 }) },
    authenticate: () => ({ kind: 'device', deviceId: 'dev_phone0000001', capabilities: ['todo', 'chat'] }),
    keepalive,
    log: () => silentLog,
  });
  try {
    for (const lockOut of [() => sockets.closeDevice('dev_phone0000001')]) {
      delivered.length = 0;
      const ws = new ClosingSocket();
      sockets.accept(ws as never, false);
      ws.emit('message', Buffer.from(hello(DEVICE_TOKEN)), false);
      ws.emit('message', Buffer.from('{"id":1,"method":"todos.list"}'), false);
      assert.equal(delivered.length, 1);
      assert.equal(lockOut(), 1);
      // The client ignores the close frame and keeps going.
      ws.emit('message', Buffer.from('{"id":2,"method":"messages.send"}'), false);
      assert.equal(delivered.length, 1);
      ws.emit('close');
    }
  } finally {
    keepalive.stop();
  }
});
