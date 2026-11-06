// The proofs of a connect request (remote/requests.ts, remote/join.ts): the identity a PC presents
// (PeerInfo, strictly parsed), MACs over a stable JSON form with constant-time comparison, the
// `{ ok: false }` reply shape, which addresses count (http(s) base URLs), and the order of a linked
// PC's addresses (the one that answered first).
// Owns: these pure helpers. Never: network, storage or secrets kept beyond a call.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Device } from '../../shared/model/devices.ts';
import { fromB64url } from './keys.ts';

/** An http(s) base URL without credentials (≤ 200 characters) – what a linked PC is dialed on. */
export function validAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && value.length <= 200;
  } catch {
    return false;
  }
}

export interface PeerInfo {
  id: string;
  name: string;
  role: Device['role'];
  pub: string; // base64url raw Ed25519
  addresses: string[];
}

export type Reply = { ok: true; [key: string]: unknown } | { ok: false; error: { code: string; message: string } };

/** A stable JSON form (sorted keys) for MACs and transcripts. */
export function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function mac(key: Uint8Array, label: string, ...parts: unknown[]): string {
  return createHmac('sha256', key).update(`wf-pair-v1|${label}|${parts.map(stable).join('|')}`).digest('base64url');
}

export function macOk(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseInfo(value: unknown): PeerInfo | undefined {
  const info = value as Partial<PeerInfo>;
  if (!info || typeof info !== 'object' || typeof info.id !== 'string' || !/^dev_[0-9a-z]{10,40}$/.test(info.id)) return undefined;
  if (typeof info.name !== 'string' || !info.name.trim() || info.name.length > 60) return undefined;
  if (info.role !== 'home' && info.role !== 'node') return undefined;
  if (typeof info.pub !== 'string' || fromB64url(info.pub).length !== 32) return undefined;
  const addresses = Array.isArray(info.addresses) ? info.addresses.filter((item): item is string => typeof item === 'string' && validAddress(item)).slice(0, 8) : [];
  return { id: info.id, name: info.name.trim(), role: info.role, pub: info.pub, addresses };
}

/** The address that answered first, then the other PC's own list (no duplicates, at most 8). */
export function workingFirst(address: string, reported: readonly string[]): string[] {
  return [address, ...reported.filter((item) => item !== address)].slice(0, 8);
}

export function fail(code: string, message: string): Reply {
  return { ok: false, error: { code, message } };
}
