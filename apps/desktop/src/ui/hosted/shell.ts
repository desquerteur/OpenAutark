// Entry of the iPhone web app (B-078 follow-up; built to apps/website/src/app/shell.js, served at the website's appUrl –
// an origin of its own, since storage and keys belong to the origin): an iPhone without an Apple developer account
// installs it with Share → Add to Home Screen. It does what the Android app does:
// pairs with a PC by its Remote ID (pair.ts: the same code on both screens, Accept on the PC), keeps the phone's
// non-extractable key and token (store.ts), holds one encrypted channel to the first of my PCs online through the meeting
// server (connection.ts), and then shows the PC's own UI – "the screens come from your PC": it fetches the PC's '/' over
// the tunnel, checks the `autark-hosted` marker (else "Update Autark on your PC"), and injects the PC's main.css and
// main.js into this document; their relative paths go through the service worker (sw.ts) and bridge.ts. The UI reaches
// back through window.autarkHosted v1 (ui/pwa/hosted.ts): its /ws socket (ws.ts), the base path, frame URLs, Forget.
// Without a tunnel within 4 s it boots from the worker's copy and shows its own "connecting" state. Every start step
// that fails says so on screen (no endless spinner, one reload at most for the worker); the code screen keeps the
// screen awake and the wait survives a lock; Forget removes this phone on the PC first (phone.forget, ≤ 3 s); a PC that
// refuses the token shows "This phone was removed", PCs that stop answering add Forget to the waiting screen.
// Owns: the start order and the autarkHosted object. Never: logs or shows the token, or runs the PC UI before the marker
// check passed once.

import { DEFAULT_RELAY } from '../../shared/model/relay.ts';
import type { AutarkHosted } from '../pwa/hosted.ts';
import { fromUtf8, utf8 } from './bytes.ts';
import { startBridge } from './bridge.ts';
import { Connection } from './connection.ts';
import { startEdgeBack } from './gesture.ts';
import { httpFetch } from './http.ts';
import { pairByRemoteId, Pairing, phoneName } from './pair.ts';
import { Screens } from './screens.ts';
import { HostedStore, idbBackend, keepsKeys, pcEntry, type HostedUi, type Saved } from './store.ts';
import type { StreamMux } from './streams.ts';
import { StreamSocket } from './ws.ts';

const BASE = new URL('./', location.href).pathname;
/** The meeting server the site was built for (<meta name="autark-relay">, apps/website config.mjs), else the default. */
const RELAY = ((value) => (value && /^wss?:\/\/[^\s"'<>]+$/.test(value) ? value : DEFAULT_RELAY))(document.querySelector<HTMLMetaElement>('meta[name="autark-relay"]')?.content);
const TOKEN_KEY = 'wf.token';
/** One reload for a service worker that has not taken the page yet; a second start without one says why. */
const RELOADED_KEY = 'hs.reloaded';
/** What the connect screen says after a Forget the PC did not confirm. */
const NOTE_KEY = 'hs.note';
const QUICK_MS = 4_000;
const FORGET_MS = 3_000;

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const session = { get: (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } }, set: (key: string, value: string | null) => { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* blocked */ } } };

async function supported(): Promise<string | undefined> {
  if (!('serviceWorker' in navigator)) return 'This browser runs no service workers here. Open Autark from the Home Screen in Safari.';
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign']);
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    return undefined;
  } catch {
    return 'Autark needs iOS 17 or newer: older Safari has none of the keys the encrypted connection to your PC uses.';
  }
}

/** The service worker controls this page; else one reload, then an honest error (never a reload loop). */
async function controlled(): Promise<void> {
  const registration = await navigator.serviceWorker.register('sw.js', { scope: './' });
  void registration.update().catch(() => undefined);
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  if (navigator.serviceWorker.controller) { session.set(RELOADED_KEY, null); return; }
  if (session.get(RELOADED_KEY) !== '1') {
    session.set(RELOADED_KEY, '1');
    location.reload();
    return new Promise<void>(() => undefined); // the reload takes over
  }
  session.set(RELOADED_KEY, null);
  throw new Error('The app’s service worker did not take over this page. Close Autark completely (swipe it away) and open it again.');
}

type WakeLock = { release(): Promise<void> };
const wakeLock = (): Promise<WakeLock | undefined> => {
  const lock = (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<WakeLock> } }).wakeLock;
  return lock ? lock.request('screen').catch(() => undefined) : Promise.resolve(undefined);
};

