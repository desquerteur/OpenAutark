// Joining an organisation from an invite – the page side (F-52). A page opened from a person's invite
// link or QR code (`#join=<ticket>`) asks at once with that ticket (the address is cleaned first);
// without one the person types the invite's 6-digit code. The waiting is pwa/access.ts
// createAccessFlow (one long request while visible, retries, the ticket kept for this tab) on
// people.join / people.awaitJoin; accepted, the person token is stored,
// the page is marked as a person's (pwa/person-access.ts) and reloads into the app as that person.
// Owns: the join flow of this page and whether the join screen shows. Never: logs or shows the
// ticket or token, or runs on the desktop.

import { signal } from '@preact/signals';
import { createAccessFlow, type AccessFlow } from './access.ts';
import { deviceName, postRpc, storeDeviceToken } from './install.ts';
import { readPersonMark, writePersonMark } from './person-access.ts';

const TICKET = /^[A-Za-z0-9_-]{40,200}$/;
const KEY = 'wf.join';

/** The invite ticket of a `#join=` address, if it is one. */
export function joinTicket(hash: string): string | undefined {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('join') ?? '';
  return TICKET.test(value) ? value : undefined;
}

/** The join screen is shown: the page was opened from an invite, or the person chose "I was invited". */
export const joining = signal<boolean>(typeof location !== 'undefined' && joinTicket(location.hash) !== undefined);

// An invite opened on this same address later (the app's scanner, a pasted link) shows the join screen too.
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => { if (joinTicket(location.hash)) joining.value = true; });

let page: AccessFlow | undefined;

export function pageJoin(): AccessFlow {
  page ??= createAccessFlow({
    request: (name, proof) => postRpc('people.join', { name, ...(proof ?? {}) }),
    wait: (ticket, signal) => postRpc('people.awaitJoin', { ticket }, signal),
    name: deviceName,
    now: () => Date.now(),
    visible: () => document.visibilityState === 'visible',
    watchVisibility: (change) => {
      document.addEventListener('visibilitychange', change);
      return () => document.removeEventListener('visibilitychange', change);
    },
    load: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
    save: (value) => { try { if (value) sessionStorage.setItem(KEY, value); else sessionStorage.removeItem(KEY); } catch { /* storage blocked */ } },
    paired: (token) => {
      storeDeviceToken(token);
      writePersonMark(readPersonMark() ?? {}); // a person's token from now on (pwa/person-access.ts)
      history.replaceState(null, '', `${location.pathname}${location.search}#/`);
      location.reload();
    },
    later: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
    takeTicket: () => {
      const ticket = joinTicket(location.hash);
      if (ticket) history.replaceState(null, '', location.pathname + location.search); // never leave the ticket in the URL
      return ticket;
    },
  });
  return page;
}
