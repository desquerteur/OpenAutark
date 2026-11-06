// F-51 RPC surface (rpc/handlers/team-start.ts): every method is registered with the hiring tier
// ('manage'), fetching or reading patterns from outside stays owner-only, params are checked
// before the services run, and a runtime without the services answers 'unavailable'.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { teamFixture } from '../importers/fixture.ts';

const MANAGE = ['patterns.list', 'patterns.get', 'patterns.apply', 'patterns.saveFromOrg', 'patterns.remove'];

function ctx(services: RuntimeServices): HandlerContext {
  return { scope: { kind: 'owner' }, services, extras: {} as never, topics: new Set(), signal: new AbortController().signal, secure: true } as HandlerContext;
}

test('scopes: hiring tier for the start paths, owner only for outside patterns', () => {
  const table = createHandlerTable();
  for (const method of MANAGE) assert.deepEqual(table.get(method)?.scope, { capability: 'manage' }, method);
  for (const method of ['patterns.import', 'patterns.refresh']) assert.equal(table.get(method)?.scope, 'owner', method);
});

test('params are checked and the services answer through the handlers', async () => {
  const f = teamFixture();
  try {
    const table = createHandlerTable();
    const call = (method: string, params: unknown) => table.get(method)!.handler(params as never, ctx(f.s));
    await assert.rejects(async () => call('patterns.import', { url: 'https://x.test/p.md', text: 'y' }), /either url or text/);
    const list = await call('patterns.list', undefined) as Array<{ id: string }>;
    assert.ok(list.some((entry) => entry.id === 'builtin:research-team'));
    const bare = { ...f.s, patterns: undefined } as RuntimeServices;
    await assert.rejects(async () => table.get('patterns.list')!.handler(undefined as never, ctx(bare)), /not available/);
  } finally { f.cleanup(); }
});
