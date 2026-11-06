// The product's rename on this PC: the data folder moves ONCE from the old product name to the new one, so a person
// keeps everything and no second folder grows. One atomic rename of the whole folder, never a copy and no merge.
// While the old app still runs or the rename fails, this start simply uses the old folder and the next start tries
// again; nothing is ever half moved. With another product name, in development and in test mode it does nothing.
// macOS and Linux derive the key that protects secrets and cookies from the app's name (Keychain item, keyring entry),
// so the old name stays the "keyring name" for data that came from the old app: the marker <data>/keyring-name carries
// it, index.ts calls this before anything reads safeStorage, and the real name returns at `ready` (Electron has read
// the keyring name by then), so window titles and menus show the new name. A fresh install has no marker. Windows keeps
// its key in `Local State` inside the folder, which moves along.
// After a move <data>/identity-move-pending stays until finishIdentityMove removed the old updater cache and the old
// launcher entries, a while after the start (the installer that started this app may still hold its cache file).
// A pid from the old folder counts only while it is one of this product's own processes, old name or new: runtime.json
// stays after a quit and Windows soon hands its pid to another process, which would hold every start for the wait.
// Owns: which data folder this start uses, the two marker files, the move. Never: imports electron at runtime, copies
// or merges data, runs long once the app is moved (a plain start reads two paths).

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OLD_PRODUCT_NAME = 'Proactive Agent Workforce';
export const NEW_PRODUCT_NAME = 'Autark';
export const OLD_UPDATER_CACHE = 'proactive-agent-workforce-updater'; // package.json name + "-updater" (app-update.yml)
export const KEYRING_MARKER = 'keyring-name';
export const PENDING_MARKER = 'identity-move-pending';
const DATABASE = 'workforce.db';
export const OLD_APP_WAIT_MS = 20_000; // an old app that is just quitting (the Linux updater starts the new one while it ends)
const POLL_MS = 250;
const RENAME_TRIES = 8; // Windows: a scanner or an ending child holds a file for a moment (2 s at most, per start)

export type IdentityOutcome =
  | 'unchanged' // not the renamed product, development, test data or a custom data folder
  | 'fresh' // nothing of the old app here
  | 'kept-new' // the new folder already has a database: it wins, nothing is merged
  | 'moved'
  | 'old-running' // this start uses the old folder
  | 'move-failed'; // this start uses the old folder

export interface IdentityDecision {
  outcome: IdentityOutcome;
  dataDir: string;
  /** The name for the keyring until `ready`, when it differs from the product name. */
  keyringName: string | null;
  detail?: string;
}

export interface IdentityDeps {
  platform: string;
  productName: string;
  packaged: boolean;
  testData: boolean;
  appData: string; // app.getPath('appData')
  userData: string; // app.getPath('userData')
  alive(pid: number): boolean;
  rename?(from: string, to: string): void;
  writeMarker?(file: string, text: string): void;
  now?(): number;
  sleep?(ms: number): void;
  bootAt?(): number;
}

/** process.kill(pid, 0): ESRCH = gone; EPERM = exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The executable a pid runs: a path or a file name; null when no such process; undefined when it cannot be told. */
export function processImage(pid: number, platform: string = process.platform): string | null | undefined {
  try {
    if (platform === 'linux') return readlinkSync(`/proc/${pid}/exe`);
    if (platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const row = /^"([^"]+)","(\d+)"/m.exec(out);
      return row && Number(row[2]) === pid ? row[1] : null; // no row: a localized "no tasks" line
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 }).trim() || null;
  } catch (error) {
    const { code, status } = error as NodeJS.ErrnoException & { status?: number };
    if (platform === 'linux') return code === 'ENOENT' ? null : undefined; // EACCES: Chromium's undumpable children
    return platform !== 'win32' && status === 1 ? null : undefined; // ps: no such process
  }
}

// Old and new: main and the runtime (a utility process of the same executable), macOS's "<name> Helper …" too.
const APP_IMAGES = [OLD_PRODUCT_NAME, NEW_PRODUCT_NAME, 'proactive-agent-workforce', 'autark'].map(name => name.toLowerCase());

