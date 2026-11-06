// An in-memory EngineSocket for the realtime adapter tests (src/runtime/calls/realtime/engine.ts): records what
// the adapter sends (parsed JSON), the URL and headers it connected with, and lets a test play the server
// (open, message, close, error) synchronously.
// Owns: fixtures only. Never imported by src/.

import type { EngineSocket, SocketFactory } from '../../../src/runtime/calls/realtime/engine.ts';

export class FakeSocket implements EngineSocket {
  url = '';
  headers: Record<string, string> = {};
  sent: Array<Record<string, any>> = [];
  closedWith?: number;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  send(text: string): void { this.sent.push(JSON.parse(text)); }
  close(code?: number): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = code ?? 1005;
    this.emit('close', this.closedWith, '');
  }
  on(event: string, listener: (...args: any[]) => void): unknown {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
  /** The server sends one JSON message (as a Buffer, like ws). */
  message(event: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(event))); }
  /** What was sent with this key at the top level (OpenAI: `type`; Gemini: the message's one key). */
  of(type: string): Array<Record<string, any>> { return this.sent.filter((event) => event.type === type || type in event); }
}

export function fakeConnect(): { connect: SocketFactory; sockets: FakeSocket[]; last(): FakeSocket } {
  const sockets: FakeSocket[] = [];
  const connect: SocketFactory = (url, headers) => {
    const socket = new FakeSocket();
    socket.url = url;
    socket.headers = headers;
    sockets.push(socket);
    return socket;
  };
  return { connect, sockets, last: () => sockets[sockets.length - 1] };
}

/** PCM16 LE of `count` samples with value(index). */
export function pcm(count: number, value: (index: number) => number = () => 1000): Uint8Array {
  const out = new Uint8Array(count * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < count; index++) view.setInt16(index * 2, value(index), true);
  return out;
}
