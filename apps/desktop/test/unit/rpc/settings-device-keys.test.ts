// Settings audit 23.10.: a phone with the 'settings' tier changes preferences and notifications, but
// never the PC-only preferences (window close, login item, automatic update download) – they change
// the PC, so the runtime refuses them from a device even though the UI hides those rows there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { OWNER, TestClient, rpcFixture } from './s1-helpers.ts';

const FULL: DeviceCapability[] = ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'];
const phoneScope: ClientScope = { kind: 'device', deviceId: 'dev_keys', capabilities: FULL, secure: true };

test('a device may not change the PC-only preferences; the owner may; other preferences stay open', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const phone = new TestClient(f.server, phoneScope);
  const before = f.services.settings.get().preferences;
  for (const key of ['closeToTray', 'openAtLogin', 'autoDownloadUpdates']) {
    const refused = await phone.request('settings.update', { preferences: { theme: 'dark', [key]: !before[key as 'closeToTray'] } });
    assert.equal(refused.error?.code, 'forbidden', key);
    assert.equal((refused.error?.details as { key?: string } | undefined)?.key, key);
  }
  assert.deepEqual(f.services.settings.get().preferences, before, 'nothing of a refused patch is stored');
  const changed = await phone.call<Settings>('settings.update', { preferences: { theme: 'dark', enterSends: false }, notifications: { sound: false } });
  assert.equal(changed.preferences.theme, 'dark');
  assert.equal(changed.preferences.enterSends, false);
  assert.equal(changed.notifications.sound, false);
  const owner = new TestClient(f.server, OWNER);
  const mine = await owner.call<Settings>('settings.update', { preferences: { openAtLogin: true, closeToTray: false, autoDownloadUpdates: true } });
  assert.deepEqual([mine.preferences.openAtLogin, mine.preferences.closeToTray, mine.preferences.autoDownloadUpdates], [true, false, true]);
});

test("the global cost mode is the owner's (Settings.routing.costMode); a 'manage' phone keeps agent costs and the other global fields", async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const phone = new TestClient(f.server, phoneScope);
  const refused = await phone.request('models.setPolicy', { policy: { costMode: 'best', effort: 'high' } });
  assert.equal(refused.error?.code, 'forbidden');
  assert.equal(f.extras.policyStore.size, 0, 'nothing of the refused policy is stored');
  await phone.call('models.setPolicy', { policy: { effort: 'high' } });
  await phone.call('models.setPolicy', { agentId: 'ag_01jab3k9z7mx2c4q', policy: { costMode: 'economy' } });
  assert.deepEqual(f.extras.policyStore.get('ag_01jab3k9z7mx2c4q|'), { costMode: 'economy' });
  await new TestClient(f.server, OWNER).call('models.setPolicy', { policy: { costMode: 'best' } });
  assert.equal(f.extras.policyStore.get('|')?.costMode, 'best', 'the owner may (policies.ts moves it into routing)');
});
