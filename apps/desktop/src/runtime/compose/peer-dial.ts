// Opens the WebSocket to a linked PC's runtime for the device mesh (`<address>/peer`).
// B-077: a socket this PC dialed gets the same ping keepalive as one it accepted (http/keepalive.ts), so a dead link
// closes on this side too within 15–30 s and the mesh redials and catches up.
// Owns: http(s) → ws(s) mapping, connect timeout, frame size limit, the dialed sockets' keepalive. Never: authentication
// (the mesh runs its own pinned-key handshake over this socket).

import WebSocket from 'ws';
import { wrapWs, type SocketLike } from '../devices/channel.ts';
import { Keepalive } from '../http/keepalive.ts';

const CONNECT_TIMEOUT_MS = 10_000;
/** One interval for every socket this process dialed (armed only while one is open). */
const keepalive = new Keepalive();

export function peerUrl(address: string): string {
  const url = new URL(address);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/peer';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** `timeoutMs`: shorter while a relay can take over (devices/rendezvous). */
export function dialPeer(address: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(peerUrl(address), { maxPayload: 8 * 1024 * 1024, handshakeTimeout: timeoutMs });
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch { /* already closed */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      keepalive.add(ws);
      resolve(wrapWs(ws as never));
    });
    ws.once('error', fail);
    ws.once('close', () => fail(new Error('peer closed during connect')));
  });
}
