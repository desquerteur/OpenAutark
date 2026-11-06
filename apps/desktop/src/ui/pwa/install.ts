// PWA page-side helpers: pairing (#pair=<secret>[&to=<route>] or the PC's 6-digit code → device token, then the route),
// the tokenless `POST /rpc` call (pairing, an employee's join: pwa/join.ts),
// service worker registration, install prompt, Web Push subscription, the offline "For you"
// snapshot, SW navigation and the socket check on every push ('wf.wake'), and Back layer by layer (back.ts).
// Inside the iPhone web app (pwa/hosted.ts): the shell's worker instead of /sw.js, /rpc under the shell's base, and the
// notices of read chats closed while the app is in front (Apple gets no clear pushes).
// Owns: everything the browser/phone build needs beyond the shared UI.
// Never: runs inside the Electron window (desktop has the preload bridge), never logs or
// displays the token; the token is kept only in localStorage 'wf.token' (read by lib/rpc.ts).

import { effect, signal } from '@preact/signals';
import type { MethodName, ParamsOf, ResultOf } from '../../shared/api/methods.ts';
import { isPhoneRoute } from '../../shared/api/phone-route.ts';
import { PROTOCOL_VERSION } from '../../shared/api/protocol.ts';
import type { RpcResponse } from '../../shared/api/protocol.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { platform } from '../lib/platform.ts';
import { RpcError, checkAlive, rpc } from '../lib/rpc.ts';
import { conversations, loaded, todos } from '../lib/store.ts';
import { parseRoute, route } from '../lib/router.ts';
import { idbGet, idbSet, TODO_SNAPSHOT_KEY } from './idb.ts';
import { watchPersonMark } from './person-access.ts';
import { startBack } from './back.ts';
import { hostedPath, hostedShell } from './hosted.ts';

const TOKEN_KEY = 'wf.token';

/** Result of the last pairing attempt (shown by the shell when it failed). */
export const pairingError = signal<string | null>(null);

/** One RpcRequest frame without a token via `POST /rpc` (pairing, an employee's join); throws the runtime's error. */
export async function postRpc<M extends MethodName>(method: M, params: ParamsOf<M>, signal?: AbortSignal): Promise<ResultOf<M>> {
  const response = await fetch(hostedPath('/rpc'), {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-workforce-protocol': String(PROTOCOL_VERSION) },
    body: JSON.stringify({ id: 1, method, params }),
  });
  const frame = (await response.json()) as RpcResponse;
  if (frame.error) throw new RpcError(frame.error);
  return frame.result as ResultOf<M>;
}

/** Stores the device token the PC issued (lib/rpc.ts reads it on every connect). */
export function storeDeviceToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** The name this browser gives itself ("Android · Chrome"); the person may rename it on the PC. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  return browser ? `${os} · ${browser}` : os;
}

