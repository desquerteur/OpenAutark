// Provider histories (rpc/handlers/provider-history.ts): listing and purging a provider's history is owner-only;
// a purge needs confirm: true and reaches the privacy service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register as history } from '../../../src/runtime/rpc/handlers/provider-history.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from './s1-helpers.ts';

test('provider histories are owner-only', () => {
  const table = new HandlerTable();
  history(table);
  for (const method of ['privacy.providerHistories', 'privacy.purgeProviderHistory']) assert.equal(table.get(method)?.scope, 'owner', method);
});

test('a purge needs confirm and reaches the privacy service', async () => {
  const table = new HandlerTable();
  history(table);
  const f = rpcFixture({ table });
  try {
    const owner = new TestClient(f.server, OWNER);
    const calls: unknown[][] = [];
    f.services.privacy = {
      providerHistories: () => ({ codex: { deleted: 0, waiting: 0, failed: 0 }, claude: [] }),
      purgeProviderHistory: async (id: string) => { calls.push(['purge', id]); return { accountId: id, label: 'L', purged: true, renewed: 0 }; },
    } as never;
    await assert.rejects(owner.call('privacy.purgeProviderHistory', { accountId: 'acc_1' }), /confirm/);
    await owner.call('privacy.purgeProviderHistory', { accountId: 'acc_1', confirm: true });
    assert.deepEqual(calls.at(-1), ['purge', 'acc_1']);
    await assert.rejects(new TestClient(f.server, PHONE).call('privacy.providerHistories'));
  } finally { f.cleanup(); }
});
