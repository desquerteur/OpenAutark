// ui/blocks/mermaid.ts loads Mermaid lazily: a failed import (a Mermaid chunk that did not load)
// is tried again on the next call, one that loaded is kept. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrying } from '../../../src/ui/blocks/mermaid.ts';

test('retrying: a lazy import that failed is tried again next call, a loaded one is kept', async () => {
  let calls = 0;
  let fail = true;
  const load = retrying(async () => { calls++; if (fail) throw new Error('chunk failed'); return { ok: calls }; });
  await assert.rejects(load(), /chunk failed/);
  fail = false;
  const loaded = await load();
  assert.deepEqual(loaded, { ok: 2 }, 'imported again after the failure');
  assert.equal(await load(), loaded, 'kept once it loaded');
  assert.equal(calls, 2);
});
