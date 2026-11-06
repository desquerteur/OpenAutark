// B-044 "Keep agents running": the system ending the session – shutdown, restart, log-off, and Windows
// Fast Startup, which logs the person off – is a deliberate end, not an unexpected close. The quit mark
// {state: 'quit', by: 'system'} must be in run-state.json before the process dies; `ended` writes it
// synchronously (launcher.ts RunStateMarks, the first mark of a process wins). Linux: powerMonitor
// 'shutdown' (logind's PrepareForShutdown). Not on macOS: Electron emits 'shutdown' there on every
// [NSApp terminate:] – Cmd+Q and the Dock's Quit too – so the person's quit would read as the system's and
// the launcher would start the app again; an ending macOS session quits the app through before-quit
// (marked as a quit) and the login item starts it at the next sign-in. Windows has no such event: a
// window's 'session-end' (WM_ENDSESSION, only when the session really ends) is the signal, and the
// person's window is destroyed when it is closed to the tray – so one hidden native window without web
// contents (BaseWindow: never shown, no taskbar entry, no renderer process) lives as long as the app to
// receive it; every BrowserWindow gets the handler as well.
// Owns: watching for the end of the session. Never: writes the file itself, quits the app or delays the
// session end (no 'query-session-end' handler: a cancelled shutdown would leave a wrong mark).

import type { App, BaseWindow, PowerMonitor } from 'electron';

export interface SessionEndElectron {
  platform: string;
  app: Pick<App, 'on'>;
  powerMonitor: Pick<PowerMonitor, 'on'>;
  BaseWindow: typeof BaseWindow;
}

let watcher: BaseWindow | undefined; // held for the app's lifetime

/** Calls `ended` (synchronously, once per event) when the system ends the session; never throws. */
export function watchSessionEnd(electron: SessionEndElectron, ended: () => void, log?: (line: string) => void): void {
  if (electron.platform === 'linux') electron.powerMonitor.on('shutdown', () => ended());
  if (electron.platform !== 'win32') return;
  electron.app.on('browser-window-created', (_event, window) => { window.on('session-end', () => ended()); });
  try {
    watcher = new electron.BaseWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false });
    watcher.on('session-end', () => ended());
  } catch (error) {
    log?.(`session end window not created: ${(error as Error)?.message ?? 'error'}`); // an open window still reports it
  }
}
