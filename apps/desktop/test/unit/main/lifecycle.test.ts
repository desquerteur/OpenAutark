import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import type { UpdateState } from '../../../src/shared/model/system.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { appInfo, appPaths, launchFlags } from '../../../src/main/app-paths.ts';
import { PICK_LIMIT, dialogOptions, folderFiles, pickAndUpload } from '../../../src/main/files-pick.ts';
import { quitSteps, runShutdown } from '../../../src/main/shutdown.ts';
import { DesktopUpdates, inactiveUpdater } from '../../../src/main/updates-wiring.ts';
import type { DesktopUpdatesDeps } from '../../../src/main/updates-wiring.ts';
import type { Updater } from '../../../src/main/updates/update-service.ts';
import { fakeUpdater } from './update-fakes.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-main-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('app paths follow the build layout; AppInfo points the runtime at the app root', () => {
  const paths = appPaths({ appPath: path.join(tmp, 'resources', 'app.asar'), userData: path.join(tmp, 'Autark') });
  assert.equal(paths.runtime, path.join(tmp, 'resources', 'app.asar', 'app', 'runtime.mjs'));
  assert.equal(paths.preload, path.join(tmp, 'resources', 'app.asar', 'app', 'preload.cjs'));
  assert.equal(paths.ui, path.join(tmp, 'resources', 'app.asar', 'app', 'ui'));
  assert.equal(paths.blobs, path.join(tmp, 'Autark', 'blobs'));
  const info = appInfo({ version: '0.2.0', packaged: true, paths, executable: 'C:\\Program Files\\Workforce\\Workforce.exe' });
  assert.equal(info.resourcesDir, paths.root);
  assert.equal(info.dataDir, paths.data);
  assert.deepEqual(launchFlags(['app.exe', '--background']), { background: true, launcher: false, restarted: false });
  assert.deepEqual(launchFlags(['app.exe', '--background', '--launcher']), { background: true, launcher: true, restarted: false });
  assert.deepEqual(launchFlags(['app.exe', '--background', '--restarted']), { background: true, launcher: false, restarted: true });
  assert.deepEqual(launchFlags(['app.exe']), { background: false, launcher: false, restarted: false });
});

test('shutdown runs steps in order, skips failures and hung steps', async () => {
  const order: string[] = [];
  const lines: string[] = [];
  await runShutdown([
    { name: 'a', run: () => { order.push('a'); } },
    { name: 'b', run: () => { order.push('b'); throw new Error('boom'); } },
    { name: 'c', run: () => new Promise(() => { order.push('c'); }), timeoutMs: 20 },
    { name: 'd', run: async () => { order.push('d'); } },
  ], { log: line => lines.push(line) });
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"b" failed: boom/);
  assert.match(lines[1], /"c" timed out/);
});

test('quit order: drafts → updates → runtime; drained update quits fast', () => {
  const noop = () => undefined;
  const actions = { drained: false, flushDrafts: noop, disposeUpdates: noop, stopRuntime: noop, releasePower: noop, destroyTray: noop };
  assert.deepEqual(quitSteps(actions).map(step => step.name), ['drafts', 'updates', 'runtime', 'power', 'tray']);
  assert.deepEqual(quitSteps({ ...actions, drained: true }).map(step => step.name), ['updates', 'power', 'tray']);
});

test('folder picking: sorted, nested, bounded; uploads one by one and skips empty files', async () => {
  const folder = path.join(tmp, 'pick');
  mkdirSync(path.join(folder, 'b-sub'), { recursive: true });
  writeFileSync(path.join(folder, 'c.txt'), 'c');
  writeFileSync(path.join(folder, 'a.txt'), 'a');
  writeFileSync(path.join(folder, 'empty.txt'), '');
  writeFileSync(path.join(folder, 'b-sub', 'inner.md'), '# x');
  assert.deepEqual((await folderFiles(folder)).map(file => path.relative(folder, file)), ['a.txt', path.join('b-sub', 'inner.md'), 'c.txt', 'empty.txt']);
  await assert.rejects(folderFiles(folder, 2), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');

  const uploaded: string[] = [];
  const upload = async (file: string) => { uploaded.push(path.basename(file)); return { id: 'f'.repeat(64), name: path.basename(file), mime: 'text/plain', size: 1, createdAt: 0 }; };
  const refs = await pickAndUpload('folder', { showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }), upload });
  assert.equal(refs.length, 3);
  assert.deepEqual(uploaded, ['a.txt', 'inner.md', 'c.txt']);
  assert.deepEqual(await pickAndUpload('files', { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), upload }), []);
  const tooMany = Array.from({ length: PICK_LIMIT + 1 }, (_, i) => path.join(folder, `${i}.txt`));
  await assert.rejects(pickAndUpload('files', { showOpenDialog: async () => ({ canceled: false, filePaths: tooMany }), upload }));
  assert.deepEqual(dialogOptions('folder').properties, ['openDirectory']);
  assert.ok(dialogOptions('images').filters?.[0].extensions.includes('png'));
});

