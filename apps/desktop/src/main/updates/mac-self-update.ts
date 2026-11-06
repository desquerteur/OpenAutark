// A Mac updates itself without forcing a new download. The build is ad hoc signed, and Squirrel.Mac (electron-updater's
// way) only accepts an update that satisfies the running app's signature, which is bound to one version; so the zip of
// the same feed comes here instead: download, sha512 from the feed, unpack beside the app, signature and bundle id and
// version of the unpacked app, then after the drain a detached helper waits for this process to end, swaps the bundles,
// restores the old one if the swap fails, and starts the result. electron-updater still does the feed check.
// Where it cannot work (macCapability: read-only place, a translocated app, a disk image, or it failed for this version
// before) the plain updater stays and with it the manual download; a failure here says so at once ('manual-only').
// Once the new version ran stable, settleMacUpdate trashes the previous bundle and an old-named leftover.
// Owns: the capability check, the download and staging, the helper script, the settling. Never: imports electron
// (updates-wiring.ts injects it), drains or decides when to restart (update-service.ts), or swaps while this process lives.

import { createHash } from 'node:crypto';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Updater } from './update-service.ts';

export const STAGING_DIR = '.workforce-update'; // beside the app, so the final move is one rename on one volume
export const PREVIOUS_BUNDLE = '.workforce-previous'; // no .app ending: not offered as an app while it waits
export const FAILED_FILE = 'self-update-failed'; // in the cache folder: the version whose self-update failed
const UNPACK_TIMEOUT_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 3 * 60_000;
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';