/** The app route a pairing link carries (`&to=#/chat/<id>`, DEV5B); only plain app routes count. */
export function linkRoute(hash: string): string | undefined {
  const match = /(?:^#|&)to=([^&]+)/.exec(hash);
  if (!match) return undefined;
  try {
    const value = decodeURIComponent(match[1]);
    return isPhoneRoute(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads `#pair=<secret>` from the URL, exchanges it for a device token and stores it, then opens
 * the link's route (`&to=`). The exchange is a tokenless call (`POST /rpc`). Must run before
 * rpc.start() so the WebSocket Hello carries the new token.
 */
export async function pairFromFragment(): Promise<boolean> {
  const match = /(?:^#|&)pair=([^&]+)/.exec(location.hash);
  if (!match) return false;
  const secret = decodeURIComponent(match[1]);
  const target = linkRoute(location.hash);
  // Never leave the secret in the URL; the route (if any) stays.
  history.replaceState(null, '', location.pathname + location.search + (target ?? ''));
  if (target) route.value = parseRoute(target);
  pairingError.value = await pairWith(secret);
  return pairingError.value === null;
}

/** Trades a pairing secret or the PC's 6-digit code (B-075: an installed iPhone app types it) for a stored device token; null, or why not. */
export async function pairWith(secret: string): Promise<string | null> {
  try {
    const { token } = await postRpc('pwa.exchange', { secret, name: deviceName() });
    if (!token) throw new Error('Pairing failed.');
    storeDeviceToken(token);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Pairing failed.';
  }
}

export function hasDeviceToken(): boolean {
  try { return Boolean(localStorage.getItem(TOKEN_KEY)); } catch { return false; }
}

// ------------------------------------------------------------------ service worker

let registration: ServiceWorkerRegistration | null = null;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (platform === 'desktop' || !('serviceWorker' in navigator) || !isSecureContext) return null;
  try {
    // Inside the iPhone web app the shell's own worker controls this page (ui/hosted/sw.ts): no /sw.js of the PC here.
    registration = hostedShell() ? await navigator.serviceWorker.ready : await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type === 'wf.wake') checkAlive(); // a push arrived: the socket must be live to bring it
      if (data?.type === 'wf.navigate' && data.url) {
        const target = new URL(data.url, location.origin);
        if (target.hash) {
          history.pushState(null, '', target.hash);
          route.value = parseRoute(target.hash);
        }
      }
    });
    return registration;
  } catch (error) {
    console.warn('[pwa] service worker registration failed', error);
    return null;
  }
}

// ------------------------------------------------------------------ install prompt

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Set when the browser offers installation (Chromium); iOS uses "Add to Home Screen". */
export const installAvailable = signal(false);
let deferredPrompt: BeforeInstallPromptEvent | null = null;

function watchInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    installAvailable.value = true;
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; installAvailable.value = false; });
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  installAvailable.value = false;
  return outcome === 'accepted';
}

export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

// ------------------------------------------------------------------ web push

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Notifications of this browser: 'on' only when the PC holds its subscription (DEV5A). */
export type PushStatus = 'on' | 'off' | 'blocked' | 'unsupported' | 'insecure';
export interface PushResult { ok: boolean; message: string }

/** Why this browser cannot get notifications at all (undefined = it can). */
function pushBlocker(): 'unsupported' | 'insecure' | undefined {
  if (!isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return undefined;
}

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  return registration ?? (await registerServiceWorker());
}

/** True when `subscription` was made with `key` (a reset PC has a new VAPID key). */
function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const used = subscription.options?.applicationServerKey;
  if (!used) return true; // the browser does not tell: keep it
  const bytes = new Uint8Array(used);
  return bytes.length === key.length && bytes.every((value, index) => value === key[index]);
}

/** This browser's notification state; 'on' is asked from the PC, a granted permission alone is not enough. */
export async function pushStatus(): Promise<PushStatus> {
  const blocker = pushBlocker();
  if (blocker) return blocker;
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await swRegistration();
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return 'off';
  const config = await rpc.call('pwa.pushConfig', { endpoint: subscription.endpoint });
  return config.subscribed ? 'on' : 'off';
}

