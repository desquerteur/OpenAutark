// The Mac self-update without a Mac: capability and feed logic, download and staging with fake commands, the settling on
// real folders, and the helper script itself run by a real sh (Git Bash here) with a fake `open`. ditto, codesign,
// PlistBuddy, Gatekeeper and a real swap in /Applications are not exercised by any of this.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  FAILED_FILE, MacSelfUpdater, PREVIOUS_BUNDLE, STAGING_DIR, SWAP_SCRIPT, appBundleOf, macCapability, macSelfUpdater, pickZip, settleMacUpdate, type MacSelfUpdateDeps,
} from '../../../src/main/updates/mac-self-update.ts';
import { feedFileUrl } from '../../../src/main/updates-wiring.ts';
import { UpdateService } from '../../../src/main/updates/update-service.ts';
import { fakeClock, fakeUpdater, settle } from './update-fakes.ts';

const root = mkdtempSync(path.join(os.tmpdir(), 'wf-macupdate-'));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string) => { counter += 1; const dir = path.join(root, `${name}${counter}`); mkdirSync(dir, { recursive: true }); return dir; };

test('the bundle of the running binary', () => {
  assert.equal(appBundleOf('/Applications/Autark.app/Contents/MacOS/Autark'), '/Applications/Autark.app');
  assert.equal(appBundleOf('/opt/electron/electron'), null);
});

test('the capability check decides; everything else keeps the manual path', () => {
  const base = { bundle: '/Applications/Autark.app', version: '1.0.0', failedVersion: null, writable: () => true };
  assert.equal(macCapability(base), null);
  assert.equal(macCapability({ ...base, bundle: null }), 'not an app bundle');
  assert.equal(macCapability({ ...base, bundle: '/private/var/folders/x/AppTranslocation/ABC/d/Autark.app' }), 'translocated');
  assert.equal(macCapability({ ...base, bundle: '/Volumes/Autark/Autark.app' }), 'on a mounted volume');
  assert.equal(macCapability({ ...base, writable: target => target !== '/Applications' }), 'folder not writable');
  assert.equal(macCapability({ ...base, writable: target => target === '/Applications' }), 'folder not writable');
  assert.equal(macCapability({ ...base, failedVersion: '1.0.0' }), 'failed before for this version');
  assert.equal(macCapability({ ...base, failedVersion: '0.9.0' }), null, 'the version a manual update replaced tries again');
});

test('the zip of the feed: universal, or the one for this architecture', () => {
  const universal = [{ url: 'autark-mac-universal.zip' }, { url: 'autark-mac-universal.dmg' }];
  assert.equal(pickZip(universal, 'arm64')?.url, 'autark-mac-universal.zip');
  assert.equal(pickZip(universal, 'x64')?.url, 'autark-mac-universal.zip');
  const split = [{ url: 'a-x64.zip' }, { url: 'a-arm64.zip' }];
  assert.equal(pickZip(split, 'arm64')?.url, 'a-arm64.zip');
  assert.equal(pickZip(split, 'x64')?.url, 'a-x64.zip');
  assert.equal(pickZip([{ url: 'a.dmg' }], 'x64'), null);
});

test('the real provider of the pinned library resolves the address the wrapper asks for', () => {
  const require = createRequire(import.meta.url);
  const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider.js');
  const provider = new GitHubProvider({ provider: 'github', owner: 'teydra', repo: 'r' }, { allowPrerelease: false }, { executor: {}, platform: 'darwin', isUseMultipleRangeRequest: false });
  const file = { url: 'autark-mac-universal.zip', sha512: 'x' };
  const info = { version: '1.0.0', tag: 'v1.0.0', files: [file] };
  const updater = { updateInfoAndProvider: { info, provider } } as never;
  assert.equal(feedFileUrl(updater, file, info), 'https://github.com/teydra/r/releases/download/v1.0.0/autark-mac-universal.zip');
  assert.throws(() => feedFileUrl({} as never, file, info), /not known/);
});

const ZIP = Buffer.from('zip bytes of the update');
const SHA = createHash('sha512').update(ZIP).digest('base64');

