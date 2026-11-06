// The page inside one of Autark's phone apps: the Android app (apps/android: its WebView adds "AutarkAndroid/" to the
// user agent) or the iPhone web app (the website's shell, window.autarkHosted – pwa/hosted.ts). What the web UI does
// differently there – no "Install app" row, Back from the app's own Back (window.autarkBack, back.ts; the iPhone app
// calls it from an edge swipe), and "Forget this phone" in the profile menu: the Android app intercepts the autark-app:
// address and asks before it clears its pairing; the iPhone app asks, then clears its own. The apps have no toolbar of
// their own, so the phone looks like the web UI.
// Owns: those facts. Never: talks to the Android app any other way (no JavaScript bridge).

import { hostedShell } from './hosted.ts';

/** The address the app's WebView intercepts for "Forget this phone" (MainActivity / PhoneNavigation). */
export const FORGET_ADDRESS = 'autark-app:forget';

/** True inside the Autark Android app. */
export function isAndroidApp(agent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bAutarkAndroid\//.test(agent);
}

/** True inside the iPhone web app (the website's shell loaded this PC's UI). */
export function inHostedApp(): boolean {
  return hostedShell() !== undefined;
}

/** True inside either phone app (Android or the iPhone web app). */
export function isPhoneApp(): boolean {
  return isAndroidApp() || inHostedApp();
}

/** "Forget this phone": the app asks, then clears its pairing and shows its connect screen. */
export function forgetThisPhone(): void {
  const hosted = hostedShell();
  if (hosted) { void hosted.forget(); return; }
  location.href = FORGET_ADDRESS;
}
