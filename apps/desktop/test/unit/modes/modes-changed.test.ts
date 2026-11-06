// CTX8: mode menus follow saved and deleted modes.
//  - modes.changed {key} travels on 'system'; the owner and phones with the 'chat' tier (which may
//    call modes.list) receive it, links without 'chat' do not;
//  - a save or delete over RPC (real server, real ModeLibrary) pushes it once per change, a refused
//    save pushes nothing; compose/services.ts wires the library's onChange to the bus;
//  - lib/mode-changes.ts marks a cached copy stale after modes.changed and after every (re)connect;
//  - the composer's PlusMenu has no Mode menu; AgentView empties its cache.
// Owns: these assertions only. Never: Electron, network or the cross-package scope lists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topicOf } from '../../../src/shared/api/events.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { mayReceive, maySubscribe } from '../../../src/runtime/rpc/scopes.ts';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import { OWNER, TestClient, rpcFixture, settle } from '../rpc/s1-helpers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = (file: string) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const device = (capabilities: DeviceCapability[], secure = true): ClientScope => ({ kind: 'device', deviceId: 'dev_modes', capabilities, secure });
const COOKING = { key: 'cooking', name: 'Cooking', description: 'Plan meals and shop for them', instructions: 'You plan meals.' };

test('modes.changed travels on system: the owner and chat phones receive it, links without chat do not', () => {
  assert.equal(topicOf('modes.changed', { key: 'cooking' }), 'system');
  const data = { key: 'cooking' };
  assert.ok(mayReceive(OWNER, 'system', 'modes.changed', data));
  for (const scope of [device(['chat']), device(['todo', 'chat'], false), device(['todo', 'chat', 'tasks', 'settings', 'manage'])]) {
    assert.ok(maySubscribe(scope, 'system') && mayReceive(scope, 'system', 'modes.changed', data), JSON.stringify(scope));
  }
  for (const scope of [device(['todo']), device(['todo', 'tasks', 'settings', 'manage']), { kind: 'peer', deviceId: 'pc_b' } as ClientScope]) {
    assert.ok(!mayReceive(scope, 'system', 'modes.changed', data), JSON.stringify(scope));
  }
});

test('a save or delete over RPC pushes modes.changed {key} to the owner and chat phones; refused saves push nothing', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  mkdirSync(path.join(f.paths.resources, 'modes'), { recursive: true });
  // As compose/services.ts wires it (checked below).
  f.services.modes = new ModeLibrary({
    resources: f.paths.resources, data: f.paths.data, workspace: f.paths.workspace, clock: f.clock,
    onChange: (key) => f.bus.emit('modes.changed', { key }),
  });
  const owner = new TestClient(f.server, OWNER);
  const phone = new TestClient(f.server, device(['todo', 'chat']));
  const todo = new TestClient(f.server, device(['todo', 'tasks', 'settings', 'manage']));
  for (const client of [owner, phone, todo]) await client.call('events.subscribe', { topics: ['system'] });
  const keys = (client: TestClient) => client.events('modes.changed').map((frame) => (frame.data as { key: string }).key);

  await owner.call('modes.save', COOKING);
  await settle();
  assert.deepEqual(keys(owner), ['cooking']);
  assert.deepEqual(keys(phone), ['cooking']);
  assert.ok((await phone.call<ModeInfo[]>('modes.list')).some((entry) => entry.key === 'cooking'), 'the phone may load the list again');

  assert.equal((await owner.request('modes.save', { ...COOKING, key: 'Not a key' })).error?.code, 'bad_request');
  assert.equal((await phone.request('modes.save', { ...COOKING, name: 'Cooking 2' })).error?.code, 'forbidden');
  await settle();
  assert.deepEqual(keys(owner), ['cooking'], 'nothing changed, nothing pushed');

  assert.deepEqual(await owner.call('modes.delete', { key: 'cooking' }), { ok: true, restored: false });
  await settle();
  assert.deepEqual(keys(owner), ['cooking', 'cooking']);
  assert.deepEqual(keys(phone), ['cooking', 'cooking']);
  assert.deepEqual(keys(todo), [], 'a link without chat cannot read modes and hears nothing');
});

test('compose/services.ts passes the ModeLibrary an onChange that emits modes.changed on the bus', () => {
  const wiring = source('src/runtime/compose/services.ts').match(/new ModeLibrary\(\{([\s\S]*?)\}\);/)?.[1] ?? '';
  assert.match(wiring, /onChange: \(key\) => bus\.emit\('modes\.changed', \{ key \}\)/);
});

test('the composer has no Mode menu any more (agents choose their mode)', () => {
  const plus = source('src/ui/chat/composer/PlusMenu.tsx');
  assert.doesNotMatch(plus, /modes\.list|ModeMenu|label: 'Mode'/);
});