function bench(script: { sha?: string; ok?: boolean; fail?: string; id?: string; version?: string; apps?: readonly string[]; zipUrl?: string } = {}) {
  const parent = fresh('apps');
  const bundle = path.join(parent, 'Autark.app');
  mkdirSync(bundle);
  const cacheDir = path.join(fresh('cache'), 'c');
  const commands: string[][] = [];
  const spawned: string[][] = [];
  let quits = 0;
  let spawnError: Error | null = null;
  const deps: MacSelfUpdateDeps = {
    bundle, version: '1.0.0', pid: 321, arch: 'arm64', cacheDir,
    resolveUrl: (file) => `https://feed.example/${file.url}`,
    fetch: async () => (script.ok === false ? new Response('nope', { status: 503 }) : new Response(ZIP, { headers: { 'content-length': String(ZIP.length) } })),
    run: async (command, args) => {
      commands.push([command, ...args]);
      if (script.fail === command) return { code: 1, stdout: '', stderr: `${command} refused` };
      if (command === 'ditto') for (const name of script.apps ?? ['Autark.app']) mkdirSync(path.join(args[3], name), { recursive: true });
      if (command.endsWith('PlistBuddy')) {
        const own = args[2].startsWith(bundle);
        const stdout = args[1].includes('Identifier') ? (own ? 'com.teydralab.workforce' : script.id ?? 'com.teydralab.workforce') : script.version ?? '1.1.0';
        return { code: 0, stdout: `${stdout}\n`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnHelper: (args, onError) => { if (spawnError) throw spawnError; spawned.push(args); void onError; },
    quit: () => { quits += 1; },
  };
  const { updater: inner, calls, emit } = fakeUpdater({ version: '1.1.0' });
  const events: Array<[string, unknown]> = [];
  const updater = new MacSelfUpdater(inner, deps);
  for (const event of ['update-available', 'download-progress', 'update-downloaded', 'error', 'manual-only']) updater.on(event, value => events.push([event, value]));
  const announce = () => emit('update-available', { version: '1.1.0', files: [{ url: script.zipUrl ?? 'x-universal.zip', sha512: script.sha ?? SHA, size: ZIP.length }, { url: 'x.dmg', sha512: 'y' }] });
  announce();
  const named = (event: string) => events.filter(item => item[0] === event).map(item => item[1]);
  return { updater, inner, calls, announce, parent, bundle, cacheDir, commands, spawned, quits: () => quits, failSpawn: (e: Error) => { spawnError = e; }, named, deps };
}

test('settings go to the real updater: its own default would start a Squirrel download', () => {
  const b = bench();
  b.updater.autoDownload = false;
  b.updater.logger = null;
  assert.equal(b.inner.autoDownload, false);
  assert.equal(b.inner.logger, null);
});

test('download: checksum, unpack beside the app, signature, bundle id and version, then "downloaded"', async () => {
  const b = bench();
  await b.updater.downloadUpdate();
  assert.equal(b.calls.download, 0, 'never the Squirrel path');
  const staged = path.join(b.parent, STAGING_DIR, 'Autark.app');
  assert.ok(existsSync(staged));
  assert.deepEqual(b.commands.map(c => path.basename(c[0])), ['ditto', 'codesign', 'PlistBuddy', 'PlistBuddy', 'PlistBuddy', 'xattr']);
  assert.deepEqual(b.commands[1], ['codesign', '--verify', '--deep', '--strict', staged]);
  assert.deepEqual(b.named('update-downloaded'), [{ version: '1.1.0' }]);
  assert.equal((b.named('download-progress').at(-1) as { percent: number }).percent, 100);
  assert.ok(!existsSync(path.join(b.cacheDir, 'update.zip')), 'the zip does not stay');
});

test('a wrong checksum stops before anything is unpacked; a retry is still possible', async () => {
  const b = bench({ sha: 'wrong' });
  await assert.rejects(b.updater.downloadUpdate(), /checksum/);
  assert.deepEqual(b.commands, []);
  assert.ok(!existsSync(path.join(b.cacheDir, 'update.zip')));
  assert.equal(b.named('error').length, 1);
  assert.equal(b.named('manual-only').length, 0);
});

test('a failed download and a missing zip are errors, not an unpack', async () => {
  const offline = bench({ ok: false });
  await assert.rejects(offline.updater.downloadUpdate(), /503/);
  assert.deepEqual(offline.commands, []);
  const nozip = bench({ zipUrl: 'x.tar' });
  await assert.rejects(nozip.updater.downloadUpdate(), /no zip/);
});

for (const [name, script, message] of [
  ['a broken signature', { fail: 'codesign' }, /signature failed: codesign refused/],
  ['another application', { id: 'com.someone.else' }, /another application/],
  ['another version', { version: '9.9.9' }, /not the announced version/],
  ['a zip without one app', { apps: ['A.app', 'B.app'] }, /one app/],
  ['a failed unpack', { fail: 'ditto' }, /unpack failed/],
] as const) {
  test(`${name}: nothing stays staged, the manual path takes over now and at the next start`, async () => {
    const b = bench(script);
    await assert.rejects(b.updater.downloadUpdate(), message);
    assert.ok(!existsSync(path.join(b.parent, STAGING_DIR)));
    assert.equal(b.named('manual-only').length, 1);
    assert.equal(readFileSync(path.join(b.cacheDir, FAILED_FILE), 'utf8').trim(), '1.0.0');
    assert.equal(macSelfUpdater(b.inner, b.deps), null, 'the next start keeps the plain updater');
  });
}

test('install: the helper gets every path as an argument, then the app quits; a second click only quits', async () => {
  const b = bench();
  await b.updater.downloadUpdate();
  b.updater.quitAndInstall();
  assert.equal(b.spawned.length, 1);
  const [flag, script, name, pid, old, staged, target, previous, failed, version] = b.spawned[0];
  assert.deepEqual([flag, script, name, pid, version], ['-c', SWAP_SCRIPT, 'workforce-update', '321', '1.0.0']);
  assert.equal(old, b.bundle);
  assert.equal(staged, path.join(b.parent, STAGING_DIR, 'Autark.app'));
  assert.equal(target, b.bundle);
  assert.equal(previous, path.join(b.parent, PREVIOUS_BUNDLE));
  assert.equal(failed, path.join(b.cacheDir, FAILED_FILE));
  assert.equal(b.quits(), 1);
  b.updater.quitAndInstall();
  assert.equal(b.spawned.length, 1);
  assert.equal(b.quits(), 2);
});

test('an update under a new product name lands beside the old bundle under its own name, unless that name is taken', async () => {
  const b = bench({ apps: ['Next.app'] });
  await b.updater.downloadUpdate();
  b.updater.quitAndInstall();
  assert.equal(b.spawned[0][6], path.join(b.parent, 'Next.app'));

  const taken = bench({ apps: ['Next.app'] });
  mkdirSync(path.join(taken.parent, 'Next.app'));
  await taken.updater.downloadUpdate();
  taken.updater.quitAndInstall();
  assert.equal(taken.spawned[0][6], taken.bundle, 'never moved into an existing bundle');
});

test('install without a staged app, or a helper that cannot start: an error, and the app does not quit', async () => {
  const none = bench();
  none.updater.quitAndInstall();
  assert.equal(none.named('error').length, 1);
  assert.equal(none.quits(), 0);

  const b = bench();
  await b.updater.downloadUpdate();
  b.failSpawn(new Error('no sh'));
  b.updater.quitAndInstall();
  assert.equal(b.named('error').length, 1);
  assert.equal(b.quits(), 0);
});

test('the service: it installs by itself with the wrapper, without it the download opens; manual-only switches at once', async () => {
  const clock = fakeClock();
  const options = {
    packaged: true, enabled: true, platform: 'darwin', arch: 'arm64', version: '1.0.0', autoDownload: () => false,
    facts: async () => ({ rendererReady: true, idleSeconds: 600, runtimeReady: true }),
    prepareInstall: async () => {}, openExternal: async () => {}, changed: () => {}, ...clock.hooks,
  };
  const plain = new UpdateService(fakeUpdater().updater, options);
  assert.equal(plain.state.automaticInstall, false);

  const b = bench({ fail: 'codesign' });
  const service = new UpdateService(b.updater, options);
  assert.equal(service.state.automaticInstall, true);
  assert.equal(b.inner.autoDownload, false, 'the service turned the real updater off');
  await service.check();
  b.announce(); // the real library's event carries the feed's files; the shared fake's does not
  await service.download();
  await settle();
  assert.equal(service.state.automaticInstall, false);
  assert.equal(service.state.status, 'error');
  service.dispose();
});

// ---------------------------------------------------------------- the helper, by a real sh

const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const unix = (value: string) => value.replace(/\\/g, '/');
/** A drive's colon would split $PATH under Git Bash: /c/... there, unchanged elsewhere. */
const shPath = (value: string) => unix(value).replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`);

function swapBench(names: { same?: boolean } = {}) {
  const parent = fresh('swap');
  const bin = path.join(parent, 'bin');
  mkdirSync(bin);
  const opened = path.join(parent, 'opened');
  writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$1" >> "${unix(opened)}"\n`);
  chmodSync(path.join(bin, 'open'), 0o755);
  const old = path.join(parent, 'Old.app');
  const staging = path.join(parent, STAGING_DIR);
  const staged = path.join(staging, 'New.app');
  mkdirSync(old);
  writeFileSync(path.join(old, 'which'), 'old');
  mkdirSync(staged, { recursive: true });
  writeFileSync(path.join(staged, 'which'), 'new');
  const target = names.same ? old : path.join(parent, 'New.app');
  const previous = path.join(parent, PREVIOUS_BUNDLE);
  const failed = path.join(parent, FAILED_FILE);
  const run = (pid: string, prefix = '') => spawnSync('sh', ['-c', `${prefix}PATH="${shPath(bin)}:$PATH"; export PATH\nsh -c "$SCRIPT" helper "${pid}" "$OLD" "$STAGED" "$TARGET" "$PREVIOUS" "$FAILED" 1.0.0`], {
    encoding: 'utf8',
    env: { ...process.env, SCRIPT: SWAP_SCRIPT, OLD: unix(old), STAGED: unix(staged), TARGET: unix(target), PREVIOUS: unix(previous), FAILED: unix(failed) },
  });
  const which = (dir: string) => readFileSync(path.join(dir, 'which'), 'utf8');
  const openedList = () => (existsSync(opened) ? readFileSync(opened, 'utf8').trim().split('\n') : []);
  return { parent, bin, old, staging, staged, target, previous, failed, run, which, openedList };
}

const DEAD = '2147483000'; // no such process

test('helper: the swap under the same name keeps the old app as the previous one and starts the new', { skip: !sh }, () => {
  const b = swapBench({ same: true });
  assert.equal(b.run(DEAD).status, 0);
  assert.equal(b.which(b.old), 'new');
  assert.equal(b.which(b.previous), 'old');
  assert.ok(!existsSync(b.staging));
  assert.deepEqual(b.openedList(), [unix(b.old)]);
  assert.ok(!existsSync(b.failed));
});

test('helper: under a new name the old name is gone, and an older previous one is replaced', { skip: !sh }, () => {
  const b = swapBench();
  mkdirSync(b.previous);
  writeFileSync(path.join(b.previous, 'which'), 'older');
  assert.equal(b.run(DEAD).status, 0);
  assert.equal(b.which(b.target), 'new');
  assert.ok(!existsSync(b.old));
  assert.equal(b.which(b.previous), 'old');
  assert.deepEqual(b.openedList(), [unix(b.target)]);
});

function fakeMv(b: ReturnType<typeof swapBench>, refused: string) {
  writeFileSync(path.join(b.bin, 'mv'), `#!/bin/sh\ncase "$2" in\n  "${unix(refused)}") exit 1 ;;\nesac\nexec /usr/bin/mv "$1" "$2"\n`);
  chmodSync(path.join(b.bin, 'mv'), 0o755);
}

test('helper: macOS refuses to move the old app: it stays, the old app starts, the version is noted', { skip: !sh }, () => {
  const b = swapBench({ same: true });
  fakeMv(b, b.previous);
  assert.equal(b.run(DEAD).status, 1);
  assert.equal(b.which(b.old), 'old');
  assert.ok(!existsSync(b.staging));
  assert.deepEqual(b.openedList(), [unix(b.old)]);
  assert.equal(readFileSync(b.failed, 'utf8').trim(), '1.0.0');
});

test('helper: the new app cannot move in: the old one is restored and starts', { skip: !sh }, () => {
  const b = swapBench();
  fakeMv(b, b.target);
  assert.equal(b.run(DEAD).status, 1);
  assert.equal(b.which(b.old), 'old');
  assert.ok(!existsSync(b.previous));
  assert.ok(!existsSync(b.staging));
  assert.deepEqual(b.openedList(), [unix(b.old)]);
  assert.equal(readFileSync(b.failed, 'utf8').trim(), '1.0.0');
});

test('helper: nothing moves while the process lives; the swap follows its end', { skip: !sh }, () => {
  const b = swapBench({ same: true });
  // The waiting process is a child of this shell, so `kill -0` sees it. The log proves the order.
  const log = unix(path.join(b.parent, 'order'));
  const script = `(sleep 1; echo "ended $(cat "$OLD/which")" >> "${log}") & pid=$!\nPATH="${shPath(b.bin)}:$PATH"; export PATH\nsh -c "$SCRIPT" helper "$pid" "$OLD" "$STAGED" "$TARGET" "$PREVIOUS" "$FAILED" 1.0.0`;
  const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, SCRIPT: SWAP_SCRIPT, OLD: unix(b.old), STAGED: unix(b.staged), TARGET: unix(b.old), PREVIOUS: unix(b.previous), FAILED: unix(b.failed) } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, 'utf8').trim(), 'ended old', 'the old app was still in place when the process ended');
  assert.equal(b.which(b.old), 'new');
});

