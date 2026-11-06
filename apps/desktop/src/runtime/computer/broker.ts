// The desktop broker connection (B-077, computer use on the lock screen): once `AutarkDesktopBroker` is installed
// (scripts/broker-install.ps1), its SYSTEM worker in the console session serves the helper protocol on a named pipe and
// follows the input desktop, so the normal computer.* tools also reach the locked screen and UAC prompts.
// brokerLease() hands WindowsHelper (helper.ts) a lease whose "child" is the pipe: the handshake proves the
// installation key both ways, then lines pass through unchanged – except typed text ('type', 'act' value), which leaves
// this process only sealed with the session key (AES-256-CBC + HMAC-SHA256, op 'type_secret') and is opened by the worker
// right before SendInput. Each answer names the input desktop; `brokerState` keeps the route and the last desktop.
// Owns: reachability, the handshake, sealing and the route state. Never: retries, resolves secrets (secrets/handles.ts)
// or logs anything typed.

import { createHmac, createCipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { Logger } from '../contracts.ts';
import type { ChildLike, Lease } from '../system/supervisor.ts';
import { asciiJson } from './protocol.ts';

export const BROKER_PIPE_NAME = 'AutarkDesktopBroker';
export const BROKER_PIPE = `\\\\.\\pipe\\${BROKER_PIPE_NAME}`;
export const BROKER_KEY = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'AutarkDesktopBroker', 'broker.key');

/** Which way computer use runs on this PC and which desktop took input at the last answer ('Winlogon' = locked or UAC). */
export const brokerState: { via: 'broker' | 'powershell'; desktop?: string } = { via: 'powershell' };

/** True when the broker's desktop is the Windows sign-in / secure desktop. */
export function lockedDesktop(): boolean {
  return brokerState.via === 'broker' && (brokerState.desktop ?? '').toLowerCase() === 'winlogon';
}

/** What drivers.ts needs to pick the broker (tests inject a fake). */
export interface BrokerAccess {
  reachable(): boolean;
  lease(log: Logger): Lease;
}

/** The installed broker: its key file readable and its pipe listed (listing \\.\pipe\ opens no instance). */
export function localBroker(pipe = BROKER_PIPE, keyFile = BROKER_KEY): BrokerAccess {
  return {
    reachable: () => {
      try { return fs.existsSync(keyFile) && fs.readdirSync('\\\\.\\pipe\\').includes(path.win32.basename(pipe)); } catch { return false; }
    },
    lease: (log) => brokerLease({ pipe, key: Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64'), log }),
  };
}

const mac = (key: Buffer, label: string, ...parts: Buffer[]) => createHmac('sha256', key).update(Buffer.concat([Buffer.from(label, 'utf8'), ...parts])).digest();

/** `text` sealed for request `id`/`op` with `session` (the worker's Sealer.Open is the other half). */
export function seal(session: Buffer, id: number, op: string, text: string): { iv: string; data: string; mac: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', mac(session, 'enc'), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), data: data.toString('base64'), mac: mac(mac(session, 'mac'), `${id}\n${op}\n`, iv, data).toString('base64') };
}

/** One request line with its typed text sealed ('type' → 'type_secret'; 'act' value); other lines unchanged. */
export function sealLine(line: string, session: Buffer): string {
  const request = JSON.parse(line) as { id: number; op: string; args?: Record<string, unknown> };
  const args = { ...(request.args ?? {}) };
  if (request.op === 'type' && typeof args.text === 'string') {
    const text = args.text;
    delete args.text;
    return `${asciiJson({ id: request.id, op: 'type_secret', args: { ...args, sealed: seal(session, request.id, 'type_secret', text) } })}\n`;
  }
  if (request.op === 'act' && typeof args.value === 'string') {
    const value = args.value;
    delete args.value;
    return `${asciiJson({ id: request.id, op: 'act', args: { ...args, sealed: seal(session, request.id, 'act', value) } })}\n`;
  }
  return line.endsWith('\n') ? line : `${line}\n`;
}

const DESKTOP = /"desktop":"([^"\\]{0,64})"\}\s*$/;

let leases = 0;

/** A lease on one pipe connection: WindowsHelper talks to it like to the PowerShell child. */
export function brokerLease(input: { pipe: string; key: Buffer; log: Logger; connect?: (pipe: string) => net.Socket }): Lease {
  const socket = (input.connect ?? ((pipe) => net.connect(pipe)))(input.pipe);
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const clientNonce = randomBytes(16);
  let serverNonce: Buffer | undefined;
  let session: Buffer | undefined;
  let buffer = '';
  let resolveExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });

  const fail = (reason: string) => { input.log.warn('desktop broker refused', { reason }); socket.destroy(); };
  const onLine = (line: string) => {
    if (!serverNonce) {
      const hello = JSON.parse(line) as { broker?: number; nonce?: string };
      serverNonce = Buffer.from(hello.nonce ?? '', 'base64');
      if (hello.broker !== 1 || serverNonce.length !== 16) return fail('no broker greeting');
      socket.write(`${JSON.stringify({ hello: mac(input.key, 'hello', serverNonce, clientNonce).toString('base64'), nonce: clientNonce.toString('base64') })}\n`);
      return;
    }
    if (!session) {
      const ready = JSON.parse(line) as { proof?: string };
      const proof = Buffer.from(ready.proof ?? '', 'base64');
      const expected = mac(input.key, 'proof', serverNonce, clientNonce);
      if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) return fail('the broker did not prove the installation key');
      session = mac(input.key, 'session', serverNonce, clientNonce);
      brokerState.via = 'broker';
    }
    const desktop = DESKTOP.exec(line.slice(-100));
    if (desktop) brokerState.desktop = desktop[1];
    stdout.write(`${line}\n`);
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    try {
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line);
      }
    } catch { fail('unreadable line'); }
  });
  socket.on('error', (error) => input.log.debug('desktop broker pipe error', { message: error.message }));
  socket.on('close', () => {
    child.exitCode = session ? 0 : 1;
    stdout.end();
    events.emit('exit', child.exitCode, null);
    events.emit('close', child.exitCode, null);
    resolveExit(child.exitCode);
  });

  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      if (!session) { done(new Error('The desktop broker is not ready.')); return; }
      try {
        const lines = chunk.toString().split('\n').filter((line) => line.trim());
        socket.write(lines.map((line) => sealLine(line, session!)).join(''), () => done());
      } catch (error) { done(error as Error); }
    },
  });

  const child = {
    pid: undefined, stdin, stdout, stderr: null, exitCode: null as number | null,
    kill: () => { socket.destroy(); return true; },
    on: (event: string, listener: (...args: unknown[]) => void) => { events.on(event, listener); return child; },
    once: (event: string, listener: (...args: unknown[]) => void) => { events.once(event, listener); return child; },
  };
  const release = async () => { socket.destroy(); await exited; };
  const now = Date.now();
  return {
    id: ++leases, owner: 'computer:desktop-broker', kind: 'light', startedAt: now, lastActiveAt: now,
    child: child as unknown as ChildLike, touch: () => undefined, release, releaseAfter: release, exited,
  };
}
