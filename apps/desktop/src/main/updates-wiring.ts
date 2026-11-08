// Wires UpdateService (src/main/updates) to the desktop: restart-gate facts, the drain before
// quitAndInstall and its undo, the auto-download preference, the browser opener for the manual
// download (macOS) and state publication. From the rename release on, macOS wraps the updater with
// mac-self-update.ts where that can work; from B-078 on, Windows and Linux install through their own
// relaunch helper (updates/install-helper.ts); a while after a start settleAfterStart tidies up after a move
// or a Mac self-update.
// Drain order: renderer saves drafts (prepareRestart ack) → runtime pauses wakes and checkpoints
// (system.prepareRestart) → runtime exits ('update').
// Owns: that order and the "drained" flag, binding electron to the updater wrapper. Never: talks to
// electron-updater's download or install directly (the Updater is injected) or relaunches without the drain.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { UpdateState } from '../shared/model/system.ts';
import { WorkforceError } from '../shared/errors.ts';
import { NEW_PRODUCT_NAME, OLD_PRODUCT_NAME, finishIdentityMove, updaterCacheRoot } from './identity-move.ts';
import { applyLauncher, runCommand, type LauncherDeps } from './launcher-tasks.ts';
import { windowsTaskName } from './launcher-windows.ts';
import { appBundleOf, macSelfUpdater, settleMacUpdate, type FeedFile } from './updates/mac-self-update.ts';
import { UpdateService } from './updates/update-service.ts';
import type { Updater } from './updates/update-service.ts';
import { allowInstallerRetry } from './updates/install-retry.ts';
import { HELPER_LOG, installWithHelper, spawnHelper } from './updates/install-helper.ts';
import type { UpdateSource } from './updates/source.ts';