test('the helper is plain POSIX sh: no bash forms', () => {
  assert.doesNotMatch(SWAP_SCRIPT, /\[\[|\bfunction\b|\$\{[^}]*[:/]|<<<|&>/);
});

// ---------------------------------------------------------------- settling

function settleBench(boot: unknown) {
  const parent = fresh('settle');
  const bundle = path.join(parent, 'Autark.app');
  mkdirSync(bundle);
  const dataDir = fresh('data');
  const cacheDir = fresh('cache');
  if (boot) writeFileSync(path.join(dataDir, 'boot.json'), JSON.stringify(boot));
  const trashed: string[] = [];
  const ids: Record<string, string> = { [bundle]: 'com.teydralab.workforce' };
  const previous = path.join(parent, PREVIOUS_BUNDLE);
  mkdirSync(previous);
  const deps = {
    bundle, version: '1.1.0', dataDir, cacheDir, leftovers: [] as string[],
    bundleId: async (target: string) => ids[target] ?? null,
    trash: async (target: string) => { trashed.push(target); },
  };
  return { parent, bundle, dataDir, cacheDir, deps, trashed, ids, previous };
}

test('before this version ran stable nothing is touched', async () => {
  for (const boot of [null, { phase: 'up', version: '1.1.0' }, { phase: 'stable', version: '1.0.0' }]) {
    const b = settleBench(boot);
    await settleMacUpdate(b.deps);
    assert.deepEqual(b.trashed, []);
  }
});

test('once stable: the previous bundle and an old-named leftover of the same app go to the trash, others stay', async () => {
  const b = settleBench({ phase: 'stable', version: '1.1.0' });
  const leftover = path.join(b.parent, 'Old Name.app');
  const foreign = path.join(b.parent, 'Foreign.app');
  mkdirSync(leftover);
  mkdirSync(foreign);
  b.ids[leftover] = 'com.teydralab.workforce';
  b.ids[foreign] = 'com.someone.else';
  await settleMacUpdate({ ...b.deps, leftovers: [leftover, foreign, b.bundle, path.join(b.parent, 'Absent.app')] });
  assert.deepEqual(b.trashed, [b.previous, leftover]);
});

test('a failure note of an older version goes, the one of this version stays; a refused trash does not throw', async () => {
  const b = settleBench({ phase: 'stable', version: '1.1.0' });
  writeFileSync(path.join(b.cacheDir, FAILED_FILE), '1.0.0\n');
  await settleMacUpdate({ ...b.deps, trash: async () => { throw new Error('no trash'); } });
  assert.ok(!existsSync(path.join(b.cacheDir, FAILED_FILE)));
  const same = settleBench({ phase: 'stable', version: '1.1.0' });
  writeFileSync(path.join(same.cacheDir, FAILED_FILE), '1.1.0\n');
  await settleMacUpdate(same.deps);
  assert.ok(existsSync(path.join(same.cacheDir, FAILED_FILE)));
});
