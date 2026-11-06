// UpdateService state machine (SM12) with a fake electron-updater and fake timers:
//   * macOS (no automatic install): apply() opens the download in the browser exactly once per
//     click, never downloads in the background; a failed open is an 'error' that apply() retries
//   * error → apply() checks again; it continues (download, install) only when an update was
//     already found; a download failure keeps its text although electron-updater reports it twice
//   * the restart gate: countdown, deferral ("Later") blocks the automatic restart but not a
//     click, and evaluateGate's table for idle / ui-busy / runtime-busy / off
//   * the desktop wiring passes its browser opener through (https only)
// Owns: these assertions. Never: electron, network or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPEN_FAILED, manualDownloadURL } from '../../../src/main/updates/manual-download.ts';
import { RELEASE_URL, downloadURL } from '../../../src/main/updates/release.ts';
import { BUSY_RECHECK_MS, COUNTDOWN_MS, IDLE_REQUIRED_S, evaluateGate } from '../../../src/main/updates/restart-gate.ts';
import type { GateInput } from '../../../src/main/updates/restart-gate.ts';
import { CHECK_INTERVAL_VISIBLE_MS } from '../../../src/main/updates/update-service.ts';
import { DesktopUpdates, openHttps } from '../../../src/main/updates-wiring.ts';
import { fakeClock, fakeUpdater, harness, settle } from './update-fakes.ts';

test('macOS: the state offers the manual download; the browser never opens by itself', async () => {
  const h = harness({ platform: 'darwin', arch: 'arm64', autoDownload: () => true });
  assert.equal(h.service.state.automaticInstall, false);
  assert.equal(h.service.state.downloadURL, downloadURL('darwin', 'arm64'));
  assert.match(h.service.state.downloadURL ?? '', /^https:\/\/github\.com\/.+\/releases\/latest\/download\/autark-mac-universal\.dmg$/);
  await h.service.check();
  await settle();
  assert.equal(h.service.state.status, 'available');
  assert.equal(h.service.state.availableVersion, '0.3.0');
  assert.deepEqual(h.opened, [], 'auto-download on macOS does not open the browser');
  assert.equal(h.calls.download, 0, 'no background download where the app cannot install');
  h.service.dispose();
});

test('macOS: apply() opens the download exactly once per click and keeps the state', async () => {
  const h = harness({ platform: 'darwin', arch: 'x64' });
  await h.service.check();
  const [first, second] = await Promise.all([h.service.apply(), h.service.apply()]);
  assert.deepEqual(h.opened, [downloadURL('darwin', 'x64')], 'a double click opens one browser tab');
  assert.equal(first.status, 'available');
  assert.equal(second.status, 'available');
  assert.equal(h.calls.download, 0);
  assert.equal(h.calls.install, 0);
  await h.service.apply();
  assert.equal(h.opened.length, 2, 'a later click opens it again');
  h.service.dispose();
});

test('macOS: a failed open becomes a retryable error; apply() checks again and opens', async () => {
  let fail = true;
  const opened: string[] = [];
  const h = harness({ platform: 'darwin', arch: 'arm64', openExternal: async (url) => { if (fail) throw new Error('no browser'); opened.push(url); } });
  await h.service.check();
  await h.service.apply();
  assert.equal(h.service.state.status, 'error');
  assert.equal(h.service.state.message, OPEN_FAILED);
  assert.equal(h.service.state.availableVersion, '0.3.0', 'the found update stays known');
  fail = false;
  await h.service.apply();
  assert.equal(h.calls.check, 2, 'retry re-checks first');
  assert.deepEqual(opened, [downloadURL('darwin', 'arm64')]);
  assert.equal(h.service.state.status, 'available');
  h.service.dispose();
});

test('an unknown architecture opens the latest release page', () => {
  assert.equal(downloadURL('darwin', 'ia32'), null);
  assert.equal(manualDownloadURL({}), `${RELEASE_URL}/latest`);
  assert.equal(manualDownloadURL({ downloadURL: 'https://example.invalid/x.dmg' }), 'https://example.invalid/x.dmg');
});

