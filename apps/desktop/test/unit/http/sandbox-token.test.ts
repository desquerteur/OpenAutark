// Capability tokens of `/sandbox/app` (sandbox-token.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_URL_TTL_MS, SandboxTokens, sandboxTokens } from '../../../src/runtime/http/sandbox-token.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { ManualClock } from '../devices/fakes.ts';

const MSG = 'msg_01jab3k9z7mx2c4q';

function parts(url: string) {
  const parsed = new URL(url, 'http://x');
  return { path: parsed.pathname, m: parsed.searchParams.get('m'), i: parsed.searchParams.get('i'), e: parsed.searchParams.get('e'), t: parsed.searchParams.get('t') };
}

test('mint returns a /sandbox/app path whose token verifies for exactly that block until expiry', () => {
  const clock = new ManualClock();
  const tokens = new SandboxTokens(() => clock.now());
  const { url, expiresAt } = tokens.mint(MSG, 2);
  const p = parts(url);
  assert.equal(p.path, '/sandbox/app');
  assert.equal(p.m, MSG);
  assert.equal(p.i, '2');
  assert.equal(expiresAt, clock.now() + SANDBOX_URL_TTL_MS);
  assert.equal(p.e, String(expiresAt));
  assert.match(p.t ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.ok(tokens.verify(MSG, 2, p.e, p.t));
  // Bound to message, index and expiry.
  assert.ok(!tokens.verify('msg_01jab3k9z7mx2c4r', 2, p.e, p.t));
  assert.ok(!tokens.verify(MSG, 3, p.e, p.t));
  assert.ok(!tokens.verify(MSG, 2, String(expiresAt + 1), p.t));
  // Expires after 10 minutes.
  clock.advance(SANDBOX_URL_TTL_MS - 1);
  assert.ok(tokens.verify(MSG, 2, p.e, p.t));
  clock.advance(1);
  assert.ok(!tokens.verify(MSG, 2, p.e, p.t));
});

test('verify rejects missing, malformed and foreign tokens', () => {
  const clock = new ManualClock();
  const tokens = new SandboxTokens(() => clock.now());
  const p = parts(tokens.mint(MSG, 0).url);
  for (const [e, t] of [[null, p.t], [p.e, null], ['', p.t], [p.e, ''], ['12x', p.t], [p.e, `${p.t}=`], [p.e, 'A'.repeat(43)], [p.e, (p.t ?? '').slice(0, 42)]]) {
    assert.ok(!tokens.verify(MSG, 0, e, t), `${e} ${t}`);
  }
  // Another runtime (another key) cannot verify it: a restart invalidates every URL.
  const other = new SandboxTokens(() => clock.now());
  assert.ok(!other.verify(MSG, 0, p.e, p.t));
});

test('sandboxTokens keeps one key per runtime services object', () => {
  const clock = new ManualClock();
  const a = { clock } as unknown as RuntimeServices;
  const b = { clock } as unknown as RuntimeServices;
  assert.equal(sandboxTokens(a), sandboxTokens(a));
  assert.notEqual(sandboxTokens(a), sandboxTokens(b));
  const p = parts(sandboxTokens(a).mint(MSG, 0).url);
  assert.ok(sandboxTokens(a).verify(MSG, 0, p.e, p.t));
  assert.ok(!sandboxTokens(b).verify(MSG, 0, p.e, p.t));
});
