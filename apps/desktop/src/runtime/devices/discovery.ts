// PCs on this network, without anyone typing an address: while this PC accepts connection requests
// (settings.devices.findable) a UDP socket on port 47813 answers the LAN probe {q:'wf-hello',v:1,n}
// from the LAN, link-local or loopback (lanSource) with its public identity – device id, name,
// fingerprint, Remote ID and peer addresses. The asking PC sends one probe to 255.255.255.255 and
// each IPv4 interface's directed broadcast and collects answers for at most 1.5 s (Settings ›
// Devices lists them; "Connect" by Remote ID looks here first). An answer is only a hint where to
// try: the connect request proves the key (remote/sas.ts) and the person compares the code.
// Test-only override (two runtimes on one machine): WORKFORCE_DISCOVERY_TARGETS – loopback addresses
// (127.0.0.0/8), comma separated – replaces the broadcast list and binds the responder to the first.
// Owns: the probe/answer format, the sockets and which sources are answered.
// Never: answers while this PC does not accept requests, answers a probe from beyond this network,
// or sends anything beyond the public identity.

import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { validAddress } from './pair-proof.ts';
import { remoteIdOf } from '../remote/id.ts';

export const DISCOVERY_PORT = 47813;
export const DISCOVER_MS = 1500;
/** At most this many PCs from one probe (any LAN host can answer with made-up keys). */
export const MAX_HELLO_ANSWERS = 32;
const MAX_MESSAGE = 4096;

/** A PC that answered a hello probe (its Remote ID checked against its fingerprint). */
export interface Candidate { deviceId: string; name: string; fingerprint: string; addresses: string[]; remoteId: string }

/** This PC's identity for a hello answer – or nothing (not accepting requests). */
export type HelloAnswer = () => Candidate | undefined;

/** The part of node:dgram's socket used here (tests pass a fake). */
export interface UdpSocket {
  on(event: 'message', listener: (message: Buffer, remote: { address: string; port: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  bind(port: number, address?: string, callback?: () => void): unknown;
  setBroadcast(flag: boolean): void;
  send(message: Uint8Array, port: number, address: string, callback?: (error: Error | null) => void): void;
  close(): void;
  /** Lets the process exit while the socket is open. */
  unref?(): void;
}

export interface DiscoveryDeps {
  socket?: () => UdpSocket;
  /** Where probes go (default: broadcastAddresses(), or the loopback override). */
  targets?: () => string[];
  port?: number;
  /** Read for the test-only WORKFORCE_DISCOVERY_TARGETS (default: process.env). */
  env?: Record<string, string | undefined>;
}

const LOOPBACK = /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The test-only loopback targets (see the header), or undefined for normal LAN discovery. */
export function loopbackTargets(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env.WORKFORCE_DISCOVERY_TARGETS;
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.split(',').map((entry) => entry.trim()).filter((entry) => LOOPBACK.test(entry)).slice(0, 8);
}

const realSocket = () => createSocket({ type: 'udp4', reuseAddr: true }) as unknown as UdpSocket;

/** 255.255.255.255 plus the directed broadcast of every IPv4 interface (link-local included). */
export function broadcastAddresses(interfaces = networkInterfaces()): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((part, index) => (part & mask[index]) | (~mask[index] & 255)).join('.'));
    }
  }
  return [...out];
}

