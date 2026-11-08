// Update state machine around electron-updater (port of legacy updates.cjs, same states and
// restart rules) – event/timer driven: one re-armed check timer and one restart timer while a
// downloaded update waits for a safe point (timers.ts). No 1 s ticks. Where the app cannot
// install by itself (macOS without mac-self-update.ts) apply() opens the download in the browser
// instead (manual-download.ts); apply() also retries an 'error' state. A failure's text names the
// operation that failed (check, download, restart; a failed open says so itself), and a failed
// background check while a found update is offered keeps the offer (the next check retries).
// The failed step is explicit: a background check alone never requests a global retry action.
// AF-019: the update source (repository, channel, automatic checks: source.ts) is set here and reaches the updater's
// feed (setFeedURL) and the manual download; "nothing published there yet" is a calm 'current' with a message, and an
// offered version must be newer than this one (and no prerelease on the stable channel).
// Owns: UpdateState, check/download/install/apply/defer, the automatic-restart countdown.
// Never: imports electron or electron-updater (updater and browser opener are injected), never
// relaunches without prepareInstall() having drained the app.

import type { UpdateState } from '../../shared/model/system.ts';
import { failureText, MESSAGES, type UpdaterCall } from './failures.ts';
import { openManualDownload } from './manual-download.ts';
import { COUNTDOWN_MS, evaluateGate } from './restart-gate.ts';
import type { GateInput } from './restart-gate.ts';
import { downloadURL } from './release.ts';
import { DEFAULT_SOURCE, feedOptions, isNoReleaseError, noReleaseText, normalizeSource, offersUpdate, releaseNotesText } from './source.ts';
import type { UpdateSource } from './source.ts';
import { NamedTimers } from './timers.ts';
import type { TimerHooks } from './timers.ts';