/** Asks for notification permission and registers this browser for Web Push; says what went wrong. */
export async function enablePush(): Promise<PushResult> {
  const blocker = pushBlocker();
  if (blocker === 'insecure') return { ok: false, message: 'Notifications need HTTPS. Open the app through the HTTPS address.' };
  if (blocker === 'unsupported') {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return { ok: false, message: ios ? 'On iPhone, add the app to the Home Screen first, then turn notifications on there.' : 'This browser cannot show notifications.' };
  }
  // First, while the tap still counts as the person's gesture (iOS refuses a request that comes after a round trip).
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, message: 'Notifications are blocked for this site in the browser settings.' };
  const reg = await swRegistration();
  if (!reg) return { ok: false, message: 'The app could not start its background worker.' };
  try {
    const config = await rpc.call('pwa.pushConfig');
    if (!config.pushReady || !config.vapidPublicKey) return { ok: false, message: config.reason ?? 'The PC cannot send notifications right now.' };
    const key = base64UrlToBytes(config.vapidPublicKey);
    let subscription = await reg.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await rpc.call('pwa.pushSubscribe', { subscription: subscription.toJSON() });
    return { ok: true, message: 'Notifications on' };
  } catch (error) {
    return { ok: false, message: `Could not turn notifications on: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Removes this browser's subscription from the PC and from the browser. */
export async function disablePush(): Promise<PushResult> {
  try {
    const subscription = await (await swRegistration())?.pushManager.getSubscription();
    await rpc.call('pwa.pushUnsubscribe', subscription ? { endpoint: subscription.endpoint } : undefined);
    await subscription?.unsubscribe();
    return { ok: true, message: 'Notifications off' };
  } catch (error) {
    return { ok: false, message: `Could not turn notifications off: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The iPhone web app: Apple's push service gets no `{clear}` pushes (iOS revokes a subscription that receives pushes
 * without a notice – runtime/pwa/read-clear.ts), so the notices of chats that are read by now close here whenever the
 * app is in front: when it comes back and whenever the chat list changes. Returns how many it closed.
 */
export async function closeReadNotices(reg: Pick<ServiceWorkerRegistration, 'getNotifications'> | null = registration, chats = conversations.peek()): Promise<number> {
  const read = new Set(chats.filter((chat) => chat.unread === 0).map((chat) => `chat:${chat.id}`));
  let closed = 0;
  for (const notice of (await reg?.getNotifications?.().catch(() => [])) ?? []) {
    if (notice.tag && read.has(notice.tag)) { notice.close(); closed++; }
  }
  return closed;
}

function watchReadNotices(): void {
  if (!hostedShell()) return;
  const visible = () => document.visibilityState === 'visible';
  document.addEventListener('visibilitychange', () => { if (visible()) void closeReadNotices(); });
  effect(() => { void conversations.value; if (visible()) void closeReadNotices(); });
}

// ------------------------------------------------------------------ offline snapshot

/** Every to-do of the list, the "Later" ones too: App.tsx splits them at the time it shows the copy (F04). */
export interface TodoSnapshot { at: number; items: TaskView[] }

/**
 * The last "For you" list this page knew – what App.tsx shows read-only while the PC is away or
 * refuses this phone. Kept current by watchTodoSnapshot on every change (not debounced, so a
 * refusal right after a change still shows it); main.tsx seeds it from IndexedDB at boot. Null on desktop.
 */
export const offlineSnapshot = signal<TodoSnapshot | null>(null);

/** The newest stored snapshot: IndexedDB's, unless this page already holds a newer one. */
export function readTodoSnapshot(): Promise<TodoSnapshot | undefined> {
  return idbGet<TodoSnapshot>(TODO_SNAPSHOT_KEY).catch(() => undefined).then((stored) => {
    const current = offlineSnapshot.peek();
    return current && (!stored || current.at >= stored.at) ? current : stored;
  });
}

function writeTodoSnapshot(snapshot: TodoSnapshot): Promise<void> {
  return idbSet(TODO_SNAPSHOT_KEY, snapshot);
}

/**
 * Mirrors the live "For you" list into `offlineSnapshot` (at once) and IndexedDB (debounced) so
 * it opens offline. Only after the first successful load: before it – and while a reload fails,
 * which leaves the list untouched – `todos` is not the person's list, and an empty boot list must
 * never replace the snapshot. Every later change (a reload, an event delta, an answer) is mirrored.
 * Returns a stop function (tests; the app keeps it for the page's lifetime).
 */
export function watchTodoSnapshot(write: (snapshot: TodoSnapshot) => Promise<void> = writeTodoSnapshot, delayMs = 1500): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = effect(() => {
    const items = todos.value;
    if (!loaded.value) return;
    const snapshot: TodoSnapshot = { at: Date.now(), items };
    offlineSnapshot.value = snapshot;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void write(snapshot).catch(() => undefined); }, delayMs);
  });
  return () => {
    stop();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/**
 * Entry for the browser/phone build. Call (and await) before rpc.start():
 * pairs from the URL fragment, then registers the service worker and the PWA helpers.
 */
export async function startPwa(): Promise<void> {
  if (platform === 'desktop') return;
  await pairFromFragment();
  watchInstallPrompt();
  void registerServiceWorker();
  watchTodoSnapshot();
  watchPersonMark(); // F-52: a person's token – a removed person sees their own screen (AccessRequest.tsx)
  startBack(); // B-078: one Back layer by layer (the Android app calls window.autarkBack, the iPhone app an edge swipe)
  watchReadNotices();
}
