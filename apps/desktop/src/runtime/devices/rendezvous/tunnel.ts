// A meeting-server tunnel as a SocketLike (devices/channel.ts), so the mesh runs its usual pinned-key
// handshake and encrypted channel through the relay unchanged. Frames to the relay are
// [u32 tunnel id][flags][≤ 60 KiB chunk]; a larger message is split (flag MORE) and joined again
// here, up to the channel's 8 MiB frame limit. Text frames (the handshake) are additionally
// sealed to the other device (rendezvous/seal.ts) – the relay sees ciphertext only.
// Memory a relay can make this PC hold is small: text messages stay ≤ 16 KiB, and until a sealed
// text frame from the other end opened (only it holds the keys), every message stays ≤ 16 KiB and
// binary ones end the tunnel (the handshake always starts with text).
// Owns: framing, fragmentation, the text seal, those caps and close semantics of one tunnel.
// Never: the relay connection itself (relay-client.ts) or trust decisions (the handshake makes them).

import type { SocketLike } from '../channel.ts';
import type { CounterCipher } from './seal.ts';

export const HEADER = 5;
export const CHUNK = 60 * 1024;
const TEXT = 1;
const MORE = 2;
const MAX_MESSAGE = 8 * 1024 * 1024 + 1024;
/** Handshake text frames are ≤ 4 KiB (channel.ts); sealed and with headroom. */
export const MAX_TEXT = 16 * 1024;

export interface TunnelLink {
  /** Sends one binary frame to the relay (header included). */
  send(frame: Buffer): void;
  /** Tells the relay this end closed the tunnel. */
  close(): void;
}

export class RelayTunnel implements SocketLike {
  readonly tid: number;
  /** Fingerprint of the device at the other end. */
  readonly peer: string;
  closed = false;
  private readonly link: TunnelLink;
  private readonly cipher: CounterCipher;
  private readonly messageListeners: Array<(data: Buffer, isText: boolean) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private parts: Buffer[] = [];
  private size = 0;
  /** A sealed text frame of the other end opened: it holds the tunnel keys. */
  private proven = false;
  /** Largest text message once proven. */
  private textMax = MAX_TEXT;

  constructor(tid: number, peer: string, link: TunnelLink, cipher: CounterCipher) {
    this.tid = tid;
    this.peer = peer;
    this.link = link;
    this.cipher = cipher;
  }

  send(data: Buffer | string): void {
    if (this.closed) return;
    const isText = typeof data === 'string';
    const body = isText ? this.cipher.seal(Buffer.from(data, 'utf8')) : Buffer.from(data);
    for (let offset = 0; offset < body.length || offset === 0; offset += CHUNK) {
      if (this.closed) return; // the link closed it (send buffer full)
      const chunk = body.subarray(offset, offset + CHUNK);
      const more = offset + CHUNK < body.length;
      const frame = Buffer.allocUnsafe(HEADER + chunk.length);
      frame.writeUInt32BE(this.tid, 0);
      frame[4] = (isText ? TEXT : 0) | (more ? MORE : 0);
      chunk.copy(frame, HEADER);
      this.link.send(frame);
      if (!more) break;
    }
  }

  /** A binary frame from the relay for this tunnel. */
  receive(frame: Buffer): void {
    if (this.closed || frame.length < HEADER) return;
    const flags = frame[4];
    const chunk = frame.subarray(HEADER);
    this.size += chunk.length;
    if (this.size > (!this.proven ? MAX_TEXT : flags & TEXT ? this.textMax : MAX_MESSAGE)) { this.close(); return; }
    if (!this.proven && !(flags & TEXT)) { this.close(); return; }
    this.parts.push(Buffer.from(chunk));
    if (flags & MORE) return;
    const whole = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    if (flags & TEXT) {
      const plain = this.cipher.open(whole);
      if (!plain) { this.close(); return; }
      this.proven = true;
      for (const listener of this.messageListeners) listener(plain, true);
      return;
    }
    for (const listener of this.messageListeners) listener(whole, false);
  }


  close(): void {
    if (this.closed) return;
    try { this.link.close(); } catch { /* relay gone */ }
    this.ended();
  }

  /** The relay closed the tunnel (the other end left, the pin ended, the relay went away). */
  ended(): void {
    if (this.closed) return;
    this.closed = true;
    this.parts = [];
    queueMicrotask(() => { for (const listener of this.closeListeners) listener(); });
  }

  onMessage(listener: (data: Buffer, isText: boolean) => void): void { this.messageListeners.push(listener); }
  onClose(listener: () => void): void { this.closeListeners.push(listener); }
}