/** The electron-updater surface we use (AppUpdater). */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  logger: unknown;
  on(event: string, listener: (value: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  /** Pinned-library adapter: allow a later explicit attempt after an error or watchdog. */
  resetInstallAttempt?(): void;
  /** Installs on macOS too, where the plain updater cannot (mac-self-update.ts); its 'manual-only' event ends that. */
  installsItself?: boolean;
  /** AF-019: points the updater at the chosen GitHub repository (electron-updater's AppUpdater.setFeedURL). */
  setFeedURL?(options: { provider: 'github'; owner: string; repo: string }): void;
}

type GateFacts = Omit<GateInput, 'packaged' | 'automaticInstall' | 'autoDownload' | 'deferred'>;

export interface UpdateServiceOptions extends TimerHooks {
  packaged: boolean;
  enabled: boolean; // false in test mode: never talks to GitHub
  platform: string;
  arch: string;
  version: string;
  autoDownload(): boolean;
  /** Collects the live facts for the restart gate (renderer, idle, runtime). */
  facts(): Promise<GateFacts>;
  /** Drains the app before the installer starts; throws to abort. */
  prepareInstall(): Promise<void>;
  /** Undoes prepareInstall when the restart does not happen after all (resume agent wakes). */
  cancelInstall?(): void;
  /** Opens the manual download in the system browser (automatic install unavailable). */
  openExternal(url: string): Promise<void> | void;
  changed(state: UpdateState): void;
  /** AF-019: where updates come from (Settings › Updates); default: this build's repository, stable, automatic checks. */
  source?: UpdateSource;
  /** Operational states and safe error codes only; never updater URLs, paths or raw errors. */
  log?(line: string): void;
}

export const CHECK_THROTTLE_MS = 30_000;
export const CHECK_INTERVAL_VISIBLE_MS = 60_000; // B-023: every minute while the window is open
export const CHECK_INTERVAL_HIDDEN_MS = 15 * 60_000; // tray only: rarer (CPU/network on the 8 GB PC)
export const INSTALL_WATCHDOG_MS = 20_000;

export class UpdateService {
  private readonly updater: Updater;
  private readonly options: UpdateServiceOptions;
  private readonly timers: NamedTimers<'check' | 'restart' | 'install'>;
  private value: UpdateState;
  private busy = false;
  private running: UpdaterCall | undefined; // the updater call in flight (names a failure: failures.ts)
  private opening = false; // a manual-download open in flight (its own guard: a check may run meanwhile)
  private pendingDownload = false;
  private deferred = false;
  private lastCheck = -Infinity;
  private visible = true;
  private evaluating = false;
  private disposed = false;
  private source: UpdateSource;

  constructor(updater: Updater, options: UpdateServiceOptions) {
    this.updater = updater;
    this.options = options;
    this.timers = new NamedTimers(options);
    this.source = normalizeSource(options.source ?? DEFAULT_SOURCE);
    this.value = {
      status: options.packaged && options.enabled ? 'idle' : 'development',
      version: options.version,
      percent: 0,
      automaticInstall: options.platform !== 'darwin' || updater.installsItself === true, // macOS builds are ad hoc signed: self-update or manual download
      downloadURL: downloadURL(options.platform, options.arch, this.source.repository) ?? undefined,
      source: this.source.repository,
      channel: this.source.channel,
      autoCheck: this.source.autoCheck,
    };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.logger = null;
    this.applySource();
    for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error', 'manual-only']) {
      updater.on(event, value => this.onEvent(event, value));
    }
  }

  get state(): UpdateState { return { ...this.value }; }
  private get active(): boolean { return !this.disposed && this.options.packaged && this.options.enabled; }

  /** Arms the first check (shortly after start) and the recurring check timer. */
  start(firstDelayMs = 3000): void { if (this.active && this.source.autoCheck) this.armCheck(firstDelayMs); }

  /** The current update source (Settings › Updates). */
  get updateSource(): UpdateSource { return { ...this.source }; }

  /**
   * AF-019: a new source (repository, channel, automatic checks). A different repository or channel forgets an offered
   * update and checks there at once; a downloaded or installing update stays. Invalid fields keep their value.
   */
  setSource(patch: Partial<UpdateSource>): UpdateState {
    const previous = this.source;
    const next = normalizeSource({ ...previous, ...patch }, previous);
    this.source = next;
    const moved = next.repository !== previous.repository || next.channel !== previous.channel;
    this.applySource();
    const change: Partial<UpdateState> = {
      source: next.repository,
      channel: next.channel,
      autoCheck: next.autoCheck,
      downloadURL: downloadURL(this.options.platform, this.options.arch, next.repository) ?? undefined,
    };
    if (moved && ['idle', 'current', 'error', 'available'].includes(this.value.status)) {
      Object.assign(change, { status: this.active ? 'idle' : this.value.status, availableVersion: undefined, releaseName: undefined, releaseNotes: undefined, message: undefined, failure: undefined });
    }
    this.emit(change);
    if (this.active && !next.autoCheck) this.timers.clear('check');
    if (this.active && next.autoCheck && !previous.autoCheck && !moved) this.armCheck(this.interval());
    if (this.active && moved) void this.check();
    return this.state;
  }

  dispose(): void { this.disposed = true; this.timers.clear('check'); this.timers.clear('restart'); this.timers.clear('install'); }

  /** Window shown/hidden: changes the check interval (focus/resume also call checkIfDue). */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.active && this.timers.has('check')) this.armCheck(this.interval());
  }

  checkIfDue(): Promise<UpdateState> {
    if (!this.source.autoCheck) return Promise.resolve(this.state); // AF-019: only "Check for updates now"
    return this.timers.now() - this.lastCheck < CHECK_THROTTLE_MS ? Promise.resolve(this.state) : this.check();
  }

  async check(): Promise<UpdateState> {
    if (!this.active || this.busy || ['downloading', 'downloaded', 'installing'].includes(this.value.status)) return this.state;
    this.busy = true;
    this.running = 'check';
    this.lastCheck = this.timers.now();
    try { await this.updater.checkForUpdates(); } catch (error) { this.onEvent('error', error); } finally { this.busy = false; this.running = undefined; }
    if (this.source.autoCheck) this.armCheck(this.interval());
    if (this.pendingDownload) {
      this.pendingDownload = false;
      await this.download();
    }
    return this.state;
  }

  async download(): Promise<UpdateState> {
    if (!this.active || !this.value.automaticInstall || this.busy || this.value.status !== 'available') return this.state;
    this.busy = true;
    this.running = 'download';
    this.emit({ status: 'downloading', percent: 0, message: undefined, failure: undefined });
    try { await this.updater.downloadUpdate(); } catch { this.onEvent('error', undefined); } finally { this.busy = false; this.running = undefined; }
    if (this.state.status === 'downloaded') void this.evaluateRestart(); // 'update-downloaded' came while busy
    return this.state;
  }

  /** "Later": no automatic restart in this process (a click still installs). */
  defer(): UpdateState {
    this.deferred = true;
    this.timers.clear('restart');
    if (this.value.restartAt) this.emit({ restartAt: undefined });
    return this.state;
  }

  /** The preference changed: download now if wanted, re-evaluate the restart gate. */
  autoDownloadChanged(): void {
    if (this.options.autoDownload() && this.value.status === 'available') void this.download();
    void this.evaluateRestart();
  }

  /**
   * One user action for the update control: error → check again (and carry on only when an update
   * was already found), available → download (or open the manual download where the app cannot
   * install by itself), downloaded → install.
   */
  async apply(): Promise<UpdateState> {
    if (this.value.status === 'error') {
      const found = !!this.value.availableVersion;
      await this.check();
      if (!found) return this.state; // a failed check is retried as a check; the next click updates
    }
    if (this.value.status === 'available' && !this.value.automaticInstall) return this.openDownload();
    if (this.value.status === 'available') await this.download();
    if (this.value.status === 'downloaded') await this.install(false);
    return this.state;
  }

  async install(automatic: boolean): Promise<void> {
    if (this.disposed) return;
    if (this.value.status !== 'downloaded') throw new Error('Download the update before restarting.');
    if (this.busy) return;
    this.busy = true;
    this.timers.clear('restart');
    this.emit({ status: 'installing', percent: 100, message: undefined, failure: undefined, restartAt: undefined });
    try {
      await this.options.prepareInstall();
      if (automatic && !(await this.gateOpen())) {
        this.options.cancelInstall?.();
        this.emit({ status: 'downloaded' });
        return;
      }
      this.startInstaller();
    } catch (error) {
      this.onEvent('error', error);
      throw new Error('Could not restart to update. Please try again.');
    } finally {
      this.busy = false;
    }
  }

  /**
   * Re-evaluates the automatic restart. Called on every relevant event (download finished,
   * renderer readiness changed, preference changed) and by its own timer.
   */
  async evaluateRestart(): Promise<void> {
    if (this.disposed || this.evaluating) return;
    this.evaluating = true;
    try {
      this.timers.clear('restart');
      if (this.value.status !== 'downloaded' || this.busy) return;
      const decision = evaluateGate(await this.gateInput());
      if (this.value.status !== 'downloaded' || this.busy) return;
      if (decision.action !== 'restart') {
        if (this.value.restartAt) this.emit({ restartAt: undefined });
        if (decision.action === 'wait' && decision.recheckMs !== null) this.armRestart(decision.recheckMs);
        return;
      }
      if (!this.value.restartAt) {
        this.emit({ restartAt: this.timers.now() + COUNTDOWN_MS });
        this.armRestart(COUNTDOWN_MS);
        return;
      }
      const left = this.value.restartAt - this.timers.now();
      if (left > 0) { this.armRestart(left); return; }
      await this.install(true).catch(() => {});
    } finally {
      this.evaluating = false;
    }
  }

  /** Manual install: one browser open per click (a second click while it opens does nothing; a running check does not block it). */
  private async openDownload(): Promise<UpdateState> {
    if (this.opening) return this.state;
    this.opening = true;
    const change = await openManualDownload(this.value, url => this.options.openExternal(url)).finally(() => { this.opening = false; });
    if (change) this.emit(change);
    return this.state;
  }

  private onEvent(event: string, value: unknown): void {
    if (this.disposed) return;
    const info = (value ?? {}) as { version?: string; percent?: number; releaseName?: unknown; releaseNotes?: unknown };
    if (event === 'update-available' && info.version && !offersUpdate(info.version, this.options.version, this.source.channel)) event = 'update-not-available'; // AF-019: never an older/equal version
    if (event === 'manual-only') this.emit({ automaticInstall: false });
    if (event === 'checking-for-update' && !this.value.availableVersion) this.emit({ status: 'checking', message: undefined, failure: undefined });
    if (event === 'update-available') {
      this.emit({
        status: 'available', message: undefined, failure: undefined, availableVersion: info.version,
        releaseName: typeof info.releaseName === 'string' && info.releaseName.trim() ? info.releaseName.trim().slice(0, 200) : undefined,
        releaseNotes: releaseNotesText(info.releaseNotes),
      });
      if (this.options.autoDownload() && this.value.automaticInstall) this.pendingDownload = true;
    }
    if (event === 'update-not-available') this.emit({ status: 'current', availableVersion: undefined, releaseName: undefined, releaseNotes: undefined, percent: 0, message: undefined, failure: undefined });
    if (event === 'download-progress') this.emit({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(info.percent ?? 0))) });
    if (event === 'update-downloaded') {
      this.emit({ status: 'downloaded', percent: 100, restartAt: undefined, message: undefined, failure: undefined });
      queueMicrotask(() => { void this.evaluateRestart(); });
    }
    if (event === 'error' && this.running === 'check' && isNoReleaseError(value)) {
      // AF-019: the source has no (usable) release yet – that is "up to date from there", not a failure.
      this.options.log?.('update check: no release in the source yet');
      if (this.value.status !== 'available') this.emit({ status: 'current', availableVersion: undefined, releaseName: undefined, releaseNotes: undefined, percent: 0, failure: undefined, message: noReleaseText(this.source.repository) });
      return;
    }
    if (event === 'error') {
      this.pendingDownload = false;
      const installing = this.value.status === 'installing';
      if (installing) this.deferred = true; // never loop into a second automatic attempt
      if (installing) this.updater.resetInstallAttempt?.();
      if (installing) this.options.cancelInstall?.(); // asynchronous installer errors must undo the drain too
      this.timers.clear('install');
      if (this.running === 'check' && this.value.status === 'available') return; // the found update stays offered
      const failure = installing ? 'restart' : this.running ?? (this.value.status === 'downloading' ? 'download' : this.value.failure ?? 'check');
      const code = (value as { code?: unknown } | null)?.code;
      this.options.log?.(`update ${failure} failed${typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` (${code})` : ''}`);
      this.emit({ status: installing ? 'downloaded' : 'error', failure, restartAt: undefined, message: installing ? MESSAGES.restart : failureText(this.running, this.value) });
    }
  }

  private startInstaller(): void {
    // If the process survives quitAndInstall, the download stays and the action re-enables.
    this.timers.set('install', () => {
      if (this.value.status !== 'installing') return;
      this.onEvent('error', undefined);
    }, INSTALL_WATCHDOG_MS);
    this.options.log?.('update installer requested: silent, run after install');
    this.updater.quitAndInstall(true, true); // silent, relaunch afterwards (Windows/Linux: install-helper.ts, Mac: mac-self-update.ts)
  }

  private async gateInput(): Promise<GateInput> {
    const base = {
      packaged: this.options.packaged,
      automaticInstall: this.value.automaticInstall,
      autoDownload: this.options.autoDownload(),
      deferred: this.deferred,
    };
    try {
      return { ...base, ...(await this.options.facts()) };
    } catch {
      return { ...base, rendererReady: false, idleSeconds: 0, runtimeReady: false };
    }
  }

  private async gateOpen(): Promise<boolean> { return evaluateGate(await this.gateInput()).action === 'restart'; }

  /** The source's channel and repository on the updater (prereleases only on that channel). */
  private applySource(): void {
    this.updater.allowPrerelease = this.source.channel === 'prerelease';
    if (!this.options.packaged || !this.options.enabled) return;
    try { this.updater.setFeedURL?.(feedOptions(this.source)); } catch { this.options.log?.('update source could not be set'); }
  }

  private interval(): number { return this.visible ? CHECK_INTERVAL_VISIBLE_MS : CHECK_INTERVAL_HIDDEN_MS; }

  private armCheck(ms: number): void {
    this.timers.set('check', () => { void this.checkIfDue().finally(() => { if (!this.timers.has('check')) this.armCheck(this.interval()); }); }, ms);
  }

  private armRestart(ms: number): void { this.timers.set('restart', () => { void this.evaluateRestart(); }, ms); }

  private emit(change: Partial<UpdateState>): void {
    const next = { ...this.value, ...change };
    if (next.status !== this.value.status) this.options.log?.(`update state: ${next.status}`);
    for (const key of Object.keys(next) as Array<keyof UpdateState>) if (next[key] === undefined) delete next[key];
    this.value = next;
    this.options.changed(this.state);
  }
}
