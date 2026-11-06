// A phone app (apps/android) reaches this PC the way a linked PC does: through the meeting server, by Remote ID, with
// no VPN and no address of its own. B-078 (D5): it pairs with the normal connect request (role 'phone', its own key,
// the same code on both screens, Accept on the PC – rendezvous/phone-pair.ts) and gets its device token in the accepted
// answer. From then on every PC of mine pins that key at the server (the roster carries the phone to my other PCs), the
// phone opens a tunnel to the first one online, the usual pinned-key handshake (devices/channel.ts) runs over it, and the
// channel carries plain byte streams to this PC's own HTTP listener – the phone shows the unchanged phone UI over them,
// authenticated by its token like any phone. Removing the phone unpins it (the server cuts the tunnel) and revokes the token.
// Streams: {t:'o',s} opens one, {t:'d',s,b} carries base64 bytes, {t:'a',s,n} acknowledges n bytes taken, {t:'e',s}
// ends it. Each side sends at most WINDOW unacknowledged bytes per stream, so a big download never piles up in RAM.
// Owns: the channel on a phone tunnel and its streams. Never: gives a phone the owner token, a PC's sync, or a stream to
// anything but this PC's own runtime port.

import net from 'node:net';
import type { Logger } from '../../contracts.ts';
import { acceptSecure, type SecureChannel, type SocketLike } from '../channel.ts';
import type { Signer } from '../handshake.ts';
import { fromB64url } from '../keys.ts';
import type { DeviceRecord } from '../repo.ts';

export const STREAM_WINDOW = 256 * 1024;
const CHUNK = 32 * 1024;
const MAX_STREAMS = 24;

export interface PhoneBridgeDeps {
  identity: Signer;
  log: Logger;
  /** This PC's runtime HTTP port (the phone UI and its /ws). */
  port(): number;
}

/** A relay phone: a phone record carrying the key it pairs with. */
export const relayPhone = (record: DeviceRecord | undefined): record is DeviceRecord =>
  Boolean(record && record.kind === 'phone' && !record.self && !record.revokedAt && record.status !== 'revoked' && record.publicKey);

export class PhoneBridge {
  private readonly deps: PhoneBridgeDeps;
  private readonly channels = new Set<SecureChannel>();

  constructor(deps: PhoneBridgeDeps) {
    this.deps = deps;
  }

  /** A tunnel a pinned phone opened: the handshake with exactly its key, then its streams. */
  async accept(tunnel: SocketLike, record: DeviceRecord): Promise<void> {
    const expected = fromB64url(record.publicKey!);
    const channel = await acceptSecure(tunnel, this.deps.identity, (pub) => (Buffer.compare(pub, expected) === 0 ? record.id : undefined));
    this.channels.add(channel);
    channel.onClose(() => this.channels.delete(channel));
    serveStreams(channel, () => this.deps.port(), this.deps.log);
  }

  /** The bridge stops: every phone channel ends. */
  closeAll(): void {
    for (const channel of [...this.channels]) channel.close();
  }
}

interface Stream { socket: net.Socket; unacked: number; ended: boolean }

/** The PC end of the stream protocol: each stream is one TCP connection to 127.0.0.1:port. */
export function serveStreams(channel: SecureChannel, port: () => number, log: Logger): void {
  const streams = new Map<number, Stream>();
  const send = (message: unknown) => { if (!channel.closed) channel.send(message); };
  const end = (id: number, tell: boolean) => {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    stream.socket.destroy();
    if (tell) send({ t: 'e', s: id });
  };
  channel.onMessage((value) => {
    const message = value as { t?: unknown; s?: unknown; b?: unknown; n?: unknown } | null;
    const id = message?.s;
    if (!Number.isInteger(id) || (id as number) < 0) return;
    const s = id as number;
    switch (message?.t) {
      case 'o': {
        if (streams.has(s) || streams.size >= MAX_STREAMS) { send({ t: 'e', s }); return; }
        const socket = net.connect({ host: '127.0.0.1', port: port() });
        const stream: Stream = { socket, unacked: 0, ended: false };
        streams.set(s, stream);
        socket.on('data', (data: Buffer) => {
          for (let offset = 0; offset < data.length; offset += CHUNK) send({ t: 'd', s, b: data.subarray(offset, offset + CHUNK).toString('base64') });
          stream.unacked += data.length;
          if (stream.unacked >= STREAM_WINDOW) socket.pause();
        });
        socket.on('close', () => end(s, true));
        socket.on('error', (error) => log.debug('phone stream ended', { error: error.message }));
        return;
      }
      case 'd': {
        const stream = streams.get(s);
        if (!stream || typeof message.b !== 'string') return;
        const data = Buffer.from(message.b, 'base64');
        stream.socket.write(data, () => send({ t: 'a', s, n: data.length }));
        return;
      }
      case 'a': {
        const stream = streams.get(s);
        if (!stream || !Number.isInteger(message.n)) return;
        stream.unacked = Math.max(0, stream.unacked - (message.n as number));
        if (stream.unacked < STREAM_WINDOW && stream.socket.isPaused()) stream.socket.resume();
        return;
      }
      case 'e': end(s, false); return;
    }
  });
  channel.onClose(() => { for (const id of [...streams.keys()]) end(id, false); });
}
