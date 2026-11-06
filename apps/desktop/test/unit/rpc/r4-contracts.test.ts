// R4 contracts on the RPC surface: media.*, agents.export, system.backup/restore
// and bridges.* are registered with the right scopes, check their params and hand clean input
// to RpcExtras (media, portability, bridges); media.upserted / bridge.upserted travel on the
// right topics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { allowedScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { mayReceive } from '../../../src/runtime/rpc/scopes.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { topicOf } from '../../../src/shared/api/events.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Bridge } from '../../../src/shared/model/bridges.ts';
import type { MediaInfo } from '../../../src/shared/model/media.ts';

const FILE = 'a'.repeat(64);
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const R4_METHODS = ['agents.export', 'bridges.connectTelegram', 'bridges.disconnect', 'bridges.list',
  'media.describe', 'media.list', 'system.backup', 'system.restore'];

const MEDIA: MediaInfo = { fileId: FILE, conversationId: 'ch_1', kind: 'image', mime: 'image/png', name: 'a.png', createdAt: 1, updatedAt: 1 };
const BRIDGE: Bridge = { id: 'br_1', kind: 'telegram', conversationId: 'ch_1', externalChatId: '42', status: 'connecting', createdAt: 1, updatedAt: 1 };

function fixture() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = <T>(fn: string, result: T) => (...args: unknown[]) => { calls.push({ fn, args }); return result; };
  const extras = {
    media: { list: record('media.list', [MEDIA]), describe: record('media.describe', MEDIA), get: record('media.get', MEDIA) },
    portability: {
      exportAgent: record('exportAgent', Promise.resolve({ id: FILE })),
      backup: record('backup', Promise.resolve({ path: '/b', bytes: 1 })),
      restore: record('restore', Promise.resolve({ ok: true, restartRequired: true })),
    },
    bridges: { list: record('bridges.list', [BRIDGE]), connectTelegram: record('connectTelegram', Promise.resolve(BRIDGE)), disconnect: record('disconnect', undefined) },
  } as unknown as RpcExtras;
  const table = createHandlerTable();
  const ctx: HandlerContext = { scope: { kind: 'owner' }, services: {} as RuntimeServices, extras, topics: new Set(), signal: new AbortController().signal };
  const call = async (method: string, params?: unknown) => table.get(method)!.handler(params as never, ctx);
  const last = () => calls.at(-1);
  return { table, call, calls, last };
}

async function rejectsParam(promise: Promise<unknown>, param: string, secret?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkforceError);
    assert.equal(error.code, 'bad_request');
    assert.equal(error.details?.param, param);
    if (secret) assert.ok(!error.message.includes(secret), 'error message must not echo the value');
    return true;
  });
}

test('media is a chat capability, agent transfer needs manage, backups and bridges stay owner only', () => {
  const { table } = fixture();
  type Capability = 'todo' | 'chat' | 'tasks' | 'settings' | 'manage';
  const device = (capabilities: Capability[]): ClientScope => ({ kind: 'device', deviceId: 'dev_x', capabilities } as ClientScope);
  for (const method of R4_METHODS) {
    assert.ok(table.get(method), `${method} registered`);
    assert.ok(allowedScope(table.get(method)!.scope, { kind: 'owner' }), `${method} open to the owner`);
  }
  for (const method of ['media.list', 'media.describe']) {
    assert.ok(allowedScope(table.get(method)!.scope, device(['chat'])), `${method} for chat devices`);
    assert.ok(!allowedScope(table.get(method)!.scope, device(['todo', 'tasks', 'settings'])), `${method} needs chat`);
  }
  assert.equal(table.get('agents.derive'), undefined, 'Duplicate is the skill agent-duplicate, not a method');
  for (const method of ['agents.export']) {
    assert.ok(allowedScope(table.get(method)!.scope, device(['manage'])), `${method} for manage devices`);
    assert.ok(!allowedScope(table.get(method)!.scope, device(['todo', 'chat', 'tasks', 'settings'])), `${method} needs manage`);
  }
  const everything = device(['todo', 'chat', 'tasks', 'settings', 'manage']);
  for (const method of ['bridges.connectTelegram', 'bridges.disconnect', 'bridges.list', 'system.backup', 'system.restore']) {
    assert.ok(!allowedScope(table.get(method)!.scope, everything), `${method} owner only (PC-local)`);
  }
});

test('media.list passes a clean filter and media.describe is authored by the human', async () => {
  const { call, last } = fixture();
  assert.deepEqual(await call('media.list'), [MEDIA]);
  assert.deepEqual(last()?.args, [{}]);
  await call('media.list', { conversationId: 'ch_1', kind: 'video', text: '  intro  ', limit: 20 });
  assert.deepEqual(last(), { fn: 'media.list', args: [{ conversationId: 'ch_1', kind: 'video', text: 'intro', limit: 20 }] });
  await call('media.list', { text: '   ' });
  assert.deepEqual(last()?.args, [{}]);
  await rejectsParam(call('media.list', { kind: 'gif' }), 'kind');
  await rejectsParam(call('media.list', { limit: 0 }), 'limit');
  await rejectsParam(call('media.list', { search: 'x' }), 'params.search');

  await call('media.describe', { fileId: FILE, description: 'Logo\non blue', tags: ['brand', 'logo'] });
  assert.deepEqual(last()?.args, [FILE, { description: 'Logo\non blue', tags: ['brand', 'logo'] }, 'human']);
  await call('media.describe', { fileId: FILE });
  assert.deepEqual(last()?.args, [FILE, {}, 'human']);
  await rejectsParam(call('media.describe', { fileId: 'not-a-sha' }), 'fileId');
  await rejectsParam(call('media.describe', { fileId: FILE, tags: 'brand' }), 'tags');
});