/** Whether an image is one of this product's executables; one that cannot be told counts (the old wait stays). */
export function isAppImage(image: string | null | undefined): boolean {
  if (image === undefined) return true;
  if (!image) return false;
  const base = (image.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
  return APP_IMAGES.some(name => base === name || base.startsWith(`${name} helper`));
}

/** deps.alive of a real start: a live process of this product other than this one; each pid's image is read once. */
export function appProcessAlive(image: (pid: number) => string | null | undefined = processImage, self = process.pid): (pid: number) => boolean {
  const ours = new Map<number, boolean>();
  return (pid) => {
    if (pid === self || !processAlive(pid)) return false;
    if (!ours.has(pid)) ours.set(pid, isAppImage(image(pid)));
    return ours.get(pid)!;
  };
}

const isDir = (dir: string) => { try { return statSync(dir).isDirectory(); } catch { return false; } };
const errorCode = (error: unknown) => String((error as NodeJS.ErrnoException)?.code ?? 'error');

/** Blocks this thread (main before `ready`, nothing else runs yet); where that is refused the loop just polls the clock. */
function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* the caller's clock still ends it */ }
}

/**
 * The processes of an app on `dir`: the runtime's pid from runtime.json (the file stays after a quit, so one from before
 * the last boot is ignored: that pid may be anybody's now) and main's from Chromium's SingletonLock link on macOS and
 * Linux (host-pid), where a rename would otherwise succeed under a running app.
 */
export function appPids(dir: string, bootAt: number): number[] {
  const pids: number[] = [];
  try {
    const value = JSON.parse(readFileSync(path.join(dir, 'runtime.json'), 'utf8')) as { pid?: unknown; at?: unknown };
    const at = typeof value.at === 'string' ? Date.parse(value.at) : NaN;
    if (Number.isInteger(value.pid) && (value.pid as number) > 0 && !(at < bootAt)) pids.push(value.pid as number);
  } catch { /* no file, no app */ }
  try {
    const pid = Number(/-(\d+)$/.exec(readlinkSync(path.join(dir, 'SingletonLock')))?.[1]);
    if (pid > 0) pids.push(pid);
  } catch { /* no link: no app, or Windows */ }
  return pids;
}

/** Decides and moves. Synchronous: it runs before the single-instance lock, which lives in the chosen folder. */
export function decideIdentity(deps: IdentityDeps): IdentityDecision {
  const unchanged: IdentityDecision = { outcome: 'unchanged', dataDir: deps.userData, keyringName: null };
  if (deps.productName !== NEW_PRODUCT_NAME || !deps.packaged || deps.testData) return unchanged;
  const next = path.join(deps.appData, NEW_PRODUCT_NAME);
  if (path.resolve(deps.userData) !== path.resolve(next)) return unchanged; // --user-data-dir: not this product's folder
  const posix = deps.platform !== 'win32';
  const onNew = (outcome: IdentityOutcome, detail?: string): IdentityDecision => ({ outcome, dataDir: next, keyringName: posix ? readMarker(next) : null, detail });

  const old = path.join(deps.appData, OLD_PRODUCT_NAME);
  if (!isDir(old)) return onNew('fresh');
  if (existsSync(path.join(next, DATABASE))) return onNew('kept-new', existsSync(path.join(old, DATABASE)) ? 'both folders have a database; the old one stays untouched' : undefined);
  const onOld = (outcome: IdentityOutcome, detail?: string): IdentityDecision => ({ outcome, dataDir: old, keyringName: posix ? OLD_PRODUCT_NAME : null, detail });

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepSync;
  const bootAt = deps.bootAt?.() ?? Date.now() - os.uptime() * 1000;
  const deadline = now() + OLD_APP_WAIT_MS;
  for (;;) {
    const running = appPids(old, bootAt).filter(deps.alive);
    if (!running.length) break;
    if (now() >= deadline) return onOld('old-running', `pid ${running.join(', ')}`);
    sleep(POLL_MS);
  }

  // The marker travels inside the folder, so there is never a moved folder without it. Without it, no move.
  if (posix) {
    try { (deps.writeMarker ?? writeFileSync)(path.join(old, KEYRING_MARKER), `${OLD_PRODUCT_NAME}\n`); } catch (error) { return onOld('move-failed', `marker ${errorCode(error)}`); }
  }
  const rename = deps.rename ?? renameSync;
  const aside = isDir(next) ? `${next}.before-move-${now()}` : null; // Electron's empty start of a folder, never a database
  try {
    if (aside) rename(next, aside);
  } catch (error) {
    return onOld('move-failed', `new folder ${errorCode(error)}`);
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(old, next);
      break;
    } catch (error) {
      const code = errorCode(error);
      if (deps.platform === 'win32' && attempt < RENAME_TRIES && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) { sleep(POLL_MS); continue; }
      if (aside) { try { rename(aside, next); } catch { /* holds no database: the next start moves it aside again */ } }
      return onOld('move-failed', code);
    }
  }
  try { writeFileSync(path.join(next, PENDING_MARKER), ''); } catch { /* only leftovers stay: an old cache, old launcher entries */ }
  if (aside) { try { rmSync(aside, { recursive: true, force: true }); } catch { /* only Electron's start of a folder stays */ } }
  return onNew('moved');
}

