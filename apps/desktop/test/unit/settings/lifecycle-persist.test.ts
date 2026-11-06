// Settings › lifecycle (retention) has no defaults section, yet it must survive a restart – a second
// SettingsStore on the same settings.json reads it back, the retention reader sees the stored values, a patch
// naming the removed review rules is refused, and a damaged lifecycle section falls back to the defaults (absent)
// without bricking the other sections.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { retentionOf } from '../../../src/shared/model/lifecycle.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { clock, recordingBus, tempDir } from '../store/helpers.ts';

const env = { locale: 'de-DE', timezone: 'Europe/Berlin' };
const store = (dataDir: string) => new SettingsStore({ bus: recordingBus().bus, clock: clock(), env, dataDir });

test('lifecycle retention is read back after a restart; the review rules are no longer a setting', (t) => {
  const temp = tempDir('wf-lifecycle-');
  t.after(temp.cleanup);
  const dir = temp.dir;
  store(dir).update({ lifecycle: { retention: { traceDays: 30 } } });
  const reloaded = store(dir).get();
  assert.equal(retentionOf(reloaded).traceDays, 30);
  assert.equal(retentionOf(reloaded).historyDays, 0);
  // A later patch of one part keeps the other.
  store(dir).update({ lifecycle: { retention: { historyDays: 90 } } });
  const again = store(dir).get();
  assert.deepEqual(retentionOf(again), { traceDays: 30, historyDays: 90 });
  assert.throws(() => store(dir).update({ lifecycle: { reviews: [] } } as never), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

test('a damaged lifecycle section falls back to the defaults and keeps the other sections', (t) => {
  const temp = tempDir('wf-lifecycle-');
  t.after(temp.cleanup);
  writeFileSync(path.join(temp.dir, 'settings.json'), JSON.stringify({ preferences: { sidebarWidth: 300 }, lifecycle: { retention: { traceDays: -5 } } }));
  const loaded = store(temp.dir).get();
  assert.equal(loaded.lifecycle, undefined);
  assert.equal(retentionOf(loaded).traceDays, 0);
  assert.equal(loaded.preferences.sidebarWidth, 300);
});
