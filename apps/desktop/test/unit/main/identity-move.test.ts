// The product's rename on one PC, on real temp folders with injected process checks and rename failures.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KEYRING_MARKER, NEW_PRODUCT_NAME, OLD_APP_WAIT_MS, OLD_PRODUCT_NAME, OLD_UPDATER_CACHE, PENDING_MARKER,
  appPids, appProcessAlive, applyIdentity, decideIdentity, finishIdentityMove, isAppImage, processImage, readMarker,
  updaterCacheRoot, type IdentityDeps,
} from '../../../src/main/identity-move.ts';
import type { LauncherDeps } from '../../../src/main/launcher-tasks.ts';
import { companyDir } from '../../../src/main/companies.ts';
import { removeOldLauncher } from '../../../src/main/updates-wiring.ts';

const root = mkdtempSync(path.join(os.tmpdir(), 'wf-identity-'));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function world(input: { old?: Record<string, string> | null; next?: Record<string, string> | null } = {}) {
  counter += 1;
  const appData = path.join(root, `w${counter}`);
  const oldDir = path.join(appData, OLD_PRODUCT_NAME);
  const newDir = path.join(appData, NEW_PRODUCT_NAME);
  mkdirSync(appData, { recursive: true });
  for (const [dir, files] of [[oldDir, input.old], [newDir, input.next]] as const) {
    if (!files) continue;
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  }
  let clock = 1_000_000;
  const slept: number[] = [];
  const deps: IdentityDeps = {
    platform: 'win32', productName: NEW_PRODUCT_NAME, packaged: true, testData: false,
    appData, userData: newDir,
    alive: () => false,
    now: () => clock,
    sleep: (ms) => { clock += ms; slept.push(ms); },
    bootAt: () => 0,
  };
  return { appData, oldDir, newDir, deps, slept };
}
const OLD_DATA = { 'workforce.db': 'old db', 'settings.json': '{}' };

test('the current product name changes nothing and touches nothing', () => {
  const w = world({ old: OLD_DATA });
  const decision = decideIdentity({ ...w.deps, productName: OLD_PRODUCT_NAME, userData: w.oldDir, alive: () => { throw new Error('no check'); } });
  assert.deepEqual(decision, { outcome: 'unchanged', dataDir: w.oldDir, keyringName: null });
  assert.ok(existsSync(path.join(w.oldDir, 'workforce.db')));
  assert.ok(!existsSync(w.newDir));
});

test('development, test data and a custom data folder change nothing', () => {
  const w = world({ old: OLD_DATA });
  assert.equal(decideIdentity({ ...w.deps, packaged: false }).outcome, 'unchanged');
  assert.equal(decideIdentity({ ...w.deps, testData: true }).outcome, 'unchanged');
  const custom = path.join(w.appData, 'custom');
  assert.deepEqual(decideIdentity({ ...w.deps, userData: custom }), { outcome: 'unchanged', dataDir: custom, keyringName: null });
  assert.ok(existsSync(w.oldDir), 'the old folder stays');
});

test('B-072: another company (--company=<id>, set before the check) changes nothing and moves nothing', () => {
  const w = world({ old: OLD_DATA });
  const company = companyDir(w.newDir, 'company-2');
  assert.equal(company, path.join(w.appData, `${NEW_PRODUCT_NAME} Companies`, 'company-2'));
  const decision = decideIdentity({ ...w.deps, userData: company, alive: () => { throw new Error('no check'); } });
  assert.deepEqual(decision, { outcome: 'unchanged', dataDir: company, keyringName: null });
  const app = fakeApp(w, NEW_PRODUCT_NAME, company);
  assert.equal(applyIdentity(app, { testData: false, overrides: { platform: 'darwin' } }).outcome, 'unchanged');
  assert.deepEqual(app.calls, [], 'no keyring name, no folder pinned');
  assert.ok(existsSync(path.join(w.oldDir, 'workforce.db')), 'the old folder waits for the first company');
});

test('old folder absent: a fresh start on the new folder, without a keyring name', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const w = world();
    assert.deepEqual(decideIdentity({ ...w.deps, platform }), { outcome: 'fresh', dataDir: w.newDir, keyringName: null, detail: undefined });
    assert.ok(!existsSync(w.newDir), 'nothing is created here');
  }
});

