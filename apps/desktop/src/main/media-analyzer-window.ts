// MM4: the Electron side of the media analyzer (media-analyzer.ts): a hidden offscreen window in
// a private in-memory session ('wf-media-analyzer', no cache) whose wf-file:// requests go to the
// analyzer's routes (media-analyzer-routes.ts). The session refuses every permission and device
// and cancels every request that is not for the analyzer's origin; the window has no preload, no
// node, no devtools, no popups, never navigates by itself and plays no sound.
// Owns: the window and session options. Never: imports electron values (hidden-windows.ts injects
// BrowserWindow and session.fromPartition), touches the default session or the app window.

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { ANALYZER_ORIGIN } from './media-analyzer-routes.ts';
import type { AnalyzerWindow, Serve } from './media-analyzer.ts';

/** No "persist:" prefix: the session lives in memory only and is never shared with the app window. */
export const ANALYZER_PARTITION = 'wf-media-analyzer';

export interface ElectronAnalyzerDeps {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow;
  fromPartition(partition: string, options: { cache: boolean }): Session;
}

/** `MediaAnalyzerDeps.open` for Electron; the private session is set up on the first window. */
export function electronAnalyzerWindows(deps: ElectronAnalyzerDeps): (serve: Serve) => AnalyzerWindow {
  let serving: Serve = async () => new Response(null, { status: 410 });
  let prepared: Session | null = null;
  const privateSession = (): Session => {
    if (prepared) return prepared;
    const session = deps.fromPartition(ANALYZER_PARTITION, { cache: false });
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${ANALYZER_ORIGIN}/`) }));
    session.protocol.handle('wf-file', (request) => serving(request));
    prepared = session;
    return session;
  };

  return (serve) => {
    serving = serve;
    const window = new deps.BrowserWindow({
      width: 160, height: 90, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, resizable: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        session: privateSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
        webSecurity: true, webviewTag: false, offscreen: true, backgroundThrottling: false, spellcheck: false, devTools: false,
        safeDialogs: true, navigateOnDragDrop: false, webgl: false, autoplayPolicy: 'user-gesture-required',
      },
    });
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.on('will-navigate', (event) => event.preventDefault()); // only loadURL (the analyzer) moves it
    contents.on('will-frame-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const gone = new Set<() => void>();
    const fire = () => { for (const listener of [...gone]) listener(); };
    contents.on('render-process-gone', fire);
    window.on('closed', fire);
    return {
      load: (url) => window.loadURL(url),
      onGone: (listener) => { gone.add(listener); },
      destroy: () => {
        gone.clear();
        if (!window.isDestroyed()) window.destroy();
      },
    };
  };
}