test('agent portability handlers check ids and pass defaults', async () => {
  const { call, last } = fixture();
  await call('agents.export', { id: 'ag_1' });
  assert.deepEqual(last(), { fn: 'exportAgent', args: ['ag_1', { includeKnowledge: true }] });
  await call('agents.export', { id: 'ag_1', includeKnowledge: false });
  assert.deepEqual(last()?.args, ['ag_1', { includeKnowledge: false }]);
  await rejectsParam(call('agents.export', { id: 'ag_1', knowledge: true }), 'params.knowledge');
});

test('backup and restore take absolute paths only', async () => {
  const { call, last } = fixture();
  await call('system.backup');
  assert.deepEqual(last(), { fn: 'backup', args: [undefined] });
  const dir = path.resolve('backups');
  await call('system.backup', { dir });
  assert.deepEqual(last()?.args, [dir]);
  await rejectsParam(call('system.backup', { dir: 'relative/dir' }), 'dir');
  assert.deepEqual(await call('system.restore', { path: path.join(dir, 'b.zip') }), { ok: true, restartRequired: true });
  await rejectsParam(call('system.restore', { path: 'b.zip' }), 'path');
  await rejectsParam(call('system.restore', {}), 'path');
});

test('bridges.connectTelegram takes exactly one of botToken / secretId and never echoes the token', async () => {
  const { call, last } = fixture();
  assert.deepEqual(await call('bridges.connectTelegram', { conversationId: 'ch_1', botToken: ` ${TOKEN} `, externalChatId: ' -100123 ' }), BRIDGE);
  assert.deepEqual(last(), { fn: 'connectTelegram', args: [{ conversationId: 'ch_1', externalChatId: '-100123', botToken: TOKEN }] });
  await call('bridges.connectTelegram', { conversationId: 'ch_1', secretId: 'sec_1', externalChatId: '@my_channel' });
  assert.deepEqual(last()?.args, [{ conversationId: 'ch_1', externalChatId: '@my_channel', secretId: 'sec_1' }]);
  await rejectsParam(call('bridges.connectTelegram', { conversationId: 'ch_1', externalChatId: '42' }), 'botToken');
  await rejectsParam(call('bridges.connectTelegram', { conversationId: 'ch_1', botToken: TOKEN, secretId: 'sec_1', externalChatId: '42' }), 'botToken', TOKEN);
  await rejectsParam(call('bridges.connectTelegram', { conversationId: 'ch_1', botToken: 'secret-but-wrong', externalChatId: '42' }), 'botToken', 'secret-but-wrong');
  await rejectsParam(call('bridges.connectTelegram', { conversationId: 'ch_1', botToken: TOKEN, externalChatId: 'some chat' }), 'externalChatId', TOKEN);
  await rejectsParam(call('bridges.connectTelegram', { botToken: TOKEN, externalChatId: '42' }), 'conversationId', TOKEN);
});

test('bridges.list and bridges.disconnect delegate', async () => {
  const { call, last } = fixture();
  assert.deepEqual(await call('bridges.list'), [BRIDGE]);
  assert.deepEqual(last()?.args, [undefined]);
  await call('bridges.list', { conversationId: 'ch_1' });
  assert.deepEqual(last()?.args, ['ch_1']);
  assert.deepEqual(await call('bridges.disconnect', { id: 'br_1' }), { ok: true });
  assert.deepEqual(last(), { fn: 'disconnect', args: ['br_1'] });
  await rejectsParam(call('bridges.disconnect', {}), 'id');
});

test('media.upserted travels on its chat (or chats), bridge.upserted on chats', () => {
  assert.equal(topicOf('media.upserted', MEDIA), 'chat:ch_1');
  assert.equal(topicOf('media.upserted', { ...MEDIA, conversationId: undefined }), 'chats');
  assert.equal(topicOf('bridge.upserted', BRIDGE), 'chats');
  const phone: ClientScope = { kind: 'device', deviceId: 'dev_p', capabilities: ['todo', 'chat'] };
  const todoOnly: ClientScope = { kind: 'device', deviceId: 'dev_t', capabilities: ['todo'] };
  assert.ok(mayReceive(phone, 'chat:ch_1', 'media.upserted'));
  assert.ok(!mayReceive(todoOnly, 'chat:ch_1', 'media.upserted'));
  assert.ok(!mayReceive(todoOnly, 'chats', 'bridge.upserted'));
});