test('Windows: one rename moves everything, no marker for the keyring, a pending note for the leftovers', () => {
  const w = world({ old: OLD_DATA });
  const decision = decideIdentity(w.deps);
  assert.equal(decision.outcome, 'moved');
  assert.equal(decision.dataDir, w.newDir);
  assert.equal(decision.keyringName, null);
  assert.ok(!existsSync(w.oldDir), 'no second folder');
  assert.equal(readFileSync(path.join(w.newDir, 'workforce.db'), 'utf8'), 'old db');
  assert.ok(!existsSync(path.join(w.newDir, KEYRING_MARKER)));
  assert.ok(existsSync(path.join(w.newDir, PENDING_MARKER)));
});

test('macOS and Linux: the marker moves with the folder and keeps the secrets readable at every later start', () => {
  for (const platform of ['darwin', 'linux']) {
    const w = world({ old: OLD_DATA });
    const deps = { ...w.deps, platform };
    assert.deepEqual(decideIdentity(deps), { outcome: 'moved', dataDir: w.newDir, keyringName: OLD_PRODUCT_NAME, detail: undefined });
    assert.equal(readFileSync(path.join(w.newDir, KEYRING_MARKER), 'utf8').trim(), OLD_PRODUCT_NAME);
    assert.deepEqual(decideIdentity(deps), { outcome: 'fresh', dataDir: w.newDir, keyringName: OLD_PRODUCT_NAME, detail: undefined }, 'second start');
  }
});

test('macOS: no marker written, no move: secrets are never moved away from their name', () => {
  const w = world({ old: OLD_DATA });
  const decision = decideIdentity({ ...w.deps, platform: 'darwin', writeMarker: () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } });
  assert.equal(decision.outcome, 'move-failed');
  assert.equal(decision.dataDir, w.oldDir);
  assert.equal(decision.keyringName, OLD_PRODUCT_NAME);
  assert.ok(existsSync(path.join(w.oldDir, 'workforce.db')));
});

test('both have a database: the new one wins, the old one stays untouched, nothing is merged', () => {
  const w = world({ old: { 'workforce.db': 'old db', 'only-old': 'x' }, next: { 'workforce.db': 'new db' } });
  const decision = decideIdentity(w.deps);
  assert.equal(decision.outcome, 'kept-new');
  assert.equal(decision.dataDir, w.newDir);
  assert.match(decision.detail ?? '', /both/);
  assert.equal(readFileSync(path.join(w.newDir, 'workforce.db'), 'utf8'), 'new db');
  assert.equal(readFileSync(path.join(w.oldDir, 'workforce.db'), 'utf8'), 'old db');
  assert.ok(!existsSync(path.join(w.newDir, 'only-old')));
});

test('a new folder without a database (Electron started it) makes way, and comes back when the move fails', () => {
  const w = world({ old: OLD_DATA, next: { 'stub': 'x' } });
  const moved = decideIdentity(w.deps);
  assert.equal(moved.outcome, 'moved');
  assert.equal(readFileSync(path.join(w.newDir, 'workforce.db'), 'utf8'), 'old db');
  assert.ok(!existsSync(path.join(w.newDir, 'stub')));

  const f = world({ old: OLD_DATA, next: { 'stub': 'x' } });
  const failing = decideIdentity({ ...f.deps, platform: 'linux', rename: (from, to) => {
    if (from === f.oldDir) throw Object.assign(new Error('no'), { code: 'EXDEV' });
    renameSync(from, to);
  } });
  assert.equal(failing.outcome, 'move-failed');
  assert.equal(failing.dataDir, f.oldDir);
  assert.ok(existsSync(path.join(f.newDir, 'stub')), 'put back');
});

