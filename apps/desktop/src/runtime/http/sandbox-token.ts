// Short-lived capability URLs for `GET /sandbox/app` (```app frames in the PWA).
// A client with chat scope asks `blocks.sandboxUrl` and gets a path carrying an expiry and
// HMAC-SHA256(messageId:index:expiry) in base64url. The key is random per runtime boot and lives
// in memory only, so a restart invalidates every outstanding URL; the message id alone is no
// longer enough to read an app's HTML.
// Owns: minting and constant-time verification of these tokens. Never: persists or logs the
// key or a token, or accepts an expired or altered one.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RuntimeServices } from '../contracts.ts';

export const SANDBOX_URL_TTL_MS = 10 * 60_000;
const EXPIRY = /^\d{1,15}$/;
/** base64url of a 32-byte sha256 MAC (no padding). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export class SandboxTokens {
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(now: () => number, key: Buffer = randomBytes(32)) {
    this.now = now;
    this.key = key;
  }

  /** `/sandbox/app?m=<messageId>&i=<index>&e=<expiresAt>&t=<mac>`, valid for 10 minutes. */
  mint(messageId: string, index: number): { url: string; expiresAt: number } {
    const expiresAt = this.now() + SANDBOX_URL_TTL_MS;
    const query = new URLSearchParams({ m: messageId, i: String(index), e: String(expiresAt), t: this.mac(messageId, index, expiresAt).toString('base64url') });
    return { url: `/sandbox/app?${query}`, expiresAt };
  }

  /** True when `token` was minted here for exactly this message, block and expiry, and has not expired. */
  verify(messageId: string, index: number, expiry: string | null, token: string | null): boolean {
    if (!expiry || !EXPIRY.test(expiry) || !token || !TOKEN.test(token)) return false;
    const expiresAt = Number(expiry);
    if (expiresAt <= this.now()) return false;
    const given = Buffer.from(token, 'base64url');
    const expected = this.mac(messageId, index, expiresAt);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private mac(messageId: string, index: number, expiresAt: number): Buffer {
    return createHmac('sha256', this.key).update(`${messageId}:${index}:${expiresAt}`, 'utf8').digest();
  }
}

// One key per runtime: the RPC handler (blocks.sandboxUrl) and the HTTP route share the same
// RuntimeServices object, so both find the same instance without extra wiring.
const perRuntime = new WeakMap<RuntimeServices, SandboxTokens>();

export function sandboxTokens(services: RuntimeServices): SandboxTokens {
  let tokens = perRuntime.get(services);
  if (!tokens) perRuntime.set(services, (tokens = new SandboxTokens(() => services.clock.now())));
  return tokens;
}
