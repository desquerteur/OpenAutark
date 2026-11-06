// The open-browser list of agents' own browsers, read by a browser to-do (tasks/BrowserTodo.tsx).
// browser.list (session.can); it loads on first need and after reconnects, and follows browser.sessions.
// Owns: the list. Never: runs a feed of its own (browser-feed.ts) or draws anything.

import { signal } from '@preact/signals';
import type { BrowserSessionInfo } from '../../shared/model/browser.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { mergeLocal } from './browser-feed.ts';

/** Open agent browsers (browser.list), kept current. */
export const browserSessions = signal<BrowserSessionInfo[]>([]);
let sessionsWatched = false;

export function refreshBrowserSessions(): void {
  if (!can('browser.list')) return;
  rpc.call('browser.list').then((list) => { browserSessions.value = list; }).catch(() => undefined);
}

/** Starts keeping browserSessions current (idempotent; owner only). */
export function watchBrowserSessions(): void {
  if (sessionsWatched || !can('browser.list')) return;
  sessionsWatched = true;
  rpc.on('browser.sessions', ({ open }) => { browserSessions.value = mergeLocal(browserSessions.value, open); });
  rpc.onOpen(refreshBrowserSessions);
  refreshBrowserSessions();
}