test('the old app still runs: this start stays on the old folder after the wait, the next one moves', () => {
  const w = world({ old: { ...OLD_DATA, 'runtime.json': JSON.stringify({ pid: 4242, at: new Date(1000).toISOString() }) } });
  const running = decideIdentity({ ...w.deps, platform: 'darwin', alive: pid => pid === 4242 });
  assert.equal(running.outcome, 'old-running');
  assert.equal(running.dataDir, w.oldDir);
  assert.equal(running.keyringName, OLD_PRODUCT_NAME, 'the old folder keeps its key meanwhile');
  assert.ok(existsSync(path.join(w.oldDir, 'workforce.db')));
  assert.equal(w.slept.reduce((a, b) => a + b, 0), OLD_APP_WAIT_MS);
  assert.equal(decideIdentity({ ...w.deps, platform: 'darwin' }).outcome, 'moved');
});

test('an old app that ends during the wait does not cost this start the move', () => {
  const w = world({ old: { ...OLD_DATA, 'runtime.json': JSON.stringify({ pid: 4242 }) } });
  let checks = 0;
  const decision = decideIdentity({ ...w.deps, alive: () => { checks += 1; return checks < 4; } });
  assert.equal(decision.outcome, 'moved');
  assert.equal(w.slept.length, 3);
});

test('a runtime.json from before the last boot names nobody: its pid may be any process now', () => {
  const dir = world({ old: { 'runtime.json': JSON.stringify({ pid: 7, at: new Date(5000).toISOString() }) } }).oldDir;
  assert.deepEqual(appPids(dir, 10_000), []);
  assert.deepEqual(appPids(dir, 1000), [7]);
  writeFileSync(path.join(dir, 'runtime.json'), 'not json');
  assert.deepEqual(appPids(dir, 0), []);
  writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ pid: -1 }));
  assert.deepEqual(appPids(dir, 0), []);
});

test("a pid counts only while it is one of the product's own processes, old name or new", () => {
  for (const image of [
    'C:\\Users\\Ann\\AppData\\Local\\Programs\\proactive-agent-workforce\\Proactive Agent Workforce.exe',
    'Autark.exe',
    '/Applications/Autark.app/Contents/Frameworks/Autark Helper.app/Contents/MacOS/Autark Helper',
    '/Applications/Proactive Agent Workforce.app/Contents/Frameworks/Proactive Agent Workforce Helper (Renderer).app/Contents/MacOS/Proactive Agent Workforce Helper (Renderer)',
    '/tmp/.mount_autarkXy/autark',
    '/opt/x/proactive-agent-workforce',
  ]) assert.ok(isAppImage(image), image);
  for (const image of ['svchost.exe', '/usr/bin/autarkic', 'node.exe', '', null]) assert.ok(!isAppImage(image), String(image));
  assert.ok(isAppImage(undefined), 'an image that cannot be told keeps the old wait');

  let reads = 0;
  const other = appProcessAlive(() => { reads += 1; return 'svchost.exe'; }, -1);
  assert.equal(other(process.pid), false, 'a live pid that another program got');
  assert.equal(other(process.pid), false);
  assert.equal(reads, 1, 'the image is read once per pid');
  assert.equal(appProcessAlive(() => 'Proactive Agent Workforce.exe', -1)(process.pid), true);
  assert.equal(appProcessAlive(() => 'Autark.exe', process.pid)(process.pid), false, 'this start itself');
  assert.equal(appProcessAlive(() => { throw new Error('no read for a dead pid'); }, -1)(2_147_483_000), false);
});

test('the real image of a process here, and none for a pid nobody has', () => {
  const own = processImage(process.pid);
  assert.equal(typeof own, 'string');
  assert.match(String(own), /node/i);
  assert.equal(processImage(2_147_483_000), null);
});

test('a runtime.json whose pid another program got does not hold the start; the old app does', () => {
  const runtime = JSON.stringify({ pid: process.pid, at: new Date(5000).toISOString() });
  const reused = world({ old: { ...OLD_DATA, 'runtime.json': runtime } });
  assert.equal(decideIdentity({ ...reused.deps, alive: appProcessAlive(() => 'svchost.exe', -1) }).outcome, 'moved');
  assert.deepEqual(reused.slept, []);
  const old = world({ old: { ...OLD_DATA, 'runtime.json': runtime } });
  assert.equal(decideIdentity({ ...old.deps, alive: appProcessAlive(() => 'Proactive Agent Workforce.exe', -1) }).outcome, 'old-running');
});