async function main(screens: Screens): Promise<void> {
  screens.waiting('Starting');
  const reason = await supported();
  if (reason) { screens.unsupported(reason); return; }
  await controlled();
  const backend = idbBackend();
  const store = new HostedStore(backend);
  let saved = await store.load();
  if (!saved && !(await keepsKeys(backend))) {
    screens.unsupported('This browser keeps no keys for web apps here (a private window, or website data blocked in Settings › Safari). Open Autark from the Home Screen in a normal window.');
    return;
  }
  if (!saved && ios() && !standalone()) await new Promise<void>((resolve) => screens.install(resolve));
  if (!saved) saved = await pairScreens(screens, store);
  void navigator.storage?.persist?.().catch(() => false);
  await run(screens, store, saved);
}

/** Connect → code → Accept on the PC; resolves with what was stored. */
function pairScreens(screens: Screens, store: HostedStore): Promise<Saved> {
  return new Promise((resolve) => {
    const ask = (initial = '', failure = '') => {
      screens.connect((remoteId) => void attempt(remoteId), initial);
      if (failure) screens.status(failure);
    };
    const attempt = async (remoteId: string) => {
      const pairing = new Pairing();
      let lock: WakeLock | undefined;
      let showing = false;
      // The person walks to the PC while the code is up: the screen stays on, and a return from a lock checks the socket.
      const back = () => {
        if (document.visibilityState !== 'visible') return;
        pairing.resume?.();
        if (showing) void wakeLock().then((next) => { lock = next; });
      };
      document.addEventListener('visibilitychange', back);
      screens.waiting('Finding your PC');
      screens.status('Reaching the meeting server…');
      try {
        const paired = await pairByRemoteId({
          relay: RELAY, remoteId, name: phoneName(navigator.userAgent, navigator.maxTouchPoints), pairing,
          code: (code, pcName) => { showing = true; void wakeLock().then((next) => { lock = next; }); screens.code(code, pcName, () => pairing.cancel()); },
        });
        const next: Saved = { key: paired.key, deviceId: paired.deviceId, relay: paired.relay, token: paired.token, pcs: paired.pcs };
        try { await store.save(next); } catch {
          throw new Error('This browser did not keep the phone’s key. Your PC may now list an unused iPhone: remove it there (Settings › Devices).');
        }
        try { localStorage.setItem(TOKEN_KEY, paired.token); } catch { /* storage blocked: rpc.ts reads #token */ }
        resolve(next);
      } catch (error) {
        ask(remoteId, error instanceof Error && error.message !== 'Cancelled.' ? error.message : '');
      } finally {
        showing = false;
        document.removeEventListener('visibilitychange', back);
        void lock?.release().catch(() => undefined);
      }
    };
    const note = session.get(NOTE_KEY);
    session.set(NOTE_KEY, null);
    ask('', note ?? '');
  });
}

/** phone.forget on the live channel: true once the PC removed this phone (≤ 3 s). */
async function forgetOnPc(mux: StreamMux, token: string): Promise<boolean> {
  const call = httpFetch(mux, {
    method: 'POST', path: '/rpc',
    headers: [['Authorization', `Bearer ${token}`], ['Content-Type', 'application/json'], ['X-Workforce-Protocol', '1']],
    body: utf8(JSON.stringify({ id: 1, method: 'phone.forget' })),
  }).then(({ head, body }) => head.status === 200 && (JSON.parse(fromUtf8(body)) as { result?: { ok?: unknown } }).result?.ok === true);
  const limit = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FORGET_MS));
  return Promise.race([call.catch(() => false), limit]);
}

