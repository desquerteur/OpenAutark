// Test helpers for the relay tests: device keys and real WebSocket clients on loopback that
// register by signing the challenge and collect what the relay sends.

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import WebSocket from 'ws';
import { boxText, helloText } from '../src/relay.ts';

export type Frame = Record<string, any>;

export interface Client {
  fp: string;
  pub: string;
  ws: WebSocket;
  frames: Frame[];
  binary: Buffer[];
  next(type: string, match?: (frame: Frame) => boolean): Promise<Frame>;
  send(frame: Frame): void;
  closed: Promise<number>;
}

export function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const box = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
  return {
    pub: raw.toString('base64url'),
    fp: createHash('sha256').update(raw).digest('hex'),
    box,
    sign: (text: string) => sign(null, Buffer.from(text), privateKey).toString('base64url'),
  };
}

export async function connect(port: number, options: { peers?: string[]; findable?: boolean; badSig?: boolean; me?: ReturnType<typeof device>; peerPort?: number; path?: string; headers?: Record<string, string> } = {}): Promise<Client> {
  const me = options.me ?? device();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/'}`, { headers: options.headers });
  const frames: Frame[] = [];
  const binary: Buffer[] = [];
  const waiters: Array<{ type: string; match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('error', () => undefined);
  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) { binary.push(Buffer.from(raw)); return; }
    const frame = JSON.parse(String(raw)) as Frame;
    if (frame.t === 'challenge') {
      ws.send(JSON.stringify({ t: 'hello', v: 1, pub: me.pub, sig: options.badSig ? me.sign('wrong') : me.sign(helloText(frame.n)), box: me.box, boxSig: me.sign(boxText(me.box)), peers: options.peers ?? [], findable: options.findable === true, ...(options.peerPort ? { port: options.peerPort } : {}) }));
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.type === frame.t && waiter.match(frame));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(frame); else frames.push(frame);
  });
  const client: Client = {
    fp: me.fp, pub: me.pub, ws, frames, binary, closed,
    next: (type, match = () => true) => {
      const seen = frames.findIndex((frame) => frame.t === type && match(frame));
      if (seen >= 0) return Promise.resolve(frames.splice(seen, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ type, match, resolve });
        setTimeout(() => reject(new Error(`no ${type} frame`)), 3_000).unref();
      });
    },
    send: (frame) => ws.send(JSON.stringify(frame)),
  };
  return client;
}

export const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
