// The PC UI's RPC socket inside the iPhone web app (B-078 follow-up): a service worker cannot carry WebSockets, so
// window.autarkHosted.socket('/ws') is a WebSocket-like on one stream to the PC's own /ws – RFC 6455 spoken here: an
// HTTP/1.1 Upgrade with Host 127.0.0.1 and no Origin, the Sec-WebSocket-Accept checked (SHA-1), masked client frames,
// fragments joined, ping answered with pong, the PC's close code passed through (4401/4403 still drive lib/refusal.ts), a
// stream that just ends closes with 1006. No compression is offered. It waits up to 8 s for a channel, as Android does.
// Owns: this framing and the socket's states. Never: holds more than one message being joined, or retries by itself
// (lib/rpc.ts reconnects).

import type { HostedSocket } from '../pwa/hosted.ts';
import { b64std, concat, fromLatin1, fromUtf8, latin1, random, utf8, type Bytes } from './bytes.ts';
import { sha1 } from './crypto.ts';
import type { Stream, StreamMux } from './streams.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 32 * 1024 * 1024;

/** One client frame (masked). */
export function encodeFrame(opcode: number, payload: Bytes, fin = true): Bytes {
  const length = payload.length;
  const size = length < 126 ? 2 : length < 65_536 ? 4 : 10;
  const frame = new Uint8Array(size + 4 + length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) frame[1] = 0x80 | length;
  else if (length < 65_536) { frame[1] = 0x80 | 126; frame[2] = length >> 8; frame[3] = length & 0xff; }
  else { frame[1] = 0x80 | 127; new DataView(frame.buffer).setBigUint64(2, BigInt(length)); }
  const mask = random(4);
  frame.set(mask, size);
  for (let i = 0; i < length; i++) frame[size + 4 + i] = payload[i] ^ mask[i & 3];
  return frame;
}

export async function acceptOf(key: string): Promise<string> {
  return b64std(await sha1(utf8(key + GUID)));
}

export class StreamSocket implements HostedSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private stream: Stream | undefined;
  private buffer: Bytes = new Uint8Array(0);
  private upgraded = false;
  private parts: Bytes[] = [];
  private partsOpcode = 0;
  private partsSize = 0;
  private closeSent = false;
  private closedFired = false;

  /** `mux`: the current stream mux, waited for up to `waitMs`. */
  constructor(mux: (waitMs: number) => Promise<StreamMux | undefined>, path = '/ws', waitMs = 8_000) {
    void this.start(mux, path, waitMs);
  }

  send(data: string): void {
    if (this.readyState !== 1 || !this.stream) throw new Error('The socket is not open.');
    void this.stream.write(encodeFrame(1, utf8(data)));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    if (this.readyState === 0 || !this.stream) { this.fireClose(code, reason); this.stream?.end(); return; }
    this.readyState = 2;
    this.sendClose(code, reason);
  }

  private async start(muxOf: (waitMs: number) => Promise<StreamMux | undefined>, path: string, waitMs: number): Promise<void> {
    const mux = await muxOf(waitMs).catch(() => undefined);
    if (!mux || mux.closed || this.readyState !== 0) { this.fireClose(1006, 'Your PC is not reachable right now.'); return; }
    const stream = mux.openStream();
    this.stream = stream;
    const key = b64std(random(16));
    const expected = await acceptOf(key);
    stream.listen({ data: (bytes) => this.data(bytes, expected), end: () => this.fireClose(1006, '') });
    const head = [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13'];
    void stream.write(fromLatin1(`${head.join('\r\n')}\r\n\r\n`));
  }

  private data(bytes: Bytes, expected: string): void {
    this.buffer = this.buffer.length ? concat(this.buffer, bytes) : bytes;
    if (!this.upgraded) {
      const text = latin1(this.buffer.subarray(0, Math.min(this.buffer.length, 16_384)));
      const at = text.indexOf('\r\n\r\n');
      if (at < 0) { if (this.buffer.length > 16_384) this.fail(); return; }
      const lines = text.slice(0, at).split('\r\n');
      const accept = lines.find((line) => /^sec-websocket-accept:/i.test(line))?.split(':')[1]?.trim();
      if (!/^HTTP\/1\.1 101/.test(lines[0]) || accept !== expected) { this.fail(); return; }
      this.buffer = this.buffer.slice(at + 4);
      this.upgraded = true;
      if (this.readyState === 0) { this.readyState = 1; this.onopen?.({}); }
    }
    this.frames();
  }

  private frames(): void {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let length = b[1] & 0x7f;
      let at = 2;
      if (length === 126) { if (b.length < 4) return; length = (b[2] << 8) | b[3]; at = 4; }
      else if (length === 127) { if (b.length < 10) return; length = Number(new DataView(b.buffer, b.byteOffset + 2, 8).getBigUint64(0)); at = 10; }
      if (length > MAX_MESSAGE) { this.fail(); return; }
      const maskAt = at;
      if (masked) at += 4;
      if (b.length < at + length) return;
      const payload = b.slice(at, at + length);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[maskAt + (i & 3)];
      this.buffer = b.slice(at + length);
      this.frame(fin, opcode, payload);
      if (this.closedFired) return;
    }
  }

  private frame(fin: boolean, opcode: number, payload: Bytes): void {
    if (opcode === 9) { void this.stream?.write(encodeFrame(10, payload)); return; } // ping → pong
    if (opcode === 10) return;
    if (opcode === 8) {
      const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
      const reason = payload.length > 2 ? fromUtf8(payload.subarray(2)) : '';
      if (!this.closeSent) this.sendClose(code === 1005 ? 1000 : code, '');
      this.fireClose(code, reason); // before the stream's own end reports 1006
      this.stream?.end();
      return;
    }
    if (opcode === 1 || opcode === 2) { this.parts = []; this.partsSize = 0; this.partsOpcode = opcode; }
    else if (opcode !== 0) { this.fail(); return; }
    this.parts.push(payload);
    this.partsSize += payload.length;
    if (this.partsSize > MAX_MESSAGE) { this.fail(); return; }
    if (!fin) return;
    const whole = concat(...this.parts);
    this.parts = [];
    this.partsSize = 0;
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: this.partsOpcode === 1 ? fromUtf8(whole) : whole.buffer });
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent || !this.stream) return;
    this.closeSent = true;
    const text = utf8(reason.slice(0, 120));
    void this.stream.write(encodeFrame(8, concat(new Uint8Array([code >> 8, code & 0xff]), text)));
  }

  private fail(): void {
    this.fireClose(1006, '');
    this.stream?.end();
  }

  private fireClose(code: number, reason: string): void {
    if (this.closedFired) return;
    this.closedFired = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}
