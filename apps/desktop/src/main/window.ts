// The app window: hardened BrowserWindow (sandbox, context isolation, no node), hidden title
// bar with the native window-controls overlay in the header row's colors and height
// (title-bar.ts), app://app/index.html, navigation and window-open guards, bounds persistence
// and crash recovery (window-recovery.ts decides: reload, or stop and tell the person). Closing it
// destroys the renderer (frees its memory); agents keep running in the runtime and the tray stays.
// Owns: one BrowserWindow at a time and its event wiring. Never: decides whether closing quits
// the app (desktop.ts does), grants permissions (session-guards.ts), talks RPC.

import { BrowserWindow, dialog, nativeTheme, screen, shell } from 'electron';
import type { TitleBarLayout } from '../shared/api/desktop.ts';
import type { AppPaths } from './app-paths.ts';
import type { RendererLink } from './renderer-link.ts';
import { mainFrameNavigation, subFrameNavigationAllowed, windowOpenDecision } from './security.ts';
import { titleBarColors, titleBarOverlay, trafficLightPosition } from './title-bar.ts';
import { MIN_HEIGHT, MIN_WIDTH, clampBounds } from './window-state.ts';
import { RendererRecovery, stuckDialog, type CrashStep } from './window-recovery.ts';
import type { ThemePreference, WindowState } from './window-state.ts';

export const APP_URL = 'app://app/index.html';

export interface MainWindowDeps {
  paths: AppPaths;
  title: string;
  platform: string;
  devTools: boolean; // F12 / Ctrl+Shift+I in development builds
  renderer: RendererLink;
  state: WindowState;
  saveState(state: WindowState): void;
  onClosed(): void;
  onVisibilityChange(visible: boolean): void;
  onFocus(): void;
  log(line: string): void;
}

export class MainWindow {
  private readonly deps: MainWindowDeps;
  private window: BrowserWindow | null = null;
  private state: WindowState;
  private readonly recovery = new RendererRecovery({ now: () => Date.now() });
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The UI's layout (IPC titleBarLayout); a new window starts in columns until its page reports. */
  private captionLayout: TitleBarLayout = 'columns';

  constructor(deps: MainWindowDeps) {
    this.deps = deps;
    this.state = deps.state;
    nativeTheme.themeSource = this.state.theme ?? 'system';
    nativeTheme.on('updated', () => this.recolor());
  }

  get browserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  get contentsId(): number | null { return this.browserWindow?.webContents.id ?? null; }
  get mainFrame(): unknown { return this.browserWindow?.webContents.mainFrame ?? null; }
  get focused(): boolean {
    const window = this.browserWindow;
    return Boolean(window && window.isVisible() && !window.isMinimized() && window.isFocused());
  }

  /** Shows the window, creating it when it was closed. */
  show(): void {
    const window = this.browserWindow;
    if (!window) { this.create(); return; }
    // A renderer that crashed too often (or was killed) stays blank until the user asks again.
    if (window.webContents.isCrashed()) {
      this.recovery.reset();
      void window.loadURL(APP_URL).catch(error => this.deps.log(`window reload failed: ${(error as Error).message}`));
    }
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }

  close(): void {
    this.browserWindow?.close();
  }

  /** Applies the appearance preference (native controls, background; the UI styles itself). */
  applyTheme(theme: ThemePreference): void {
    if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
    if (this.state.theme !== theme) {
      this.state = { ...this.state, theme };
      this.deps.saveState(this.state);
    }
    this.recolor();
  }

  /** The page's layout changed (column header row ↔ compact top bar): re-apply the overlay. */
  setTitleBarLayout(layout: TitleBarLayout): void {
    if (layout === this.captionLayout) return;
    this.captionLayout = layout;
    this.recolor();
  }

