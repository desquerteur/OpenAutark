// Composition root of the Electron main process (started by index.ts once the app is ready):
// runtime utility process + main's RpcClient, protocols, session guards, IPC, window, tray,
// updates, power events, "Keep agents running" (launcher-tasks.ts registers it; after a
// deliberate quit launcher-windows.ts writes the next due work's start; quit marks in run-state.json,
// the system's session end via session-end.ts), close-to-tray (the closeToTray preference: off = closing
// quits), the emergency stop of all agent work (tray entry, shortcut while agents work, notice afterwards;
// work-stop.ts), the hidden video-keyframe windows (hidden-windows.ts) and graceful quit. Speech runs in the
// page and the runtime: main only opens the microphone (security.ts MediaArm). B-072: another company (companies.ts)
// keeps its workspace and downloads in its own folder, has its own launcher task, names itself in the window title
// and tray tooltip ("Autark – <label>") and leaves updates to the first company; the emergency stop reaches them all.
// Owns: constructing and connecting the main-side modules. Never: business logic (runtime),
// UI decisions (renderer), long work on the main thread.

import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  BaseWindow, Menu, MessageChannelMain, Notification, Tray, app, autoUpdater as nativeUpdater, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor,
  powerSaveBlocker, protocol, safeStorage, screen, session, shell, utilityProcess,
} from 'electron';
import type { MessagePortMain } from 'electron';
import { IPC } from '../shared/api/desktop.ts';
import { appInfo, appPaths } from './app-paths.ts';
import { Capture, windowLayers } from './capture.ts';
import { openCompany, spawnApp, startFlag, stopOtherCompanies } from './companies.ts';
import { desktopIpcDeps } from './desktop-ipc.ts';
import { hiddenWindows } from './hidden-windows.ts';
import { HostServices } from './host-services.ts';
import { registerIpc } from './ipc.ts';
import { applyLauncher, launcherDeps } from './launcher-tasks.ts';
import { armDueStart } from './launcher-windows.ts';
import { RunStateMarks } from './launcher.ts';
import { openMainLog } from './main-log.ts';
import { ProtocolHandlers, registerProtocolHandlers } from './protocols/handlers.ts';
import { RendererLink } from './renderer-link.ts';
import { RuntimeHost } from './runtime-host.ts';
import type { RuntimeChild } from './runtime-host.ts';
import { RuntimeLink, runtimeEnv } from './runtime-link.ts';
import { MediaArm } from './security.ts';
import { watchSessionEnd } from './session-end.ts';
import { guardAllContents, installSessionGuards } from './session-guards.ts';
import { SettingsView, changedPreferences } from './settings-view.ts';
import { quitSteps, runShutdown } from './shutdown.ts';
import { AppTray } from './tray.ts';
import { DesktopUpdates, inactiveUpdater, loadUpdater, settleAfterStart } from './updates-wiring.ts';
import { MainWindow } from './window.ts';
import { WorkspaceBrowser } from './workspace-browser.ts';
import { setFillRpc } from './workspace-fill.ts';
import { SideDriver } from './side-driver/driver.ts'; // B-055 F1
import { SideCaster } from './side-driver/caster.ts'; // B-076
import { OWNER_ALIAS } from '../shared/model/people.ts';
import { companyLabel } from '../shared/model/companies.ts';
import type { AppInfo } from '../shared/api/host-bridge.ts';
import { personalDownloads } from './workspace-downloads.ts';
import { WorkStopControl, type WorkStopRpc } from './work-stop.ts';
import { loadWindowState, saveWindowState } from './window-state.ts';

export interface DesktopOptions {
  background: boolean; // started at sign-in or by the launcher: tray + runtime, no window
  testData: string | null; // WORKFORCE_TEST_DATA: isolated profile, no network updater
  company: string | null; // B-072: another company's id (--company=<id>); null = the first company
  companies: AppInfo['companies'] | null; // B-072: where the companies live; null in a test profile
}