async function run(screens: Screens, store: HostedStore, saved: Saved): Promise<void> {
  let hiddenAt = 0;
  /** The PC refused this phone: nothing more loads (the removed screen stays). */
  let gone = false;
  /** Clears everything here and starts over (the PC side is already done, or could not be reached). */
  const clearHere = async (note?: string): Promise<void> => {
    const registration = await navigator.serviceWorker.ready.catch(() => undefined);
    await (await registration?.pushManager?.getSubscription().catch(() => null))?.unsubscribe().catch(() => false);
    connection.stop();
    await store.clear().catch(() => undefined);
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* blocked */ }
    await caches.delete('autark-pc').catch(() => false);
    if (note) session.set(NOTE_KEY, note);
    location.replace(BASE);
  };
  const forget = async (): Promise<void> => {
    const live = connection.mux;
    if (!confirm(live ? 'Forget this phone? It signs out here and on your PCs.' : 'Forget this phone? Your PCs are not reachable now: remove it there too (Settings › Devices).')) return;
    const done = live ? await forgetOnPc(live, saved.token) : false;
    await clearHere(live && !done ? 'Your PC did not confirm the Forget: remove this iPhone there too (Settings › Devices).' : undefined);
  };
  const connection = new Connection({
    saved,
    status: (text) => screens.status(text),
    pcsChanged: (pcs) => void store.savePcs(pcs),
    refused: () => { gone = true; connection.stop(); screens.removed(() => void clearHere()); },
    unanswered: (on) => screens.offerForget(on),
  });
  const hosted: AutarkHosted = {
    v: 1,
    base: BASE,
    socket: (path) => new StreamSocket((ms) => connection.awaitMux(ms), path),
    frameUrl: (path) => `${BASE}${path.replace(/^\//, '')}`,
    forget,
  };
  window.autarkHosted = hosted;
  startBridge(navigator.serviceWorker, (ms) => connection.awaitMux(ms));
  startEdgeBack(document);
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    if ((event.data as { type?: string } | null)?.type === 'wf.wake') connection.nudge();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    connection.nudge(hiddenAt ? Date.now() - hiddenAt : 0);
    hiddenAt = 0;
  });
  window.addEventListener('pageshow', () => connection.nudge());
  window.addEventListener('online', () => connection.nudge(Number.MAX_SAFE_INTEGER));
  screens.waiting(undefined, () => void forget());
  connection.start();
  try { if (localStorage.getItem(TOKEN_KEY) !== saved.token) localStorage.setItem(TOKEN_KEY, saved.token); } catch { /* blocked */ }
  const mux = await connection.awaitMux(QUICK_MS);
  let ui = await store.ui();
  if (gone) return;
  if (mux) {
    const index = await httpFetch(mux, { method: 'GET', path: '/', headers: [['Accept', 'text/html']] }).catch(() => undefined);
    if (index && index.head.status === 200) {
      const entry = pcEntry(fromUtf8(index.body));
      if (!entry) { screens.update(() => void forget()); return; }
      ui = entry;
      await store.saveUi(entry);
    }
  }
  if (gone) return;
  if (!ui) {
    // First start and no tunnel yet: wait for one (the status line says why), then check the marker.
    const late = await new Promise<HostedUi | undefined>((resolve) => {
      const tryAgain = async () => {
        const next = await connection.awaitMux(60_000);
        if (gone) return; // stopped: awaitMux answers at once, so no loop
        if (!next) { void tryAgain(); return; }
        const index = await httpFetch(next, { method: 'GET', path: '/' }).catch(() => undefined);
        if (!index || index.head.status !== 200) { void tryAgain(); return; }
        resolve(pcEntry(fromUtf8(index.body)));
      };
      void tryAgain();
    });
    if (gone) return;
    if (!late) { screens.update(() => void forget()); return; }
    ui = late;
    await store.saveUi(late);
  }
  mount(screens, ui);
}

/**
 * Loads the PC UI into this document; the shell's frame goes once the UI rendered into #app. The two colour-scheme
 * theme-color metas become one without media, so the PC UI's own theme (main.tsx syncThemeColor) drives the bar.
 */
function mount(screens: Screens, ui: HostedUi): void {
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  const current = metas.find((meta) => !meta.media || matchMedia(meta.media).matches)?.content ?? '';
  for (const meta of metas) meta.remove();
  document.head.append(Object.assign(document.createElement('meta'), { name: 'theme-color', content: current }));
  const app = document.getElementById('app') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'app' }));
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = `${BASE}${ui.css}`;
  document.head.append(style);
  const watch = new MutationObserver(() => { if (app.childElementCount) { watch.disconnect(); screens.remove(); } });
  watch.observe(app, { childList: true });
  const script = document.createElement('script');
  script.type = 'module';
  script.src = `${BASE}${ui.js}`;
  script.onerror = () => screens.status('Your PC’s interface did not load. Check that Autark runs there, then open this app again.');
  document.head.append(script);
}

const screens = new Screens(document.body);
main(screens).catch((error: unknown) => screens.failed(error instanceof Error && error.message ? error.message : 'Something on this iPhone stopped the start.'));