  private create(): void {
    const { deps } = this;
    this.captionLayout = 'columns';
    this.recovery.reset();
    const bounds = clampBounds(this.state.bounds, screen.getAllDisplays().map(display => display.workArea), screen.getPrimaryDisplay().workArea);
    const dark = nativeTheme.shouldUseDarkColors;
    const mac = deps.platform === 'darwin';
    const window = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      title: deps.title,
      backgroundColor: titleBarColors(dark).color,
      ...(mac ? {} : { icon: deps.paths.icon }),
      titleBarStyle: 'hidden',
      // Expose the same caption geometry on every OS, including the left-hand macOS controls.
      titleBarOverlay: titleBarOverlay(dark, this.captionLayout),
      ...(mac ? { trafficLightPosition: trafficLightPosition() } : {}),
      webPreferences: {
        preload: deps.paths.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        backgroundThrottling: true,
        navigateOnDragDrop: false,
        safeDialogs: true,
        spellcheck: true,
        devTools: deps.devTools,
      },
    });
    this.window = window;
    if (this.state.maximized) window.maximize();
    const contents = window.webContents;
    deps.renderer.attach(contents);

    contents.setWindowOpenHandler(details => {
      const decision = windowOpenDecision(details.url);
      if (decision.openExternal) void shell.openExternal(decision.openExternal).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('will-navigate', event => {
      const decision = mainFrameNavigation(event.url);
      if (decision.allow) return;
      event.preventDefault();
      if (decision.openExternal) void shell.openExternal(decision.openExternal).catch(() => {});
    });
    contents.on('will-frame-navigate', event => {
      if (event.isMainFrame) {
        if (!mainFrameNavigation(event.url).allow) event.preventDefault();
      } else if (!subFrameNavigationAllowed(event.url)) {
        event.preventDefault();
      }
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    // A committed main-frame document change (reload) drops the page state. Not did-start-navigation:
    // that also fires for navigations will-navigate cancels (a web link), which would leave the
    // link "loading" forever – pushes queued, readiness lost.
    contents.on('did-navigate', () => deps.renderer.loading());
    contents.on('did-finish-load', () => deps.renderer.finishedLoading());
    contents.on('render-process-gone', (_event, details) => this.recover(details.reason));
    if (deps.devTools) {
      contents.on('before-input-event', (_event, input) => {
        const toggle = input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'));
        if (toggle) contents.toggleDevTools();
      });
    }

    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
    window.on('show', () => deps.onVisibilityChange(true));
    window.on('hide', () => deps.onVisibilityChange(false));
    window.on('focus', () => deps.onFocus());
    window.on('resize', () => this.scheduleSave());
    window.on('move', () => this.scheduleSave());
    window.on('close', () => this.saveNow());
    window.on('closed', () => {
      if (this.window === window) this.window = null;
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
      deps.renderer.detach();
      deps.onVisibilityChange(false);
      deps.onClosed();
    });
    void window.loadURL(APP_URL).catch(error => deps.log(`window load failed: ${(error as Error).message}`));
  }

  private recolor(): void {
    const window = this.browserWindow;
    if (!window) return;
    const dark = nativeTheme.shouldUseDarkColors;
    window.setBackgroundColor(titleBarColors(dark).color);
    if (this.deps.platform !== 'darwin') {
      try { window.setTitleBarOverlay(titleBarOverlay(dark, this.captionLayout)); } catch { /* no overlay on this platform */ }
    }
  }

  /** Renderer gone: reload, or stop and ask after repeated crashes (window-recovery.ts). */
  private recover(reason: string): void {
    this.deps.renderer.loading();
    const step = this.recovery.gone(reason);
    if (step.kind === 'ignore') return;
    this.deps.log(`renderer gone (${reason}): ${step.kind === 'reload' ? 'reload' : `stopped (${step.why})`}`);
    const window = this.browserWindow;
    if (!window) return;
    if (step.kind === 'reload') {
      setTimeout(() => { if (!window.isDestroyed()) void window.loadURL(APP_URL).catch(() => {}); }, step.delayMs).unref?.();
      return;
    }
    this.askAfterCrashes(window, step.why);
  }

  /** The page cannot be shown: say so; "Try again" starts fresh, "Close window" keeps agents running. */
  private askAfterCrashes(window: BrowserWindow, why: Extract<CrashStep, { kind: 'stuck' }>['why']): void {
    const text = stuckDialog(why);
    void dialog.showMessageBox(window, { type: 'warning', title: this.deps.title, message: text.message, detail: text.detail, buttons: text.buttons, defaultId: 0, cancelId: 1, noLink: true })
      .then(({ response }) => {
        if (window.isDestroyed()) return;
        if (response === 0) { this.recovery.reset(); void window.loadURL(APP_URL).catch(() => {}); } else this.close();
      })
      .catch(error => this.deps.log(`crash dialog failed: ${(error as Error).message}`));
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1000);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    const window = this.browserWindow;
    if (!window) return;
    this.state = { ...this.state, bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    this.deps.saveState(this.state);
  }
}