function parse(message: Buffer): Record<string, unknown> | undefined {
  if (message.length > MAX_MESSAGE) return undefined;
  try {
    const value = JSON.parse(message.toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** A well-formed answer to probe `nonce`, else undefined (a Remote ID that is not its key's is dropped). */
export function parseAnswer(message: Buffer, nonce: string): Candidate | undefined {
  const value = parse(message);
  if (!value || value.a !== 'wf-hello' || value.v !== 1 || value.n !== nonce) return undefined;
  const { deviceId, name, fingerprint, addresses } = value;
  if (typeof deviceId !== 'string' || !/^dev_[0-9a-z]{10,40}$/.test(deviceId)) return undefined;
  if (typeof name !== 'string' || !name.trim() || name.length > 60) return undefined;
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) return undefined;
  if (value.remoteId !== remoteIdOf(fingerprint)) return undefined;
  const list = Array.isArray(addresses) ? addresses.filter((item): item is string => typeof item === 'string' && validAddress(item)).slice(0, 8) : [];
  return { deviceId, name: name.trim(), fingerprint, addresses: list, remoteId: value.remoteId as string };
}

/**
 * A probe the responder answers: from this network only – private (10/8, 172.16/12, 192.168/16),
 * link-local (169.254/16, a direct cable) or loopback – and from an unprivileged port, so the
 * answer is never sent across a VPN or the internet nor reflected at another host's service.
 */
export function lanSource(remote: { address: string; port: number }): boolean {
  if (!Number.isInteger(remote.port) || remote.port < 1024 || remote.port > 65535) return false;
  const parts = remote.address.replace(/^::ffff:/i, '').split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Answers hello probes while `answer` is set (this PC accepts requests). */
export class DiscoveryResponder {
  private readonly deps: DiscoveryDeps;
  private socket?: UdpSocket;
  private hello?: HelloAnswer;

  constructor(deps: DiscoveryDeps = {}) { this.deps = deps; }

  get open(): boolean { return this.socket !== undefined; }

  /** Answers hello probes with `answer()` (read per probe, so addresses stay current); undefined stops. */
  answer(answer: HelloAnswer | undefined): void {
    this.hello = answer;
    if (answer) this.listen();
    else this.close();
  }

  private listen(): void {
    if (this.socket) return;
    const socket = (this.deps.socket ?? realSocket)();
    this.socket = socket;
    socket.on('error', () => this.close()); // port taken or network gone: Connect still works by Remote ID or address
    socket.on('message', (message, remote) => {
      if (!lanSource(remote)) return;
      const probe = parse(message);
      if (!probe || probe.q !== 'wf-hello' || probe.v !== 1 || typeof probe.n !== 'string' || probe.n.length > 64) return;
      const found = this.hello?.();
      if (found) socket.send(Buffer.from(JSON.stringify({ a: 'wf-hello', v: 1, n: probe.n, ...found })), remote.port, remote.address, () => undefined);
    });
    const loopback = loopbackTargets(this.deps.env);
    if (loopback) socket.bind(this.deps.port ?? DISCOVERY_PORT, loopback[0] ?? '127.0.0.1');
    else socket.bind(this.deps.port ?? DISCOVERY_PORT);
    socket.unref?.(); // an open responder never keeps the runtime from exiting
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    try { socket?.close(); } catch { /* already closed */ }
  }
}

/**
 * Who on this network answers a hello probe within `timeoutMs` (never this PC): one entry per device
 * and key, so an impostor never hides the real PC (at most MAX_HELLO_ANSWERS).
 */
export function discover(deps: DiscoveryDeps & { self?: string; timeoutMs?: number } = {}): Promise<Candidate[]> {
  return new Promise((resolve) => {
    const socket = (deps.socket ?? realSocket)();
    const nonce = randomBytes(9).toString('base64url');
    const found = new Map<string, Candidate>();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, deps.timeoutMs ?? DISCOVER_MS);
    socket.on('error', finish);
    socket.on('message', (message) => {
      const candidate = parseAnswer(message, nonce);
      const key = candidate && `${candidate.deviceId}:${candidate.fingerprint}`;
      if (candidate && key && candidate.deviceId !== deps.self && !found.has(key) && found.size < MAX_HELLO_ANSWERS) found.set(key, candidate);
    });
    socket.bind(0, undefined, () => {
      try { socket.setBroadcast(true); } catch { /* sending to unicast targets still works */ }
      const probe = Buffer.from(JSON.stringify({ q: 'wf-hello', v: 1, n: nonce }));
      const targets = deps.targets?.() ?? loopbackTargets(deps.env) ?? broadcastAddresses();
      for (const target of targets) socket.send(probe, deps.port ?? DISCOVERY_PORT, target, () => undefined);
    });
  });
}
