// Owns: explicit relaunch flags, installer-error recovery, watchdog lifetime and safe diagnostics.
// Never: runs an installer, accesses accounts or quits Electron (the native installer test does that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTALL_WATCHDOG_MS } from '../../../src/main/updates/update-service.ts';
import { harness } from './update-fakes.ts';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { allowInstallerRetry } from '../../../src/main/updates/install-retry.ts';
import type { Updater } from '../../../src/main/updates/update-service.ts';

test('the pinned real BaseUpdater permits the next explicit attempt after an async spawn error', async () => {
  const require = createRequire(import.meta.url);
  const { BaseUpdater } = require('electron-updater/out/BaseUpdater.js');
  const updater = Object.create(BaseUpdater.prototype);
  EventEmitter.call(updater);
  updater._logger = { info() {}, warn() {} };
  updater.downloadedUpdateHelper = { file: 'fixture-installer.exe', downloadedFileInfo: {} };
  updater.quitAndInstallCalled = false;
  let starts = 0;
  updater.doInstall = () => { starts++; queueMicrotask(() => updater.emit('error', new Error('spawn refused'))); return true; };
  allowInstallerRetry(updater as Updater);
  assert.equal(updater.install(true, true), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updater.install(true, true), true, 'the actual library guard no longer eats the retry');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 2);
});

test('Restart to Update requests silent installation and an explicit automatic relaunch', async () => {
  const h = harness();
  const flags: boolean[][] = [];
  h.updater.quitAndInstall = (silent, relaunch) => { flags.push([silent, relaunch]); };
  await h.service.check();
  await h.service.apply();
  assert.deepEqual(flags, [[true, true]]);
  assert.deepEqual(h.order, ['drain']);
  h.service.dispose();
});

test('watchdog recovery also releases the real library guard when no error event arrived', async () => {
  const require = createRequire(import.meta.url);
  const { BaseUpdater } = require('electron-updater/out/BaseUpdater.js');
  const updater = Object.create(BaseUpdater.prototype);
  EventEmitter.call(updater);
  updater._logger = { info() {}, warn() {} };
  updater.downloadedUpdateHelper = { file: 'fixture-installer.exe', downloadedFileInfo: {} };
  updater.doInstall = () => true;
  allowInstallerRetry(updater as Updater);
  assert.equal(updater.install(true, true), true);
  const h = harness();
  h.updater.resetInstallAttempt = () => updater.resetInstallAttempt();
  await h.service.check();
  await h.service.apply();
  await h.clock.advance(INSTALL_WATCHDOG_MS);
  assert.equal(updater.install(true, true), true, 'the next attempt is not swallowed');
  h.service.dispose();
});

test('a late installer-start failure resumes the drained app once and preserves the download', async () => {
  const lines: string[] = [];
  const h = harness({ log: line => lines.push(line) });
  await h.service.check();
  await h.service.apply();
  h.emit('error', { code: 'EACCES', message: 'private-value-must-not-be-logged', url: 'https://example.invalid/?token=private' });
  assert.deepEqual(h.order, ['drain', 'resume']);
  assert.equal(h.service.state.status, 'downloaded');
  assert.equal(h.service.state.failure, 'restart');
  assert.ok(lines.includes('update restart failed (EACCES)'));
  assert.doesNotMatch(lines.join('\n'), /private|example.invalid|token=/);
  await h.clock.advance(INSTALL_WATCHDOG_MS * 2);
  assert.deepEqual(h.order, ['drain', 'resume'], 'the cleared watchdog never resumes twice');
  h.service.dispose();
});

test('an installer that never quits reaches the watchdog and resumes exactly once', async () => {
  const h = harness();
  await h.service.check();
  await h.service.apply();
  await h.clock.advance(INSTALL_WATCHDOG_MS);
  assert.deepEqual(h.order, ['drain', 'resume']);
  assert.equal(h.service.state.status, 'downloaded');
  assert.equal(h.service.state.failure, 'restart');
  h.service.dispose();
});

test('graceful quit clears the installer watchdog, so shutdown cannot start the runtime again', async () => {
  const h = harness();
  await h.service.check();
  await h.service.apply();
  h.service.dispose();
  assert.deepEqual(h.clock.pending(), []);
  await h.clock.advance(INSTALL_WATCHDOG_MS * 2);
  h.emit('error', { code: 'EACCES' });
  await h.service.evaluateRestart();
  assert.deepEqual(h.order, ['drain']);
  assert.deepEqual(h.clock.pending(), []);
});