export interface DesktopUpdatesDeps {
  updater: Updater;
  packaged: boolean;
  enabled: boolean; // false in test mode: never contacts GitHub
  platform: string;
  arch: string;
  version: string;
  autoDownload(): boolean;
  setAutoDownload(enabled: boolean): Promise<void>; // settings.update via the runtime
  renderer: { readonly rendererReady: boolean; prepareRestart(timeoutMs: number): Promise<boolean> };
  idleSeconds(): number;
  runtime: {
    readiness(): Promise<{ ready: boolean }>;
    prepareRestart(cancel: boolean): Promise<void>;
    stop(reason: 'update'): Promise<void>;
    start(): void;
  };
  publish(state: UpdateState): void;
  /** AF-019: the stored update source (updates/source-store.ts) and how a change is saved. */
  source?: UpdateSource;
  saveSource?(source: UpdateSource): Promise<void>;
  /** The system browser for the manual download (desktop.ts passes electron's shell; default: loaded on first use). Only https reaches it. */
  openExternal?(url: string): Promise<void>;
  log?(line: string): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const DRAFT_FLUSH_TIMEOUT_MS = 8000;

/**
 * electron-updater's autoUpdater (loaded only for packaged builds). Its export is a getter that
 * Node's CJS export detection misses, so read it from the namespace or the default export.
 */
export async function loadUpdater(log?: (line: string) => void): Promise<Updater> {
  const loaded = await import('electron-updater') as unknown as { autoUpdater?: Updater; default?: { autoUpdater?: Updater } };
  const updater = loaded.autoUpdater ?? loaded.default?.autoUpdater;
  if (!updater) throw new Error('The updater is not available.');
  if (process.platform === 'win32') allowInstallerRetry(updater);
  if (process.platform === 'darwin') return selfUpdatingMac(updater, log);
  if (process.platform === 'win32' || process.platform === 'linux') await relaunchingHelper(updater, log);
  return updater;
}

/** Windows and Linux: quitAndInstall starts the relaunch helper and quits; without it the library's own way runs. */
async function relaunchingHelper(updater: Updater, log?: (line: string) => void): Promise<void> {
  const { app } = await electronMain();
  const logs = path.join(app.getPath('userData'), 'logs');
  installWithHelper(updater, {
    platform: process.platform,
    pid: process.pid,
    exe: process.execPath,
    appImage: process.env.APPIMAGE,
    logFile: path.join(logs, HELPER_LOG),
    spawn: (launch, events) => spawnHelper(launch, logs, events),
    quit: () => app.quit(),
    log,
  });
}

/** What this needs of electron's main module (its exports sit on the namespace or the default export, as for shell below). */
interface ElectronMain {
  app: { getName(): string; getVersion(): string; getPath(name: 'userData'): string; quit(): void };
  net: { fetch(url: string): Promise<Response> };
  shell: { trashItem(target: string): Promise<void> };
}

async function electronMain(): Promise<ElectronMain> {
  const loaded = await import('electron') as unknown as Partial<ElectronMain> & { default?: Partial<ElectronMain> };
  return (loaded.app ? loaded : loaded.default) as ElectronMain;
}

/** The feed's file as a full address, as MacUpdater gets it: the library's provider knows the repository and the tag. */
export function feedFileUrl(updater: Updater, file: FeedFile, info: unknown): string {
  const { provider } = (updater as unknown as { updateInfoAndProvider?: { provider?: { resolveFiles(info: unknown): Array<{ url: URL; info: FeedFile }> } } }).updateInfoAndProvider ?? {};
  const match = provider?.resolveFiles(info).find(item => item.info.url === file.url);
  if (!match) throw new Error('The update address is not known.');
  return match.url.href;
}

const macCacheDir = () => path.join(os.homedir(), 'Library', 'Caches', 'workforce-self-update');

async function selfUpdatingMac(updater: Updater, log?: (line: string) => void): Promise<Updater> {
  const bundle = appBundleOf(process.execPath);
  if (!bundle) return updater;
  const { app, net } = await electronMain();
  if (app.getName() !== NEW_PRODUCT_NAME) return updater; // inert until the rename ships: the manual download stays until then
  return macSelfUpdater(updater, {
    bundle,
    version: app.getVersion(),
    pid: process.pid,
    arch: process.arch,
    cacheDir: macCacheDir(),
    resolveUrl: (file, info) => feedFileUrl(updater, file, info),
    fetch: url => net.fetch(url),
    run: runCommand,
    spawnHelper: (args, onError) => {
      const child = spawn('/bin/sh', args, { detached: true, stdio: 'ignore', cwd: path.dirname(bundle) });
      child.on('error', onError);
      child.unref();
    },
    quit: () => app.quit(),
    log,
  }) ?? updater;
}

export const SETTLE_AFTER_START_MS = 90_000; // after the runtime's STABLE_MS (repair/journal.ts) and the installer's own end

/** Linux timers and autostart under the old name would fire beside the new ones; macOS keeps one label; Windows' old task goes by name. */
export async function removeOldLauncher(deps: LauncherDeps): Promise<void> {
  if (deps.platform === 'win32') await deps.run('schtasks', ['/Delete', '/TN', windowsTaskName(OLD_PRODUCT_NAME, deps.user), '/F']);
  if (deps.platform === 'linux') await applyLauncher(false, { ...deps, name: OLD_PRODUCT_NAME });
}

/** Tidies up what a move of the product's identity or a Mac self-update left behind, once this start proved itself. */
export function settleAfterStart(deps: { dataDir: string; version: string; launcher: LauncherDeps; log(line: string): void }): void {
  const { platform, packaged, testMode } = deps.launcher;
  if (!packaged || testMode) return;
  setTimeout(() => {
    const finish = async () => {
      await finishIdentityMove({
        dataDir: deps.dataDir,
        cacheRoot: updaterCacheRoot(platform, process.env, os.homedir()),
        removeOldLauncher: () => removeOldLauncher(deps.launcher),
        log: deps.log,
      });
      if (platform !== 'darwin') return;
      const { shell } = await electronMain();
      const bundle = appBundleOf(process.execPath);
      const name = `${OLD_PRODUCT_NAME}.app`;
      await settleMacUpdate({
        bundle,
        version: deps.version,
        dataDir: deps.dataDir,
        cacheDir: macCacheDir(),
        leftovers: bundle && path.basename(bundle) !== name ? [path.join(path.dirname(bundle), name), path.join('/Applications', name), path.join(os.homedir(), 'Applications', name)] : [],
        bundleId: async target => {
          const result = await runCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(target, 'Contents', 'Info.plist')]);
          return result.code === 0 ? result.stdout.trim() : null;
        },
        trash: target => shell.trashItem(target),
        log: deps.log,
      });
    };
    void finish().catch((error: unknown) => deps.log(`settling after start failed: ${(error as Error)?.message ?? 'error'}`));
  }, SETTLE_AFTER_START_MS).unref();
}

/** Opens an https address with `open` – the manual download is never anything else, whatever opener is injected. */
export async function openHttps(url: string, open: (url: string) => Promise<void> = shellOpenExternal): Promise<void> {
  if (!/^https:\/\//i.test(url)) throw new Error('Only https download links are opened.');
  await open(url);
}

/** Opens an address in the system browser through electron's shell (loaded on first use; openHttps checks it). */
async function shellOpenExternal(url: string): Promise<void> {
  const loaded = await import('electron') as unknown as { shell?: { openExternal(url: string): Promise<void> }; default?: { shell?: { openExternal(url: string): Promise<void> } } };
  const shell = loaded.shell ?? loaded.default?.shell;
  if (!shell) throw new Error('The browser could not be opened.');
  await shell.openExternal(url);
}

/** A stand-in for electron-updater in development and test mode (UpdateService never calls it). */
export function inactiveUpdater(): Updater {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    logger: null,
    on: () => undefined,
    checkForUpdates: () => Promise.resolve(null),
    downloadUpdate: () => Promise.resolve(null),
    quitAndInstall: () => undefined,
  };
}

