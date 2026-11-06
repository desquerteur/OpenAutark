// Owns: UI request ids in the crypto environment of an opaque/HTTP page (no randomUUID).
// Never: weakens randomness or makes an authentication token; these are deduplication nonces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isId, newId } from '../../../src/shared/ids.ts';

test('UI request ids work with getRandomValues alone (no randomUUID)', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const original = globalThis.crypto;
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else Reflect.deleteProperty(globalThis, 'crypto'); });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: original.getRandomValues.bind(original) } });
  assert.equal(globalThis.crypto.randomUUID, undefined);
  const ids = Array.from({ length: 32 }, () => newId('req'));
  assert.ok(ids.every((id) => isId(id, 'req')));
  assert.equal(new Set(ids).size, ids.length);
});
