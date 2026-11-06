// Web Push in a service worker, shared by the PC-served PWA (ui/pwa/sw.ts) and the iPhone web app's worker
// (ui/hosted/sw.ts): a push shows its notice (tag, url, id, silent), tells the open app windows to load what changed
// ('wf.wake'), and a tap focuses an open window and routes it in-app ('wf.navigate') or opens one at `home` + the route.
// The PC worker ({home:'/', alwaysShow:false}) shows a notice already open under its tag with the same id (the same
// notification pushed by another of the owner's PCs) not again, and a `{clear: tag}` push (runtime/pwa/read-clear.ts)
// closes that tag's notices and shows nothing. iOS revokes a subscription that gets pushes without a notice, so the
// hosted worker ({alwaysShow:true}) always shows one: a duplicate replaces the open notice quietly, and a clear puts the
// pushed notice back quietly (the PC sends no clear to Apple's push service at all).
// Owns: these handlers. Never: caches, fetches, or opens the origin root unless `home` is it.

export interface NotifyEvent extends Event { waitUntil(promise: Promise<unknown>): void }
export interface PushEvent extends NotifyEvent { data: { json(): unknown; text(): string } | null }
export interface NotificationClick extends NotifyEvent { notification: Notification & { data?: unknown }; action: string }
export interface WindowClientLike { url: string; focus(): Promise<unknown>; postMessage(message: unknown): void }

export interface NotifyScope {
  registration: ServiceWorkerRegistration;
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  location: Location;
  navigator?: unknown;
  addEventListener(type: 'push', fn: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', fn: (event: NotificationClick) => void): void;
}

export interface NotifyOptions {
  /** Where the app lives ('/' on the PC, the hosted scope on the iPhone); a tap opens it plus the notice's route. */
  home: string;
  /** The notice icon. */
  icon: string;
  /** Every push shows a notice (iOS): duplicates replace quietly, a clear shows its notice quietly. */
  alwaysShow: boolean;
}

/** `clear`: the chat or to-do with this tag was read on some device (runtime/pwa/read-clear.ts). */
export interface PushPayload { title?: string; body?: string; url?: string; tag?: string; kind?: string; silent?: boolean; id?: string; clear?: string }

export function wireNotifications(sw: NotifyScope, options: NotifyOptions): void {
  const notices = async (tag?: string) => (await sw.registration.getNotifications?.(tag ? { tag } : undefined).catch(() => [])) ?? [];

  /** The app icon's badge counts the notices still open. */
  async function badge(): Promise<void> {
    const left = (await notices()).length;
    const nav = sw.navigator as { setAppBadge?(count?: number): Promise<void>; clearAppBadge?(): Promise<void> } | undefined;
    await (left ? nav?.setAppBadge?.(left) : nav?.clearAppBadge?.())?.catch(() => undefined);
  }

  async function clearPush(tag: string): Promise<void> {
    for (const old of await notices(tag)) old.close();
    await badge();
  }

  /**
   * A newer notice for the same to-do or chat (same tag) replaces the older one and still alerts (renotify in Chromium;
   * closing the old one first covers browsers that ignore it). renotify without a tag would throw.
   */
  async function showPush(payload: PushPayload, quiet = false): Promise<void> {
    const tag = payload.tag || undefined;
    const open = tag ? await notices(tag) : [];
    const duplicate = Boolean(payload.id && open.some((old) => (old.data as { id?: unknown } | undefined)?.id === payload.id));
    if (duplicate && !options.alwaysShow) return; // once within this origin, not across PCs
    const silent = quiet || duplicate || payload.silent === true; // F-52: a person's "Sound" off (pwa/push.ts sendToPerson)
    for (const old of open) old.close();
    const shown: NotificationOptions & { renotify?: boolean } = {
      body: payload.body ?? '',
      icon: options.icon,
      badge: options.icon,
      tag,
      renotify: Boolean(tag) && !quiet && !duplicate,
      silent,
      data: { url: payload.url ?? '/', ...(payload.id ? { id: payload.id } : {}) },
    };
    await sw.registration.showNotification(payload.title ?? 'Autark', shown);
  }

  /** Every push tells the open app windows that something changed (ui/pwa/install.ts loads it at once). */
  async function wake(): Promise<void> {
    for (const client of await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'wf.wake' });
  }

  sw.addEventListener('push', (event) => {
    let payload: PushPayload = {};
    try { payload = (event.data?.json() as PushPayload) ?? {}; } catch { payload = { body: event.data?.text() }; }
    if (typeof payload.clear === 'string' && payload.clear) {
      const shown = options.alwaysShow ? clearPush(payload.clear).then(() => showPush({ ...payload, tag: payload.tag || payload.clear }, true)) : clearPush(payload.clear);
      event.waitUntil(Promise.all([shown, wake()]));
      return;
    }
    event.waitUntil(Promise.all([showPush(payload), wake()]));
  });

  sw.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = String((event.notification.data as { url?: string } | undefined)?.url ?? '/');
    const home = new URL(options.home, sw.location.origin);
    // The notice carries a PC route ('/#/chat/<id>'): its hash under this app's home (the hosted app never opens the origin root).
    const hash = new URL(url, home).hash;
    const target = hash ? new URL(hash, home).href : options.home === '/' ? new URL(url, home).href : home.href;
    event.waitUntil((async () => {
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => new URL(client.url).origin === sw.location.origin && new URL(client.url).pathname.startsWith(home.pathname));
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'wf.navigate', url: target }); // the page routes in-app (no reload)
        return;
      }
      await sw.clients.openWindow(target);
    })());
  });
}
