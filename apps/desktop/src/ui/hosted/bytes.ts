// The iPhone web app's byte helpers (B-078 follow-up): base64url without padding, standard base64, hex, UTF-8, joining,
// fresh random bytes and a constant-time compare – what Buffer does for the runtime, written for the browser (and Node's
// globals, so the unit tests run the same file). Owns: these conversions. Never: keys, sockets or storage.

/** Bytes backed by a plain ArrayBuffer (what WebCrypto takes). */
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Bytes => {
  const view = encoder.encode(text);
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
};

export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

/** Bytes as latin1 text (an HTTP head). */
export function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

export function fromLatin1(text: string): Bytes {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Standard base64 with padding (the PC's stream bytes, HTTP headers). */
export const b64std = (bytes: Uint8Array): string => btoa(latin1(bytes));

export function fromB64std(text: string): Bytes {
  return fromLatin1(atob(text));
}

export const b64url = (bytes: Uint8Array): string => b64std(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** base64url (padding tolerated); throws on characters outside the alphabet. */
export function fromB64url(text: string): Bytes {
  const clean = text.replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(clean)) throw new Error('Not base64url.');
  const padded = clean.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (clean.length % 4)) % 4);
  return fromB64std(padded);
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(text: string): Bytes {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export function random(length: number): Bytes {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Equal length and content, without an early exit. */
export function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** A copy that owns its own ArrayBuffer. */
export const own = (bytes: Uint8Array): Bytes => new Uint8Array(bytes);

/** Big-endian u32 at `at`. */
export const readU32 = (bytes: Uint8Array, at = 0): number => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];

export function writeU32(bytes: Uint8Array, value: number, at = 0): void {
  bytes[at] = (value >>> 24) & 0xff; bytes[at + 1] = (value >>> 16) & 0xff; bytes[at + 2] = (value >>> 8) & 0xff; bytes[at + 3] = value & 0xff;
}

/** Big-endian u64 (a counter) as 8 bytes. */
export function u64(value: bigint): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}

export const readU64 = (bytes: Uint8Array, at = 0): bigint => new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(0);