test('download error: kept message, apply() re-checks, becomes available and continues to install', async () => {
  const h = harness({ script: { downloadFails: 1 } });
  await h.service.check();
  assert.equal(h.service.state.status, 'available');
  await h.service.apply();
  assert.equal(h.service.state.status, 'error');
  assert.equal(h.service.state.message, 'Download failed. Click to try again.', 'the second report keeps the download text');
  assert.equal(h.service.state.availableVersion, '0.3.0');
  const before = h.states.length;
  await h.service.apply();
  const statuses = h.states.slice(before).map((state) => state.status).filter((status, n, all) => status !== all[n - 1]);
  assert.deepEqual(statuses, ['available', 'downloading', 'downloaded', 'installing']);
  assert.equal(h.calls.check, 2);
  assert.equal(h.calls.download, 2);
  assert.deepEqual(h.order, ['drain']);
  assert.equal(h.calls.install, 1);
  assert.equal(h.service.state.message, undefined, 'the error text is gone');
  h.service.dispose();
});

test('check error: retries by itself on the timer, apply() checks at once', async () => {
  const h = harness({ script: { checkFails: 2, version: null } });
  h.service.start(0);
  await h.clock.advance(0);
  assert.equal(h.service.state.status, 'error');
  assert.equal(h.service.state.message, 'Could not check for updates. Retrying automatically.');
  assert.deepEqual(h.clock.pending(), [CHECK_INTERVAL_VISIBLE_MS], 'one re-armed check timer, no interval');
  await h.clock.advance(CHECK_INTERVAL_VISIBLE_MS);
  assert.equal(h.calls.check, 2);
  assert.equal(h.service.state.status, 'error');
  await h.service.apply();
  assert.equal(h.calls.check, 3);
  assert.equal(h.service.state.status, 'current');
  assert.deepEqual(h.clock.pending(), [CHECK_INTERVAL_VISIBLE_MS]);
  h.service.dispose();
  assert.deepEqual(h.clock.pending(), []);
});

test('check error: "Try again" only checks; a found update waits for the next click', async () => {
  const script: { checkFails: number; version: string | null } = { checkFails: 1, version: null };
  const h = harness({ script });
  await h.service.check();
  assert.equal(h.service.state.status, 'error');
  script.version = '0.3.0';
  await h.service.apply();
  assert.equal(h.service.state.status, 'available', 'the retry re-checked');
  assert.equal(h.calls.download, 0, 'no download and no restart from a check retry');
  assert.equal(h.calls.install, 0);
  await h.service.apply();
  assert.equal(h.calls.install, 1, 'the next click updates');
  h.service.dispose();
});

test('gate: a downloaded update counts down and restarts by itself once the person is idle', async () => {
  const h = harness({ autoDownload: () => true });
  await h.service.check();
  await settle();
  assert.equal(h.service.state.status, 'downloaded');
  assert.ok(h.service.state.restartAt, 'countdown announced');
  assert.equal(h.service.state.restartAt! - h.clock.hooks.now(), COUNTDOWN_MS);
  await h.clock.advance(COUNTDOWN_MS);
  assert.equal(h.calls.install, 1);
  assert.deepEqual(h.order, ['drain']);
  assert.equal(h.service.state.status, 'installing');
  h.service.dispose();
});

test('gate: "Later" blocks the automatic restart but not a click', async () => {
  const h = harness({ autoDownload: () => true });
  await h.service.check();
  await settle();
  assert.ok(h.service.state.restartAt);
  h.service.defer();
  assert.equal(h.service.state.restartAt, undefined, 'countdown withdrawn');
  await h.clock.advance(COUNTDOWN_MS * 3);
  await h.service.evaluateRestart();
  assert.equal(h.calls.install, 0, 'no automatic restart after Later');
  assert.equal(h.service.state.restartAt, undefined);
  await h.service.apply();
  assert.equal(h.calls.install, 1, 'the click still installs');
  h.service.dispose();
});