test("main's pid comes from Chromium's lock link where one exists", (t) => {
  const dir = world({ old: {} }).oldDir;
  try { symlinkSync('my-mac.local-5151', path.join(dir, 'SingletonLock')); } catch { t.skip('no symlink rights here'); return; }
  assert.deepEqual(appPids(dir, 0), [5151]);
});

test('a rename that fails leaves the old folder in use; Windows retries a held file a little, others do not', () => {
  const held = world({ old: OLD_DATA });
  let tries = 0;
  const decision = decideIdentity({ ...held.deps, rename: () => { tries += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
  assert.equal(decision.outcome, 'move-failed');
  assert.equal(decision.dataDir, held.oldDir);
  assert.equal(decision.detail, 'EBUSY');
  assert.equal(tries, 8);
  assert.ok(existsSync(path.join(held.oldDir, 'workforce.db')));

  const passing = world({ old: OLD_DATA });
  let attempts = 0;
  assert.equal(decideIdentity({ ...passing.deps, rename: (from, to) => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('scanner'), { code: 'EPERM' });
    renameSync(from, to);
  } }).outcome, 'moved');

  const linux = world({ old: OLD_DATA });
  let once = 0;
  assert.equal(decideIdentity({ ...linux.deps, platform: 'linux', rename: () => { once += 1; throw Object.assign(new Error('x'), { code: 'EPERM' }); } }).outcome, 'move-failed');
  assert.equal(once, 1);
});

test('the marker is one line of a name, or none', () => {
  const dir = world({ old: {} }).oldDir;
  assert.equal(readMarker(dir), null);
  writeFileSync(path.join(dir, KEYRING_MARKER), 'Old Name\n');
  assert.equal(readMarker(dir), 'Old Name');
  writeFileSync(path.join(dir, KEYRING_MARKER), 'two\nlines');
  assert.equal(readMarker(dir), null);
  writeFileSync(path.join(dir, KEYRING_MARKER), '   ');
  assert.equal(readMarker(dir), null);
});

function fakeApp(w: ReturnType<typeof world>, productName: string, userData = w.newDir) {
  const calls: string[] = [];
  let ready: () => void = () => {};
  const whenReady = new Promise<void>((resolve) => { ready = resolve; });
  return {
    calls, ready, whenReady: () => whenReady, isPackaged: true,
    getName: () => productName,
    setName: (name: string) => { calls.push(`setName ${name}`); },
    getPath: (name: 'appData' | 'userData') => (name === 'appData' ? w.appData : userData),
    setPath: (_name: 'userData', value: string) => { calls.push(`setPath ${value}`); },
  };
}

test('the old product name: applyIdentity calls nothing on the app', () => {
  const w = world({ old: OLD_DATA });
  const app = fakeApp(w, OLD_PRODUCT_NAME, w.oldDir);
  assert.equal(applyIdentity(app, { testData: false }).outcome, 'unchanged');
  assert.deepEqual(app.calls, []);
  assert.ok(existsSync(w.oldDir));
});

test('applyIdentity: keyring name first, then the folder pinned, the real name back at ready, a note in the log', async () => {
  const w = world({ old: OLD_DATA });
  const app = fakeApp(w, NEW_PRODUCT_NAME);
  applyIdentity(app, { testData: false, overrides: { ...w.deps, platform: 'darwin' } });
  assert.deepEqual(app.calls, [`setName ${OLD_PRODUCT_NAME}`, `setPath ${w.newDir}`]);
  app.ready();
  await app.whenReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.calls.at(-1), `setName ${NEW_PRODUCT_NAME}`);
  assert.match(readFileSync(path.join(w.newDir, 'logs', 'identity-move.log'), 'utf8'), /moved/);
});

test('applyIdentity on Windows only pins the folder; a fall back to the old folder is pinned too', () => {
  const w = world({ old: OLD_DATA });
  const app = fakeApp(w, NEW_PRODUCT_NAME);
  applyIdentity(app, { testData: false, overrides: { ...w.deps, rename: () => { throw Object.assign(new Error('x'), { code: 'EXDEV' }); } } });
  assert.deepEqual(app.calls, [`setPath ${w.oldDir}`]);
});