function updatesHarness(overrides: Partial<DesktopUpdatesDeps> = {}) {
  const order: string[] = [];
  const states: UpdateState[] = [];
  let runtimeReady = true;
  const deps: DesktopUpdatesDeps = {
    updater: inactiveUpdater(),
    packaged: true, enabled: true, platform: 'win32', arch: 'x64', version: '0.2.0',
    autoDownload: () => true,
    setAutoDownload: async enabled => { order.push(`auto:${enabled}`); },
    renderer: { rendererReady: true, prepareRestart: async () => { order.push('drafts'); return true; } },
    idleSeconds: () => 600,
    runtime: {
      readiness: async () => ({ ready: runtimeReady }),
      prepareRestart: async cancel => { order.push(cancel ? 'resume' : 'pause'); },
      stop: async () => { order.push('stop'); runtimeReady = false; },
      start: () => { order.push('start'); runtimeReady = true; },
    },
    publish: state => { states.push(state); },
    setTimer: () => 0,
    clearTimer: () => {},
    ...overrides,
  };
  return { deps, order, states };
}

/** An updater whose download completes immediately and whose installer start is recorded. */
function readyUpdater(onInstall: () => void): Updater {
  const listeners = new Map<string, (value: unknown) => void>();
  return {
    ...inactiveUpdater(),
    on: (event, listener) => { listeners.set(event, listener); },
    checkForUpdates: async () => { listeners.get('update-available')?.({ version: '0.3.0' }); return null; },
    downloadUpdate: async () => { listeners.get('update-downloaded')?.({ version: '0.3.0' }); return null; },
    quitAndInstall: () => onInstall(),
  };
}

test('update install drains in order and only then starts the installer', async () => {
  let installed = false;
  const h = updatesHarness();
  const updates = new DesktopUpdates({ ...h.deps, updater: readyUpdater(() => { h.order.push('install'); installed = true; }) });
  await updates.service.check();
  assert.equal(updates.state().status, 'downloaded');
  await updates.service.install(false);
  assert.ok(installed);
  assert.deepEqual(h.order, ['drafts', 'pause', 'stop', 'install']);
  assert.equal(updates.draining, true, 'quit after the installer must not drain again');
  updates.dispose();
});

test('an asynchronous installer error restarts the actual drained runtime wiring', async () => {
  const fake = fakeUpdater();
  const h = updatesHarness({ updater: fake.updater });
  const updates = new DesktopUpdates(h.deps);
  await updates.service.check();
  await updates.service.install(false);
  assert.equal(updates.draining, true);
  fake.emit('error', Object.assign(new Error('installer refused'), { code: 'EACCES' }));
  assert.deepEqual(h.order, ['drafts', 'pause', 'stop', 'start']);
  assert.equal(updates.draining, false);
  assert.equal(updates.state().status, 'downloaded');
  assert.equal(updates.state().failure, 'restart');
  assert.equal(updates.blockFailedUpdateQuit(), false, 'an ordinary Quit is not blocked by an old error');
  updates.markUpdateQuit(); // BaseUpdater emits this immediately before its already queued app.quit
  assert.equal(updates.blockFailedUpdateQuit(), true, 'a failed installer must not close the resumed app');
  assert.equal(updates.blockFailedUpdateQuit(), false, 'only that queued quit is cancelled');
  updates.dispose();
});

test('the native update-quit signal permits a successful install to quit normally', async () => {
  const fake = fakeUpdater();
  const updates = new DesktopUpdates(updatesHarness({ updater: fake.updater }).deps);
  await updates.service.check();
  await updates.service.install(false);
  updates.markUpdateQuit();
  assert.equal(updates.blockFailedUpdateQuit(), false);
  updates.dispose();
});

test('a refused draft flush aborts before anything stops; a cancelled automatic restart resumes', async () => {
  const refusing = updatesHarness({ renderer: { rendererReady: true, prepareRestart: async () => false } });
  const updates = new DesktopUpdates({ ...refusing.deps, updater: readyUpdater(() => refusing.order.push('install')) });
  await updates.service.check();
  await assert.rejects(updates.service.install(false));
  assert.deepEqual(refusing.order, [], 'nothing was paused or stopped');
  assert.equal(updates.state().status, 'downloaded', 'the download stays; a click retries');
  assert.ok(updates.state().message);
  updates.dispose();

  // Automatic install: after draining, the gate closes (the user came back) → everything resumes.
  let idle = 600;
  const h = updatesHarness({ idleSeconds: () => idle });
  const auto = new DesktopUpdates({ ...h.deps, updater: readyUpdater(() => h.order.push('install')) });
  await auto.service.check();
  h.deps.renderer.prepareRestart = async () => { h.order.push('drafts'); idle = 0; return true; };
  await auto.service.install(true);
  assert.deepEqual(h.order, ['drafts', 'pause', 'stop', 'start']);
  assert.equal(auto.state().status, 'downloaded');
  assert.equal(auto.draining, false);
  auto.dispose();
});

test('auto-download preference goes through the runtime settings', async () => {
  const h = updatesHarness({ packaged: false });
  const updates = new DesktopUpdates(h.deps);
  assert.equal((await updates.setAutoDownload(true)).status, 'development');
  assert.deepEqual(h.order, ['auto:true']);
  updates.dispose();
});