type Run = (command: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `<x>.app` of `<x>.app/Contents/MacOS/<binary>`; null when this does not run from a bundle. */
export function appBundleOf(executable: string): string | null {
  const bundle = path.dirname(path.dirname(path.dirname(executable)));
  return bundle.endsWith('.app') ? bundle : null;
}

const canWrite = (target: string) => { try { accessSync(target, constants.W_OK); return true; } catch { return false; } };

/** Why this app cannot replace itself; null when it can. */
export function macCapability(input: { bundle: string | null; version: string; failedVersion: string | null; writable?(target: string): boolean }): string | null {
  const { bundle } = input;
  if (!bundle) return 'not an app bundle';
  if (bundle.includes('/AppTranslocation/')) return 'translocated';
  if (bundle.startsWith('/Volumes/')) return 'on a mounted volume';
  const writable = input.writable ?? canWrite;
  if (!writable(path.dirname(bundle)) || !writable(bundle)) return 'folder not writable';
  if (input.failedVersion === input.version) return 'failed before for this version';
  return null;
}

/**
 * The helper, run as `sh -c SWAP_SCRIPT name pid old staged new previous failed version`: positional arguments, so a
 * path needs no quoting. It keeps the staged app when the process never ends (a later try can use it). A swap that
 * fails puts the old app back, notes the version for the manual path and starts the old app.
 */
export const SWAP_SCRIPT = `pid=$1; old=$2; staged=$3; new=$4; previous=$5; failed=$6; version=$7
staging=$(dirname "$staged")
tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 600 ]; then exit 3; fi
  sleep 0.5
done
rm -rf "$previous"
if ! mv "$old" "$previous"; then
  printf '%s\\n' "$version" > "$failed"
  rm -rf "$staging"
  open "$old"
  exit 1
fi
if mv "$staged" "$new"; then
  rm -rf "$staging"
  open "$new"
  exit 0
fi
printf '%s\\n' "$version" > "$failed"
if mv "$previous" "$old"; then rm -rf "$staging"; fi
open "$old"
exit 1
`;

export interface FeedFile { url: string; sha512?: string; size?: number }

/** The zip for this architecture among the feed's files (today one universal zip). */
export function pickZip(files: readonly FeedFile[], arch: string): FeedFile | null {
  const zips = files.filter(file => file.url.toLowerCase().endsWith('.zip'));
  const other = arch === 'arm64' ? 'x64' : 'arm64';
  const fitting = zips.filter(file => !file.url.includes(other));
  return fitting.find(file => file.url.includes(arch)) ?? fitting[0] ?? null;
}

export interface MacSelfUpdateDeps {
  bundle: string;
  version: string;
  pid: number;
  arch: string;
  cacheDir: string;
  /** The feed's file as a full address (the provider knows the repository and tag). */
  resolveUrl(file: FeedFile, info: unknown): string;
  fetch(url: string): Promise<Pick<Response, 'ok' | 'status' | 'body' | 'headers'>>;
  run: Run;
  spawnHelper(args: string[], onError: (error: Error) => void): void;
  quit(): void;
  log?(line: string): void;
}

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

export class MacSelfUpdater implements Updater {
  readonly installsItself = true;
  private readonly inner: Updater;
  private readonly deps: MacSelfUpdateDeps;
  private readonly listeners = new Map<string, (value: unknown) => void>();
  private info: { version?: string; files?: FeedFile[] } | null = null;
  private staged: string | null = null;
  private stagedVersion: string | null = null;
  private helperRunning = false;

  constructor(inner: Updater, deps: MacSelfUpdateDeps) {
    this.inner = inner;
    this.deps = deps;
  }

  // The service's settings belong on the real updater: its own default would start a Squirrel download.
  get autoDownload(): boolean { return this.inner.autoDownload; }
  set autoDownload(value: boolean) { this.inner.autoDownload = value; }
  get autoInstallOnAppQuit(): boolean { return this.inner.autoInstallOnAppQuit; }
  set autoInstallOnAppQuit(value: boolean) { this.inner.autoInstallOnAppQuit = value; }
  get allowPrerelease(): boolean { return this.inner.allowPrerelease; }
  set allowPrerelease(value: boolean) { this.inner.allowPrerelease = value; }
  get allowDowngrade(): boolean { return this.inner.allowDowngrade; }
  set allowDowngrade(value: boolean) { this.inner.allowDowngrade = value; }
  get logger(): unknown { return this.inner.logger; }
  set logger(value: unknown) { this.inner.logger = value; }

  on(event: string, listener: (value: unknown) => void): unknown {
    this.listeners.set(event, listener);
    if (event !== 'update-available') return this.inner.on(event, listener);
    return this.inner.on(event, value => { this.info = value as typeof this.info; listener(value); });
  }

  checkForUpdates(): Promise<unknown> { return this.inner.checkForUpdates(); }

  async downloadUpdate(): Promise<unknown> {
    try {
      if (!this.staged || this.stagedVersion !== this.info?.version || !existsSync(this.staged)) {
        const { file, url } = this.feedZip();
        await this.stage(await this.download(url, file));
      }
      this.emit('update-downloaded', { version: this.info?.version });
      return null;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  quitAndInstall(): void {
    if (this.helperRunning) { this.deps.quit(); return; } // it already waits for this process
    if (!this.staged || !existsSync(this.staged)) {
      this.emit('error', failure('ERR_STAGED_UPDATE_GONE', 'The unpacked update is gone.'));
      return;
    }
    const parent = path.dirname(this.deps.bundle);
    const wanted = path.join(parent, path.basename(this.staged));
    // A copy under the new name already there (installed by hand): keep this place, the swap never moves into a bundle.
    const target = wanted !== this.deps.bundle && existsSync(wanted) ? this.deps.bundle : wanted;
    try {
      this.helperRunning = true;
      this.deps.spawnHelper(
        ['-c', SWAP_SCRIPT, 'workforce-update', String(this.deps.pid), this.deps.bundle, this.staged, target, path.join(parent, PREVIOUS_BUNDLE), path.join(this.deps.cacheDir, FAILED_FILE), this.deps.version],
        error => { this.helperRunning = false; this.emit('error', error); },
      );
    } catch (error) {
      this.helperRunning = false;
      this.emit('error', error);
      return;
    }
    this.deps.quit();
  }

  private emit(event: string, value?: unknown): void { this.listeners.get(event)?.(value); }

  private feedZip(): { file: FeedFile; url: string } {
    const info = this.info;
    const file = pickZip(info?.files ?? [], this.deps.arch);
    if (!info || !file) throw failure('ERR_UPDATER_ZIP_FILE_NOT_FOUND', 'The feed has no zip for this Mac.');
    if (!file.sha512) throw failure('ERR_UPDATER_NO_CHECKSUM', 'The feed has no checksum for the zip.');
    const url = this.deps.resolveUrl(file, info);
    if (!url.startsWith('https://')) throw failure('ERR_UPDATER_NOT_HTTPS', 'The update address is not https.');
    return { file, url };
  }

  private async download(url: string, file: FeedFile): Promise<string> {
    mkdirSync(this.deps.cacheDir, { recursive: true });
    const target = path.join(this.deps.cacheDir, 'update.zip');
    const response = await this.deps.fetch(url);
    if (!response.ok || !response.body) throw failure('ERR_UPDATER_DOWNLOAD', `Download failed (${response.status}).`);
    const total = Number(response.headers.get('content-length')) || file.size || 0;
    const hash = createHash('sha512');
    let received = 0;
    let shown = -1;
    const reader = response.body.getReader();
    const report = (percent: number) => { if (percent !== shown) { shown = percent; this.emit('download-progress', { percent, transferred: received, total }); } };
    const measured = async function* () {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        hash.update(value);
        received += value.length;
        report(total ? Math.floor(received / total * 100) : 0);
        yield value;
      }
    };
    await pipeline(measured(), createWriteStream(target));
    if (hash.digest('base64') !== file.sha512) {
      rmSync(target, { force: true });
      throw failure('ERR_UPDATER_SHA512', 'The download does not match the checksum of the feed.');
    }
    return target;
  }

  /** Unpacks and checks. The bytes were fine, so a failure here would repeat: the next click and the next start take the manual path. */
  private async stage(zip: string): Promise<void> {
    const staging = path.join(path.dirname(this.deps.bundle), STAGING_DIR);
    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      await this.must('unpack', 'ditto', ['-x', '-k', zip, staging], UNPACK_TIMEOUT_MS);
      const apps = readdirSync(staging).filter(name => name.endsWith('.app'));
      if (apps.length !== 1) throw failure('ERR_UPDATE_BUNDLE', 'The zip does not hold one app.');
      const app = path.join(staging, apps[0]);
      await this.must('signature', 'codesign', ['--verify', '--deep', '--strict', app], VERIFY_TIMEOUT_MS);
      const [id, own, version] = await Promise.all([this.plist(app, 'CFBundleIdentifier'), this.plist(this.deps.bundle, 'CFBundleIdentifier'), this.plist(app, 'CFBundleShortVersionString')]);
      if (id !== own) throw failure('ERR_UPDATE_BUNDLE_ID', 'The update is another application.');
      if (version !== this.info?.version) throw failure('ERR_UPDATE_VERSION', 'The update is not the announced version.');
      // Written by this process it should carry no quarantine flag; if it did, an ad hoc app would not open after the
      // swap. Only the copy checked above, and the person already chose this app when they first opened it.
      await this.deps.run('xattr', ['-dr', 'com.apple.quarantine', app], VERIFY_TIMEOUT_MS);
      this.staged = app;
      this.stagedVersion = version;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      try { writeFileSync(path.join(this.deps.cacheDir, FAILED_FILE), `${this.deps.version}\n`); } catch { /* this process knows it too */ }
      this.emit('manual-only');
      throw error;
    } finally {
      rmSync(zip, { force: true });
    }
  }

  private async must(step: string, command: string, args: string[], timeoutMs: number): Promise<void> {
    const result = await this.deps.run(command, args, timeoutMs);
    if (result.code !== 0) throw failure('ERR_UPDATE_VERIFY', `${step} failed: ${result.stderr.trim().slice(0, 200)}`);
  }

  private async plist(bundle: string, key: string): Promise<string> {
    const result = await this.deps.run(PLIST_BUDDY, ['-c', `Print :${key}`, path.join(bundle, 'Contents', 'Info.plist')], VERIFY_TIMEOUT_MS);
    if (result.code !== 0) throw failure('ERR_UPDATE_VERIFY', `${key} not readable.`);
    return result.stdout.trim();
  }
}

/** The version noted by a failed self-update; null without one. */
export function readFailedVersion(cacheDir: string): string | null {
  try { return readFileSync(path.join(cacheDir, FAILED_FILE), 'utf8').trim() || null; } catch { return null; }
}

/** The wrapper where it can work; otherwise null and the plain updater stays (manual download). */
export function macSelfUpdater(inner: Updater, deps: MacSelfUpdateDeps): MacSelfUpdater | null {
  const why = macCapability({ bundle: deps.bundle, version: deps.version, failedVersion: readFailedVersion(deps.cacheDir) });
  if (why) { deps.log?.(`mac self-update off: ${why}`); return null; }
  return new MacSelfUpdater(inner, deps);
}

export interface SettleDeps {
  bundle: string | null;
  version: string;
  dataDir: string; // boot.json: the runtime's own record of a good start
  cacheDir: string;
  /** Bundles under an older product name that may remain beside this one. */
  leftovers: readonly string[];
  bundleId(bundle: string): Promise<string | null>;
  trash(target: string): Promise<void>;
  log?(line: string): void;
}

/** Runs a while after a start. Nothing happens until this version reached 'stable'; a later start tries again. */
export async function settleMacUpdate(deps: SettleDeps): Promise<void> {
  if (!deps.bundle) return;
  let boot: { phase?: unknown; version?: unknown } = {};
  try { boot = JSON.parse(readFileSync(path.join(deps.dataDir, 'boot.json'), 'utf8')) as typeof boot; } catch { return; }
  if (boot.phase !== 'stable' || boot.version !== deps.version) return;
  const failed = readFailedVersion(deps.cacheDir);
  if (failed && failed !== deps.version) rmSync(path.join(deps.cacheDir, FAILED_FILE), { force: true }); // a new version gets a new try
  const own = await deps.bundleId(deps.bundle);
  const targets = [path.join(path.dirname(deps.bundle), PREVIOUS_BUNDLE)];
  for (const leftover of deps.leftovers) {
    if (leftover !== deps.bundle && existsSync(leftover) && own && await deps.bundleId(leftover) === own) targets.push(leftover);
  }
  for (const target of targets) {
    if (!existsSync(target)) continue;
    try {
      await deps.trash(target);
      deps.log?.(`mac update settled: moved ${path.basename(target)} to the trash`);
    } catch (error) {
      deps.log?.(`mac update not settled: ${(error as Error)?.message ?? 'error'}`);
    }
  }
}