/** The keyring name a moved folder carries; null when it has none or the file is not one line of a name. */
export function readMarker(dir: string): string | null {
  try {
    const name = readFileSync(path.join(dir, KEYRING_MARKER), 'utf8').trim();
    return name && name.length <= 128 && !/[\r\n]/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** The part of Electron's app this needs. */
export interface IdentityApp {
  isPackaged: boolean;
  getName(): string;
  setName(name: string): void;
  getPath(name: 'appData' | 'userData'): string;
  setPath(name: 'userData', value: string): void;
  whenReady(): Promise<unknown>;
}

/**
 * The top of main/index.ts. app.setName can change the default userData, so the folder is always set after it. The name
 * returns at `ready`: this handler is registered first and runs before the app's own start.
 */
export function applyIdentity(app: IdentityApp, input: { testData: boolean; overrides?: Partial<IdentityDeps> }): IdentityDecision {
  const productName = app.getName();
  const decision = decideIdentity({
    platform: process.platform,
    productName,
    packaged: app.isPackaged,
    testData: input.testData,
    appData: app.getPath('appData'),
    userData: app.getPath('userData'),
    alive: appProcessAlive(),
    ...input.overrides,
  });
  if (decision.outcome === 'unchanged') return decision;
  if (decision.keyringName && decision.keyringName !== productName) {
    app.setName(decision.keyringName);
    void app.whenReady().then(() => app.setName(productName));
  }
  app.setPath('userData', decision.dataDir);
  if (decision.outcome !== 'fresh') note(decision);
  return decision;
}

/** One line per noteworthy start, for whoever checks the move afterwards (main's own log opens later). */
function note(decision: IdentityDecision): void {
  try {
    const dir = path.join(decision.dataDir, 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'identity-move.log'), `${new Date().toISOString()} ${decision.outcome}${decision.detail ? ` (${decision.detail})` : ''}\n`);
  } catch { /* a note only */ }
}

/** electron-updater's cache root (AppAdapter.getAppCacheDir) on each system. */
export function updaterCacheRoot(platform: string, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') return env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches');
  return env.XDG_CACHE_HOME || path.join(home, '.cache');
}

export interface FinishDeps {
  dataDir: string;
  cacheRoot: string;
  removeOldLauncher(): Promise<void>;
  log?(line: string): void;
}

/** The once-after-a-move part. The marker goes when both are done, so a busy cache is tried again at the next start. */
export async function finishIdentityMove(deps: FinishDeps): Promise<void> {
  const marker = path.join(deps.dataDir, PENDING_MARKER);
  if (!existsSync(marker)) return;
  try {
    rmSync(path.join(deps.cacheRoot, OLD_UPDATER_CACHE), { recursive: true, force: true });
    await deps.removeOldLauncher();
    rmSync(marker, { force: true });
    deps.log?.('identity move finished: old updater cache and launcher entries removed');
  } catch (error) {
    deps.log?.(`identity move not finished yet: ${errorCode(error)}`);
  }
}
