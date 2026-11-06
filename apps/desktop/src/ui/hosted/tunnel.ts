// One meeting-server tunnel for the iPhone web app (B-078 follow-up), exactly as runtime/devices/rendezvous/tunnel.ts and
// Android's relay/Tunnel.java frame it: [u32 tunnel id][flags][≤ 60 KiB chunk], flag MORE joins chunks, text (handshake)
// frames are sealed to the PC with the tunnel's counter cipher (TUNNEL_INFO). Sends and opens each run in one ordered
// queue – WebCrypto is asynchronous, and a binary frame must never overtake the sealed text frame queued before it.
// Owns: framing, joining, the text seal and the size cap of one tunnel. Never: decides trust (the peer handshake does) or
// holds more than one message being joined.

import { concat, fromUtf8, utf8, writeU32, type Bytes } from './bytes.ts';
import { Serial, type CounterCipher } from './crypto.ts';

export const HEADER = 5;
export const CHUNK = 60 * 1024;
const TEXT = 1;
const MORE = 2;
const MAX_MESSAGE = 8 * 1024 * 1024 + 1024;

export interface TunnelLink {
  /** One binary frame to the meeting server (header included). */
  send(frame: Bytes): void;
  /** Tells the meeting server this end closed the tunnel. */
  close(tid: number): void;
}

export class Tunnel {
  readonly tid: number;
  /** Fingerprint of the PC at the other end. */
  readonly peer: string;
  closed = false;
  private readonly link: TunnelLink;
  private readonly cipher: CounterCipher;
  private readonly sending = new Serial();
  private readonly receiving = new Serial();
  private readonly messageListeners: Array<(data: Bytes, isText: boolean) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private parts: Uint8Array[] = [];
  private size = 0;

  constructor(tid: number, peer: string, link: TunnelLink, cipher: CounterCipher) {
    this.tid = tid;
    this.peer = peer;
    this.link = link;
    this.cipher = cipher;
  }

  /** A handshake text frame, sealed to the PC. */
  sendText(text: string): Promise<void> {
    return this.sending.run(async () => {
      if (this.closed) return;
      this.frames(await this.cipher.seal(utf8(text)), true);
    });
  }

  /** A channel frame (already encrypted by the peer channel). */
  sendBinary(data: Bytes): Promise<void> {
    return this.sending.run(async () => { if (!this.closed) this.frames(data, false); });
  }

  private frames(body: Bytes, isText: boolean): void {
    let offset = 0;
    do {
      if (this.closed) return; // the link closed it (send pressure)
      const chunk = body.subarray(offset, offset + CHUNK);
      const more = offset + chunk.length < body.length;
      const frame = new Uint8Array(HEADER + chunk.length);
      writeU32(frame, this.tid);
      frame[4] = (isText ? TEXT : 0) | (more ? MORE : 0);
      frame.set(chunk, HEADER);
      this.link.send(frame);
      offset += chunk.length;
    } while (offset < body.length);
  }

  /** A binary frame from the meeting server for this tunnel. */
  receive(frame: Uint8Array): void {
    if (this.closed || frame.length < HEADER) return;
    const flags = frame[4];
    this.size += frame.length - HEADER;
    if (this.size > MAX_MESSAGE) { this.close(); return; }
    this.parts.push(frame.slice(HEADER));
    if (flags & MORE) return;
    const whole = concat(...this.parts);
    this.parts = [];
    this.size = 0;
    const isText = (flags & TEXT) !== 0;
    void this.receiving.run(async () => {
      if (this.closed) return;
      const data = isText ? await this.cipher.open(whole) : whole;
      if (!data) { this.close(); return; }
      for (const listener of this.messageListeners) listener(data, isText);
    });
  }

  close(): void {
    if (this.closed) return;
    try { this.link.close(this.tid); } catch { /* the meeting server is gone */ }
    this.ended();
  }

  /** The meeting server ended the tunnel (the PC left, the pin ended, the connection went away). */
  ended(): void {
    if (this.closed) return;
    this.closed = true;
    this.parts = [];
    queueMicrotask(() => { for (const listener of this.closeListeners) listener(); });
  }

  onMessage(listener: (data: Bytes, isText: boolean) => void): void { this.messageListeners.push(listener); }
  onClose(listener: () => void): void { this.closeListeners.push(listener); }
}

/** Text of a received handshake frame. */
export const textOf = (data: Uint8Array): string => fromUtf8(data);
