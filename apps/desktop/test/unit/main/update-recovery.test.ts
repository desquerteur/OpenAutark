// Update recovery through the real service and the pure UI projection: a background check
// after startup/resume never asks the person to retry; a verified failed action still does.
// Owns: recovery and automatic-discovery regressions. Never: network, Electron or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_INTERVAL_VISIBLE_MS, CHECK_INTERVAL_HIDDEN_MS, CHECK_THROTTLE_MS } from '../../../src/main/updates/update-service.ts';
import { updateControl } from '../../../src/ui/shell/update-control.ts';
import { harness } from './update-fakes.ts';

test('startup: an offline check stays quiet and automatically clears when current', async () => {
  const h = harness({ script: { checkFails: 1, version: null } });
  h.service.start();
  await h.clock.advance(3000);
  assert.equal(h.service.state.status, 'error');
  assert.equal(h.service.state.failure, 'check');
  assert.equal(updateControl(h.service.state), null);
  assert.ok(h.states.every(state => updateControl(state) === null), 'no transient retry arrow');
  await h.clock.advance(CHECK_INTERVAL_VISIBLE_MS);
  assert.equal(h.calls.check, 2);
  assert.equal(h.service.state.status, 'current');
  assert.equal(h.service.state.failure, undefined);
  assert.equal(updateControl(h.service.state), null);
  h.service.dispose();
});

test('resume/focus: checks recover without restart and retain the request throttle', async () => {
  const h = harness({ script: { checkFails: 1 } });
  await h.service.check();
  await h.service.checkIfDue();
  assert.equal(h.calls.check, 1, 'focus events do not flood the feed');
  await h.clock.advance(CHECK_THROTTLE_MS);
  await h.service.checkIfDue();
  assert.equal(h.calls.check, 2);
  assert.equal(h.service.state.failure, undefined);
  assert.equal(updateControl(h.service.state)?.glyph, 'download');
  h.service.dispose();
});

test('a running app discovers a newly published update on the next minute check', async () => {
  const script: { version: string | null } = { version: null };
  const h = harness({ script });
  await h.service.check();
  assert.equal(updateControl(h.service.state), null);
  script.version = '0.3.0';
  await h.clock.advance(CHECK_INTERVAL_VISIBLE_MS);
  assert.equal(h.service.state.availableVersion, '0.3.0');
  assert.equal(updateControl(h.service.state)?.glyph, 'download');
  assert.equal(h.calls.install, 0);
  h.service.dispose();
});

test('tray recovery stays quiet and returning to the window uses the faster cadence', async () => {
  const h = harness({ script: { checkFails: 2, version: null } });
  h.service.setVisible(false);
  await h.service.check();
  assert.deepEqual(h.clock.pending(), [CHECK_INTERVAL_HIDDEN_MS]);
  await h.clock.advance(CHECK_INTERVAL_HIDDEN_MS);
  assert.equal(updateControl(h.service.state), null);
  h.service.setVisible(true);
  assert.deepEqual(h.clock.pending(), [CHECK_INTERVAL_VISIBLE_MS]);
  await h.clock.advance(CHECK_INTERVAL_VISIBLE_MS);
  assert.equal(h.service.state.status, 'current');
  h.service.dispose();
});

test('retry requires an actual failed action and a verified update, not an old offer plus a failed check', async () => {
  const script = { version: '0.3.0' as string | null, downloadFails: 1 };
  const h = harness({ script });
  await h.service.check();
  await h.service.apply();
  assert.equal(h.service.state.failure, 'download');
  assert.equal(updateControl(h.service.state)?.glyph, 'retry');
  h.fail.check = 1;
  await h.service.check();
  assert.equal(h.service.state.availableVersion, '0.3.0');
  assert.equal(h.service.state.failure, 'check');
  assert.equal(updateControl(h.service.state), null, 'stale offer is no reason to show retry');
  script.version = null;
  await h.clock.advance(CHECK_INTERVAL_VISIBLE_MS);
  assert.equal(h.service.state.status, 'current');
  assert.equal(h.service.state.availableVersion, undefined);
  assert.equal(h.service.state.failure, undefined);
  assert.equal(updateControl(h.service.state), null);
  h.service.dispose();
});

test('macOS: a verified update with a failed browser open retains its retry action', async () => {
  const h = harness({ platform: 'darwin', openExternal: async () => { throw new Error('no browser'); } });
  await h.service.check();
  await h.service.apply();
  assert.equal(h.service.state.failure, 'open');
  assert.equal(updateControl(h.service.state)?.glyph, 'retry');
  h.service.dispose();
});

test('a failed restart keeps the verified download and the restart action', async () => {
  const h = harness({ prepareInstall: async () => { throw new Error('draft not saved'); } });
  await h.service.check();
  await assert.rejects(h.service.apply(), /Could not restart/);
  assert.equal(h.service.state.failure, 'restart');
  assert.equal(h.service.state.status, 'downloaded');
  assert.equal(updateControl(h.service.state)?.glyph, 'ready');
  assert.equal(updateControl(h.service.state)?.action, 'menu');
  assert.equal(h.calls.install, 0, 'never installs without a successful drain');
  h.service.dispose();
});