export interface Desktop {
  show(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'error';
}

export async function startDesktop(options: DesktopOptions): Promise<Desktop> {
  const testMode = options.testData !== null;
  const platform = process.platform;
  const productName = app.getName();
  if (platform === 'win32') app.setAppUserModelId('com.teydralab.workforce');
  if (platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  guardAllContents(app);

  const paths = appPaths({ appPath: app.getAppPath(), userData: app.getPath('userData') });
  const log = openMainLog(paths.logs, !app.isPackaged);
  const runMarks = new RunStateMarks(paths.data, line => log.line(line)); // B-044: every deliberate quit is marked (launcher.ts)
  log.line(`starting ${app.getVersion()}${app.isPackaged ? '' : ' (development)'}${testMode ? ' (test data)' : ''}`);

  let quitting = false;
  const media = new MediaArm();
  const link = new RuntimeLink<MessagePortMain>();
  setFillRpc(link.rpc); // B-078 D20: "Fill login" reaches secrets.fillLogin over main's own link
  const settings = new SettingsView(link.rpc);
  const company = options.company;
  const companies = options.companies ?? undefined;
  const start = testMode ? undefined : startFlag(process.argv); // B-078: the "+" menu's --start=mine|employee (none in a test profile)
  const title = () => (company ? `${productName} – ${companyLabel(settings.current?.profile, company)}` : productName);
  let updates: DesktopUpdates | null = null;
  const renderer = new RendererLink({
    onReadyChange: () => updates?.reevaluate(),
    onLoaded: () => {
      renderer.send(IPC.runtimeStatus, link.status);
      if (updates) renderer.send(IPC.updateState, updates.state());
      retitle(); // the page's <title> replaced the window's
    },
  });

  // ---------------------------------------------------------------- capture
  let appWindow: MainWindow | null = null;
  // MM4 video keyframes run in a hidden window – never the person's window.
  const hidden = hiddenWindows({ blobsDir: paths.blobs });
  const capture = new Capture({
    screen,
    getSources: sourceOptions => desktopCapturer.getSources(sourceOptions),
    appContents: () => appWindow?.browserWindow?.webContents ?? null,
    // B-055: the feedback shot includes the side browser's native view (capture.ts windowLayers)
    appLayers: () => windowLayers(appWindow?.browserWindow ?? null),
    fromBitmap: (data, size) => nativeImage.createFromBitmap(Buffer.from(data.buffer, data.byteOffset, data.byteLength), size),
  });

  // ---------------------------------------------------------------- tray, host services, runtime
  const tray = new AppTray({
    electron: { Tray, Menu, nativeImage },
    iconPath: paths.icon,
    get name() { return title(); }, // read at each tooltip update: a company's label follows its profile
    platform,
    onOpen: () => appWindow?.show(),
    onQuit: () => app.quit(),
    onStopWork: () => { void workStop.stop(); },
    onResumeWork: () => { void workStop.resume(); },
  });
  let badge = 0;
  /** B-072: another company names itself in the window title and the tray tooltip ("Autark – <label>"). */
  const retitle = () => {
    if (!company) return;
    appWindow?.browserWindow?.setTitle(title());
    tray.setBadge(badge); // the tooltip reads the name again
  };
  const workNotices: object[] = []; // the last stop notice (host-services.ts keeps its own the same way)
  // B-072: "Stop all agent work" stops every company on this PC – one of them holds the global shortcut (companies.ts)
  const workRpc: WorkStopRpc = {
    call: (method, params, timeoutMs) => {
      if (method === 'work.stop' && companies) void stopOtherCompanies(companies, paths.data);
      return link.rpc.call(method, params, timeoutMs);
    },
    on: (event, listener) => link.rpc.on(event, listener),
    subscribe: topic => link.rpc.subscribe(topic),
  };
  const workStop = new WorkStopControl({
    rpc: workRpc,
    shortcut: globalShortcut,
    tray,
    notify: (title, body) => {
      if (!Notification.isSupported()) return;
      const notice = new Notification({ title, body, ...(platform === 'darwin' ? {} : { icon: paths.icon }) });
      notice.on('click', () => appWindow?.show());
      workNotices.splice(0, workNotices.length, notice); // kept until the next one: a collected Notification loses its click handler
      notice.show();
    },
    log: line => log.line(line),
  });
  let workspaceBrowser: WorkspaceBrowser | null = null; // B-055 F1: agents in the person's side browser (main/side-driver)
  const sideDriver = new SideDriver({
    browser: () => workspaceBrowser,
    pointer: point => link.pointer(point), // host bridge 'pointer' → the runtime's pointer hub
    person: () => ({ kind: 'person', id: OWNER_ALIAS, name: settings.current?.profile?.name?.trim() || 'Owner' }),
  });
  // B-076: a side tab watched from another PC or a phone – its picture goes to the runtime, its input comes back
  const caster = new SideCaster({
    tab: id => sideDriver.side(id), keep: id => workspaceBrowser?.sideKeep(id), release: id => workspaceBrowser?.sideRelease(id), send: update => link.sideView(update),
  });
  const host = new HostServices({
    safeStorage,
    shell,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    powerSaveBlocker,
    createNotification: notification => (Notification.isSupported() ? new Notification({ ...notification, ...(platform === 'darwin' ? {} : { icon: paths.icon }) }) : null),
    setBadgeCount: count => app.setBadgeCount(count),
    capture,
    media: hidden.mediaAnalyzer,
    sideBrowser: call => sideDriver.call(call), // B-055 F1: checks every field itself
    sideView: { cast: args => caster.cast(args), input: args => caster.input(args), nav: args => caster.nav(args) }, // B-076
    window: {
      focused: () => appWindow?.focused ?? false,
      show: () => appWindow?.show(),
      navigate: request => renderer.sendWhenLoaded(IPC.navigate, request),
    },
    onBadge: count => { badge = count; tray.setBadge(count); },
    // B-072: switching companies (companies.ts): that company's window opens, this one goes to the tray
    openCompany: companies ? args => openCompany(args, { dir: companies.dir, current: company, spawn: spawnApp, show: () => appWindow?.show(), hide: () => appWindow?.browserWindow?.hide() }) : undefined,
  });
  const runtimeHost = new RuntimeHost<MessagePortMain>({
    // UtilityProcess.stdout is typed as NodeJS.ReadableStream; it is a stream.Readable at runtime.
    fork: (modulePath, args, forkOptions) => utilityProcess.fork(modulePath, args, forkOptions) as unknown as RuntimeChild,
    createChannel: () => new MessageChannelMain(),
    modulePath: paths.runtime,
    env: runtimeEnv(process.env, paths.data),
    token: randomBytes(32).toString('hex'),
    app: { ...appInfo({ version: app.getVersion(), packaged: app.isPackaged, paths, executable: process.execPath, companies }), ...(start ? { start } : {}) },
    handle: request => host.handle(request),
    onStatus: status => link.handleStatus(status),
    log: log.sink,
    logLine: line => log.line(line),
  });
  link.bind(runtimeHost);
  link.onChange(status => {
    renderer.send(IPC.runtimeStatus, status);
    if (status.state === 'up') void settings.start().catch(error => log.line(`settings not loaded: ${errorText(error)}`));
    if (status.state === 'up') void workStop.start().catch(error => log.line(`agent work stop state not loaded: ${errorText(error)}`));
    if (status.state === 'restarting' || status.state === 'stopped') { host.releaseAll(); workStop.reset(); caster.stopAll(); }
  });

  // ---------------------------------------------------------------- updates
  let updater = inactiveUpdater();
  let updaterLoaded = false;
  if (app.isPackaged && !testMode && !company) { // one updater: the first company's (the installer replaces the shared app)
    try {
      updater = await loadUpdater(line => log.line(line));
      updaterLoaded = true;
    } catch (error) {
      log.line(`updater not available: ${errorText(error)}`); // the app still starts, without updates
    }
  }
  const desktopUpdates = new DesktopUpdates({
    updater,
    packaged: app.isPackaged,
    enabled: updaterLoaded,
    platform,
    arch: process.arch,
    version: app.getVersion(),
    autoDownload: () => settings.preferences().autoDownloadUpdates,
    setAutoDownload: async enabled => { await settings.update({ preferences: { autoDownloadUpdates: enabled } }); },
    renderer,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    runtime: {
      readiness: () => link.rpc.call('system.restartReadiness'),
      prepareRestart: async cancel => { await link.rpc.call('system.prepareRestart', cancel ? { cancel: true } : {}, 30_000); },
      stop: reason => link.stop(reason),
      start: () => link.start(),
    },
    publish: state => {
      renderer.send(IPC.updateState, state);
      link.event('update.state', state);
    },
    openExternal: url => shell.openExternal(url), // the manual download (https only: updates-wiring.ts)
    log: line => log.line(line),
  });
  updates = desktopUpdates;

  // ---------------------------------------------------------------- settings reactions
  const launcher = launcherDeps(app, { platform, testMode, name: productName, company, dataDir: paths.data, log: line => log.line(line) });
  settings.onChange((next, previous) => {
    const changed = changedPreferences(next, previous);
    const prefs = settings.preferences();
    if (next.profile?.company !== previous?.profile?.company || next.profile?.name !== previous?.profile?.name) retitle();
    if (changed.includes('theme')) appWindow?.applyTheme(prefs.theme);
    if (changed.includes('openAtLogin')) void applyLauncher(prefs.openAtLogin, launcher); // B-044: "Keep agents running"
    if (changed.includes('autoDownloadUpdates')) desktopUpdates.autoDownloadChanged();
  });

  // ---------------------------------------------------------------- window
  const mainWindow = new MainWindow({
    paths,
    title: title(),
    platform,
    devTools: !app.isPackaged,
    renderer,
    state: await loadWindowState(paths.windowState),
    saveState: state => { void saveWindowState(paths.windowState, state); },
    onClosed: () => {
      media.disarm();
      // Close ≠ quit by default: the tray and the runtime (agents) keep running – unless the
      // person turned closeToTray off.
      if (!quitting && !settings.preferences().closeToTray) app.quit();
    },
    onVisibilityChange: visible => desktopUpdates.setVisible(visible),
    onFocus: () => desktopUpdates.checkIfDue(),
    log: line => log.line(line),
  });
  appWindow = mainWindow;
  workspaceBrowser = new WorkspaceBrowser(() => mainWindow.browserWindow, { // tabs and panels survive restarts
    onTab: (id, contents) => sideDriver.tab(id, contents), // B-055 F1
    keep: id => caster.watched(id), // B-076: a page watched from another PC or a phone stays loaded
    tabsFile: path.join(paths.data, 'side-tabs.json'),
    oldTabsFile: path.join(paths.data, 'workspace-tabs.json'),
    historyFile: path.join(paths.data, 'browser-history.json'),
    zoomFile: path.join(paths.data, 'workspace-zoom.json'),
    // B-044: the person's downloads go to the runtime's workspace (runtime/system/paths.ts: <home>/Workforce; a test profile's
    // and another company's own: <data>/workspace, runtime/root/companies.ts)
    downloadsDir: personalDownloads(options.testData || company ? path.join(paths.data, 'workspace') : path.join(os.homedir(), 'Workforce')),
  });

  // ---------------------------------------------------------------- protocols, guards, IPC
  registerProtocolHandlers(protocol, new ProtocolHandlers({
    uiDir: paths.ui,
    sandboxLibDir: paths.sandboxLib,
    blobsDir: paths.blobs,
    appHtml: async (messageId, blockIndex) => {
      await link.rpc.ready(15_000);
      return (await link.rpc.call('blocks.appHtml', { messageId, blockIndex })).html;
    },
    pageHtml: async (name) => {
      await link.rpc.ready(15_000);
      return (await link.rpc.call('pages.read', { name })).html;
    },
  }));
  installSessionGuards(session.defaultSession, {
    media,
    appContentsId: () => mainWindow.contentsId,
    appMainFrame: () => mainWindow.mainFrame,
    screenSources: () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }),
    primaryDisplayId: () => screen.getPrimaryDisplay().id,
    platform,
    log: line => log.line(line),
  });
  registerIpc(ipcMain, desktopIpcDeps({
    windowContentsId: () => mainWindow.contentsId,
    link,
    updates: desktopUpdates,
    renderer,
    media,
    capture,
    showOpenDialog: dialogOptions => {
      const parent = mainWindow.browserWindow;
      return parent ? dialog.showOpenDialog(parent, dialogOptions) : dialog.showOpenDialog(dialogOptions);
    },
    clipboardWrite: text => clipboard.writeText(text),
    openExternal: url => shell.openExternal(url),
    titleBarLayout: layout => mainWindow.setTitleBarLayout(layout),
    log: line => log.line(line),
  }));

