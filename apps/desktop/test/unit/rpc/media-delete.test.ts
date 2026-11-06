// MM6 RPC surface: media.uses and media.delete are owner-only (deleting stored files stays on
// the PC, like deleting a chat), check their params and hand clean input to extras.media.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { allowedScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const FILE = 'b'.repeat(64);

function fixture() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const extras = {
    media: {
      uses: (...args: unknown[]) => { calls.push({ fn: 'uses', args }); return { messages: [], other: [] }; },
      delete: async (...args: unknown[]) => { calls.push({ fn: 'delete', args }); },
    },
  } as unknown as RpcExtras;
  const table = createHandlerTable();
  const ctx: HandlerContext = { scope: { kind: 'owner' }, services: {} as RuntimeServices, extras, topics: new Set(), signal: new AbortController().signal };
  const call = async (method: string, params?: unknown) => table.get(method)!.handler(params as never, ctx);
  return { table, call, calls };
}

async function rejectsParam(promise: Promise<unknown>, param: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && error.details?.param === param);
}

test('media.uses and media.delete are owner only', () => {
  const { table } = fixture();
  const everything: ClientScope = { kind: 'device', deviceId: 'dev_x', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true };
  for (const method of ['media.uses', 'media.delete']) {
    assert.ok(table.get(method), `${method} registered`);
    assert.ok(allowedScope(table.get(method)!.scope, { kind: 'owner' }), `${method} for the owner`);
    assert.ok(!allowedScope(table.get(method)!.scope, everything), `${method} not for devices`);
  }
});

test('params are checked and handed over cleanly', async () => {
  const { call, calls } = fixture();
  assert.deepEqual(await call('media.uses', { fileId: FILE }), { messages: [], other: [] });
  assert.deepEqual(calls.at(-1), { fn: 'uses', args: [FILE] });
  assert.deepEqual(await call('media.delete', { fileId: FILE }), { ok: true });
  assert.deepEqual(calls.at(-1), { fn: 'delete', args: [FILE, { messageIds: [] }] });
  await call('media.delete', { fileId: FILE, messageIds: ['msg_1', 'msg_2', 'msg_1'] });
  assert.deepEqual(calls.at(-1), { fn: 'delete', args: [FILE, { messageIds: ['msg_1', 'msg_2'] }] });

  await rejectsParam(call('media.uses', { fileId: 'x' }), 'fileId');
  await rejectsParam(call('media.delete', {}), 'fileId');
  await rejectsParam(call('media.delete', { fileId: FILE, force: true }), 'params.force');
  await rejectsParam(call('media.delete', { fileId: FILE, messageIds: 'msg_1' }), 'messageIds');
  await rejectsParam(call('media.delete', { fileId: FILE, messageIds: Array.from({ length: 101 }, (_, i) => `msg_${i}`) }), 'messageIds');
  assert.equal(calls.length, 3, 'refused params never reach the service');
});
