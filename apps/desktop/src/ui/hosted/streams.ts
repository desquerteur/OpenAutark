// Byte streams to the PC's own HTTP port over the peer channel (B-078 follow-up), the client end of
// runtime/devices/rendezvous/phone.ts exactly as Android's relay/StreamProxy.java speaks it: {t:'o',s} opens a stream (one
// TCP connection to the PC's runtime port there), {t:'d',s,b} carries standard-base64 bytes, {t:'a',s,n} acknowledges n
// bytes taken, {t:'e',s} ends it; each side keeps at most WINDOW bytes unacknowledged per stream. The PC takes 24 streams
// per channel, so HTTP requests wait for one of HTTP_SLOTS slots (the RPC WebSocket stream stays outside them).
// Owns: stream ids, the window, the slots. Never: HTTP or WebSocket framing (http.ts, ws.ts) or holds unbounded bytes it sends.

import { b64std, fromB64std, type Bytes } from './bytes.ts';

export const WINDOW = 256 * 1024;
const CHUNK = 32 * 1024;
export const HTTP_SLOTS = 6;

/** The peer channel as the streams see it. */
export interface ChannelLike {
  readonly closed: boolean;
  send(message: unknown): Promise<void> | void;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
}

export interface StreamSink { data(bytes: Bytes): void; end(): void }

export class Stream {
  readonly id: number;
  ended = false;
  private readonly mux: StreamMux;
  private sink: StreamSink | undefined;
  private early: Bytes[] = [];
  private endedEarly = false;
  private unacked = 0;
  private waiters: Array<() => void> = [];

  constructor(mux: StreamMux, id: number) {
    this.mux = mux;
    this.id = id;
  }

  /** Where the PC's bytes go; bytes that came before are handed over first. Each delivered chunk is acknowledged. */
  listen(sink: StreamSink): void {
    this.sink = sink;
    for (const bytes of this.early.splice(0)) this.take(bytes);
    if (this.endedEarly) sink.end();
  }

  /** Sends bytes to the PC, waiting while WINDOW bytes are unacknowledged; false once the stream ended. */
  async write(bytes: Bytes): Promise<boolean> {
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      while (!this.ended && this.unacked >= WINDOW) await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (this.ended) return false;
      const chunk = bytes.subarray(offset, offset + CHUNK);
      this.unacked += chunk.length;
      void this.mux.send({ t: 'd', s: this.id, b: b64std(chunk) });
    }
    return !this.ended;
  }

  /** This end is done: the PC closes its connection. */
  end(): void {
    if (this.ended) return;
    this.finish();
    void this.mux.send({ t: 'e', s: this.id });
  }

  /** @internal messages of this stream from the PC */
  deliver(message: { t?: unknown; b?: unknown; n?: unknown }): void {
    if (message.t === 'd' && typeof message.b === 'string') {
      let bytes: Bytes;
      try { bytes = fromB64std(message.b); } catch { return; }
      if (this.sink) this.take(bytes); else this.early.push(bytes);
    } else if (message.t === 'a' && Number.isInteger(message.n)) {
      this.unacked = Math.max(0, this.unacked - (message.n as number));
      this.wake();
    } else if (message.t === 'e') {
      this.finish();
    }
  }

  private take(bytes: Bytes): void {
    this.sink?.data(bytes);
    if (!this.ended) void this.mux.send({ t: 'a', s: this.id, n: bytes.length });
  }

  /** @internal */
  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.mux.forget(this.id);
    this.wake();
    if (this.sink) this.sink.end(); else this.endedEarly = true;
  }

  private wake(): void { for (const resolve of this.waiters.splice(0)) resolve(); }
}

export class StreamMux {
  private readonly channel: ChannelLike;
  private readonly streams = new Map<number, Stream>();
  private nextId = 1;
  private busy = 0;
  private readonly queue: Array<() => void> = [];

  constructor(channel: ChannelLike) {
    this.channel = channel;
    channel.onMessage((value) => {
      const message = value as { s?: unknown } | null;
      const stream = typeof message?.s === 'number' ? this.streams.get(message.s) : undefined;
      stream?.deliver(message as never);
    });
    channel.onClose(() => { for (const stream of [...this.streams.values()]) stream.finish(); });
  }

  get closed(): boolean { return this.channel.closed; }

  /** Streams open now (tests, status). */
  get open(): number { return this.streams.size; }

  /** A new stream to the PC's runtime port. */
  openStream(): Stream {
    const stream = new Stream(this, this.nextId++);
    if (this.channel.closed) { stream.finish(); return stream; }
    this.streams.set(stream.id, stream);
    void this.send({ t: 'o', s: stream.id });
    return stream;
  }

  /** Waits for one of HTTP_SLOTS; the returned function gives it back. */
  async slot(): Promise<() => void> {
    if (this.busy < HTTP_SLOTS) this.busy++;
    else await new Promise<void>((resolve) => this.queue.push(resolve)); // the slot is handed over, never counted twice
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const next = this.queue.shift();
      if (next) next(); else this.busy--;
    };
  }

  /** Slots taken now (tests). */
  get taken(): number { return this.busy; }

  /** @internal */
  send(message: unknown): Promise<void> | void {
    if (!this.channel.closed) return this.channel.send(message);
  }

  /** @internal */
  forget(id: number): void { this.streams.delete(id); }
}
