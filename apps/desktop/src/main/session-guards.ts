// Session-wide permission handlers (the app window uses the default session): microphone and
// camera only for our page while armed, screen sharing (getDisplayMedia) only while video is
// armed, copy/fullscreen for our page, everything else (devices, notifications, geolocation,
// external protocols, mini-app frames) denied. Plus guards for every other webContents.
// Owns: applying security.ts decisions to Electron's handler signatures. Never: decides rules.

import type { App, DesktopCapturerSource, Session, WebContents } from 'electron';
import { allowPermissionCheck, allowPermissionRequest, isAppUrl } from './security.ts';
import type { MediaArm } from './security.ts';

export interface GuardDeps {
  media: MediaArm;
  /** webContents id of our window (null when closed). */
  appContentsId(): number | null;
  /** The window's main frame object, to recognise getDisplayMedia from the page itself. */
  appMainFrame(): unknown;
  /** desktopCapturer.getSources for screens. */
  screenSources(): Promise<DesktopCapturerSource[]>;
  primaryDisplayId(): number;
  platform: string;
  log?(line: string): void;
}

function fromApp(contents: WebContents | null | undefined, deps: GuardDeps): boolean {
  const id = deps.appContentsId();
  return Boolean(contents && id !== null && contents.id === id);
}

export function installSessionGuards(session: Session, deps: GuardDeps): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const trusted = fromApp(contents, deps) && details.isMainFrame && isAppUrl(details.requestingUrl);
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const granted = allowPermissionRequest({ trusted, permission, mediaTypes }, deps.media);
    if (!granted && permission !== 'clipboard-sanitized-write') deps.log?.(`denied permission ${permission}`);
    callback(granted);
  });

  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const trusted = fromApp(contents, deps) && details.isMainFrame && isAppUrl(details.requestingUrl ?? details.securityOrigin);
    return allowPermissionCheck({ trusted, permission, mediaType: details.mediaType }, deps.media);
  });

  // HID / serial / USB / Bluetooth: never.
  session.setDevicePermissionHandler(() => false);

  session.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame;
    const trusted = frame !== null && frame === deps.appMainFrame() && isAppUrl(frame.url);
    if (!trusted || !request.videoRequested || !deps.media.armed('video')) { callback(null); return; }
    void deps.screenSources().then(sources => {
      const primary = String(deps.primaryDisplayId());
      const source = sources.find(item => item.display_id === primary) ?? sources[0];
      if (!source) { callback(null); return; }
      // System audio only where Chromium supports loopback capture (Windows) and when asked for.
      const audio = request.audioRequested && deps.media.armed('audio') && deps.platform === 'win32' ? 'loopback' : undefined;
      try { callback(audio ? { video: source, audio } : { video: source }); } catch { /* frame gone */ }
    }, () => callback(null));
  });
}

/** Every webContents (also devtools and anything unexpected): no popups, no <webview>. */
export function guardAllContents(app: App): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', event => event.preventDefault());
  });
}
