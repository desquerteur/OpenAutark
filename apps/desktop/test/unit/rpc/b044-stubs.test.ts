// B-044 methods that change or read this PC (an account reset, PCs nearby, the data folder) are registered
// owner-only (B-078: an account reset also for the owner's phone with 'settings' on a secure transport); a phone hears
// the chat-visible provider events, and account changes only with 'settings' on a secure transport.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { mayReceive } from '../../../src/runtime/rpc/scopes.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';

const OWNER_ONLY = ['remote.nearby', 'system.root'];

test('the B-044 methods are registered owner-only; accounts.useReset also for a secure settings phone (B-078)', () => {
  const table = createHandlerTable();
  for (const method of OWNER_ONLY) assert.equal(table.get(method)?.scope, 'owner', method);
  assert.deepEqual(table.get('accounts.useReset')?.scope, { capability: 'settings', secure: true });
});

test('provider events: a phone hears usage and models; accounts only with settings on a secure transport (B-078)', () => {
  const phone: ClientScope = { kind: 'device', deviceId: 'dev_phone', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true };
  const lan: ClientScope = { ...phone, secure: false };
  const chatOnly: ClientScope = { kind: 'device', deviceId: 'dev_chat', capabilities: ['chat'], secure: true };
  assert.equal(mayReceive(phone, 'providers', 'models.updated', []), true);
  assert.equal(mayReceive(phone, 'providers', 'account.removed', { id: 'acc_1' }), true);
  assert.equal(mayReceive(lan, 'providers', 'account.removed', { id: 'acc_1' }), false);
  assert.equal(mayReceive(chatOnly, 'providers', 'account.removed', { id: 'acc_1' }), false);
  assert.equal(mayReceive({ kind: 'owner' }, 'providers', 'account.removed', { id: 'acc_1' }), true);
});