  // ---------------------------------------------------------------- power events
  powerMonitor.on('suspend', () => link.power('suspend'));
  powerMonitor.on('resume', () => { link.power('resume'); desktopUpdates.checkIfDue(); });
  powerMonitor.on('lock-screen', () => link.power('lock'));
  powerMonitor.on('unlock-screen', () => link.power('unlock'));
  // B-044: the system ends the session (also with the window closed to the tray) – not an unexpected close.
  watchSessionEnd({ platform, app, powerMonitor, BaseWindow }, () => runMarks.quit('system'), line => log.line(line));

  // ---------------------------------------------------------------- graceful quit
  let quitDone = false;
  const shutdownSteps = () => quitSteps({
    drained: desktopUpdates.draining,
    flushDrafts: () => renderer.prepareRestart(3000),
    disposeUpdates: () => desktopUpdates.dispose(),
    stopRuntime: () => link.stop('quit'),
    releasePower: () => host.releaseAll(),
    destroyTray: () => tray.destroy(),
  });
  app.on('before-quit', event => {
    if (desktopUpdates.blockFailedUpdateQuit()) {
      event.preventDefault();
      log.line('update quit cancelled: installer did not start');
      return;
    }
    if (quitDone) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    runMarks.quit(desktopUpdates.draining ? 'update' : 'person'); // tray Quit, menu, window close and the update install alike
    workStop.dispose();
    hidden.dispose();
    workspaceBrowser?.dispose();
    log.line('quitting');
    const keepRunning = settings.preferences().openAtLogin;
    void runShutdown(shutdownSteps(), { log: line => log.line(line) })
      .then(() => armDueStart(keepRunning, runMarks.by, launcher)) // B-044: next-due.json is settled now (runtime stopped)
      .finally(() => {
        quitDone = true;
        log.close();
        app.quit();
      });
  });

  nativeUpdater.on('before-quit-for-update', () => desktopUpdates.markUpdateQuit());

  // ---------------------------------------------------------------- go
  runtimeHost.start();
  tray.create();
  desktopUpdates.setVisible(!options.background); // tray only: the rarer check interval
  desktopUpdates.start();
  if (!company) settleAfterStart({ dataDir: paths.data, version: app.getVersion(), launcher, log: line => log.line(line) }); // the rename's and updates' leftovers
  if (!options.background) mainWindow.show();
  return { show: () => mainWindow.show() };
}