test('gate: an active person delays the restart; a busy UI waits for its event', async () => {
  const h = harness({ autoDownload: () => true, idle: 20 });
  await h.service.check();
  await settle();
  assert.equal(h.service.state.status, 'downloaded');
  assert.equal(h.service.state.restartAt, undefined, 'no countdown while the person works');
  assert.ok(h.clock.pending().includes((IDLE_REQUIRED_S - 20) * 1000), 'looks again when the idle time can be reached');
  h.facts.rendererReady = false;
  h.facts.idleSeconds = 600;
  await h.service.evaluateRestart();
  assert.equal(h.service.state.restartAt, undefined);
  assert.ok(!h.clock.pending().includes((IDLE_REQUIRED_S - 20) * 1000), 'no restart timer while the UI is busy (an event re-evaluates)');
  h.facts.rendererReady = true;
  await h.service.evaluateRestart();
  assert.ok(h.service.state.restartAt, 'the UI event starts the countdown');
  h.service.dispose();
});

test('evaluateGate: the restart table', () => {
  const base: GateInput = { packaged: true, automaticInstall: true, autoDownload: true, deferred: false, rendererReady: true, idleSeconds: 600, runtimeReady: true };
  assert.deepEqual(evaluateGate(base), { action: 'restart' });
  for (const off of [{ packaged: false }, { automaticInstall: false }, { autoDownload: false }, { deferred: true }]) {
    assert.deepEqual(evaluateGate({ ...base, ...off }), { action: 'never' }, JSON.stringify(off));
  }
  assert.deepEqual(evaluateGate({ ...base, idleSeconds: 45.5 }), { action: 'wait', recheckMs: 15_000, reasons: ['user-active'] });
  assert.deepEqual(evaluateGate({ ...base, idleSeconds: 0 }), { action: 'wait', recheckMs: IDLE_REQUIRED_S * 1000, reasons: ['user-active'] });
  assert.deepEqual(evaluateGate({ ...base, rendererReady: false }), { action: 'wait', recheckMs: null, reasons: ['ui-busy'] });
  assert.deepEqual(evaluateGate({ ...base, runtimeReady: false }), { action: 'wait', recheckMs: BUSY_RECHECK_MS, reasons: ['runtime-busy'] });
  assert.deepEqual(evaluateGate({ ...base, runtimeReady: false, idleSeconds: 10 }), { action: 'wait', recheckMs: (IDLE_REQUIRED_S - 10) * 1000, reasons: ['runtime-busy', 'user-active'] });
  assert.deepEqual(evaluateGate({ ...base, rendererReady: false, runtimeReady: false, idleSeconds: 0 }),
    { action: 'wait', recheckMs: null, reasons: ['ui-busy', 'runtime-busy', 'user-active'] }, 'the UI reports by event');
});

test('development and test mode never check, download or open anything', async () => {
  const h = harness({ packaged: false, platform: 'darwin', arch: 'arm64' });
  assert.equal(h.service.state.status, 'development');
  h.service.start(0);
  assert.deepEqual(h.clock.pending(), []);
  await h.service.apply();
  assert.equal(h.calls.check, 0);
  assert.deepEqual(h.opened, []);
});

test('desktop wiring: the manual download goes through the injected opener; only https is opened', async () => {
  const opened: string[] = [];
  const clock = fakeClock();
  const updates = new DesktopUpdates({
    updater: fakeUpdater().updater,
    packaged: true, enabled: true, platform: 'darwin', arch: 'arm64', version: '0.2.0',
    autoDownload: () => true,
    setAutoDownload: async () => {},
    renderer: { rendererReady: true, prepareRestart: async () => true },
    idleSeconds: () => 600,
    runtime: { readiness: async () => ({ ready: true }), prepareRestart: async () => {}, stop: async () => {}, start: () => {} },
    publish: () => {},
    openExternal: async (url) => { opened.push(url); },
    ...clock.hooks,
  });
  await updates.service.check();
  await updates.apply();
  assert.deepEqual(opened, [downloadURL('darwin', 'arm64')]);
  assert.equal(updates.draining, false, 'a manual download never drains the app');
  updates.dispose();
  // The injected opener (desktop.ts passes electron's shell) only ever gets an https address.
  const passed: string[] = [];
  const record = async (url: string) => { passed.push(url); };
  await assert.rejects(openHttps('file:///C:/Windows/notepad.exe', record), /Only https/);
  await assert.rejects(openHttps('http://example.invalid/x.dmg', record), /Only https/);
  await openHttps('https://example.invalid/x.dmg', record);
  assert.deepEqual(passed, ['https://example.invalid/x.dmg']);
});