export class DesktopUpdates {
  readonly service: UpdateService;
  private readonly deps: DesktopUpdatesDeps;
  private drained = false; // runtime already stopped for the installer
  private paused = false; // runtime paused by system.prepareRestart
  private updateQuitPending = false; // native before-quit-for-update precedes the library's queued app.quit

  constructor(deps: DesktopUpdatesDeps) {
    this.deps = deps;
    this.service = new UpdateService(deps.updater, {
      packaged: deps.packaged,
      enabled: deps.enabled,
      platform: deps.platform,
      arch: deps.arch,
      version: deps.version,
      autoDownload: deps.autoDownload,
      facts: () => this.facts(),
      prepareInstall: () => this.prepareInstall(),
      cancelInstall: () => this.cancelInstall(),
      openExternal: url => openHttps(url, deps.openExternal),
      changed: state => deps.publish(state),
      source: deps.source,
      log: deps.log,
      now: deps.now,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
    });
  }

  /** True between the drain and the installer taking over (quit must not drain again). */
  get draining(): boolean { return this.drained; }

  markUpdateQuit(): void { this.updateQuitPending = true; }

  /** Block only the updater's queued quit after a failed spawn; a later ordinary Quit still works. */
  blockFailedUpdateQuit(): boolean {
    const pending = this.updateQuitPending;
    this.updateQuitPending = false;
    const state = this.service.state;
    return pending && state.status === 'downloaded' && state.failure === 'restart';
  }

  state(): UpdateState { return this.service.state; }
  apply(): Promise<UpdateState> { return this.service.apply(); }
  defer(): UpdateState { return this.service.defer(); }
  start(): void { this.service.start(); }
  dispose(): void { this.service.dispose(); }
  setVisible(visible: boolean): void { this.service.setVisible(visible); }
  checkIfDue(): void { void this.service.checkIfDue().catch(() => {}); }
  /** AF-019: "Check for updates now" (Settings › Updates), also with automatic checks off. */
  check(): Promise<UpdateState> { return this.service.check(); }

  /** AF-019: a new update source; saved first, so a failed save changes nothing. */
  async setSource(patch: Partial<UpdateSource>): Promise<UpdateState> {
    const next = { ...this.service.updateSource, ...patch };
    await this.deps.saveSource?.(next);
    return this.service.setSource(next);
  }

  async setAutoDownload(enabled: boolean): Promise<UpdateState> {
    await this.deps.setAutoDownload(enabled);
    this.service.autoDownloadChanged();
    return this.service.state;
  }

  /** The preference changed elsewhere (settings page) or the UI readiness changed. */
  reevaluate(): void { void this.service.evaluateRestart().catch(() => {}); }
  autoDownloadChanged(): void { this.service.autoDownloadChanged(); }

  private async facts(): Promise<{ rendererReady: boolean; idleSeconds: number; runtimeReady: boolean }> {
    const base = {
      rendererReady: this.deps.renderer.rendererReady,
      idleSeconds: this.deps.idleSeconds(),
    };
    // After the drain the runtime is intentionally gone: its work is checkpointed, so it is ready.
    if (this.drained) return { ...base, runtimeReady: true };
    return { ...base, runtimeReady: (await this.deps.runtime.readiness()).ready };
  }

  private async prepareInstall(): Promise<void> {
    if (!(await this.deps.renderer.prepareRestart(DRAFT_FLUSH_TIMEOUT_MS))) {
      throw new Error('The window did not confirm that its drafts are saved.');
    }
    try {
      await this.deps.runtime.prepareRestart(false);
      this.paused = true;
    } catch (error) {
      // A runtime that is not running has nothing to pause; anything else aborts the update.
      if (!(error instanceof WorkforceError && error.code === 'unavailable')) throw error;
    }
    await this.deps.runtime.stop('update');
    this.drained = true;
    this.paused = false;
    this.deps.log?.('drained for update install');
  }

  /** The restart did not happen after all: bring everything back. */
  private cancelInstall(): void {
    if (this.drained) {
      this.drained = false;
      this.deps.runtime.start();
    } else if (this.paused) {
      void this.deps.runtime.prepareRestart(true).catch(() => {});
    }
    this.paused = false;
    this.deps.log?.('update install cancelled; resumed');
  }
}