test('the leftovers go once; a busy cache is tried again at the next start', async () => {
  const w = world({ next: { [PENDING_MARKER]: '', 'workforce.db': '' } });
  const cacheRoot = path.join(w.appData, 'cache');
  mkdirSync(path.join(cacheRoot, OLD_UPDATER_CACHE, 'pending'), { recursive: true });
  let removed = 0;
  const finish = () => finishIdentityMove({ dataDir: w.newDir, cacheRoot, removeOldLauncher: async () => { removed += 1; if (removed === 1) throw Object.assign(new Error('x'), { code: 'EBUSY' }); } });
  await finish();
  assert.ok(existsSync(path.join(w.newDir, PENDING_MARKER)), 'stays after a failure');
  await finish();
  assert.ok(!existsSync(path.join(w.newDir, PENDING_MARKER)));
  assert.ok(!existsSync(path.join(cacheRoot, OLD_UPDATER_CACHE)));
  await finish();
  assert.equal(removed, 2, 'nothing more after that');
});

function launcherBench(platform: string) {
  const dir = path.join(root, `launcher${counter += 1}`);
  const calls: string[][] = [];
  const deps: LauncherDeps = {
    platform, packaged: true, testMode: false,
    getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => {},
    executable: '/app', name: NEW_PRODUCT_NAME, user: platform === 'win32' ? 'PC\\Ann' : 'ann', uid: 501,
    home: dir, configHome: path.join(dir, 'config'), dataDir: path.join(dir, 'data'),
    run: async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: '', stderr: '' }; },
  };
  mkdirSync(deps.dataDir, { recursive: true });
  return { deps, calls };
}

test('the old launcher entries: Windows by the old task name, and the new marker file is left alone', async () => {
  const { deps, calls } = launcherBench('win32');
  writeFileSync(path.join(deps.dataDir, 'launcher.json'), '{"hash":"new"}');
  await removeOldLauncher(deps);
  assert.deepEqual(calls, [['schtasks', '/Delete', '/TN', `${OLD_PRODUCT_NAME} Launcher (Ann)`, '/F']]);
  assert.ok(existsSync(path.join(deps.dataDir, 'launcher.json')));
});

test('the old launcher entries: Linux timer and autostart under the old name go, the new ones stay', async () => {
  const { deps, calls } = launcherBench('linux');
  const units = path.join(deps.configHome, 'systemd', 'user');
  mkdirSync(units, { recursive: true });
  mkdirSync(path.join(deps.configHome, 'autostart'), { recursive: true });
  const oldBase = 'proactive-agent-workforce';
  for (const file of [path.join(units, `${oldBase}-launcher.timer`), path.join(units, `${oldBase}-launcher.service`), path.join(deps.configHome, 'autostart', `${oldBase}.desktop`), path.join(units, 'autark-launcher.timer'), path.join(deps.configHome, 'autostart', 'autark.desktop')]) writeFileSync(file, 'x');
  await removeOldLauncher(deps);
  assert.ok(!existsSync(path.join(units, `${oldBase}-launcher.timer`)));
  assert.ok(!existsSync(path.join(units, `${oldBase}-launcher.service`)));
  assert.ok(!existsSync(path.join(deps.configHome, 'autostart', `${oldBase}.desktop`)));
  assert.ok(existsSync(path.join(units, 'autark-launcher.timer')));
  assert.ok(existsSync(path.join(deps.configHome, 'autostart', 'autark.desktop')));
  assert.ok(calls.some(call => call.includes(`${oldBase}-launcher.timer`)));
});

test('the old launcher entries: macOS has one label, nothing to remove', async () => {
  const { deps, calls } = launcherBench('darwin');
  await removeOldLauncher(deps);
  assert.deepEqual(calls, []);
});

test('the old updater cache sits where electron-updater keeps it', () => {
  assert.equal(updaterCacheRoot('win32', { LOCALAPPDATA: 'L' }, 'H'), 'L');
  assert.equal(updaterCacheRoot('darwin', {}, 'H'), path.join('H', 'Library', 'Caches'));
  assert.equal(updaterCacheRoot('linux', { XDG_CACHE_HOME: 'X' }, 'H'), 'X');
  assert.equal(updaterCacheRoot('linux', {}, 'H'), path.join('H', '.cache'));
});
