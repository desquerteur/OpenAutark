// The phone's side pane is its PC's (B-076, owner 05.11.2026: "Mach das es bitte auch am Handy gut funktioniert"): the
// PWA reads the PC's spaces (tabs.get) and follows each change (event tabs.changed) – the PC's websites are 'remote'
// tabs of that PC (their live picture: RemoteWebTab.tsx), its files show their content – and what the person changes
// here (open, close, reorder, choose) goes back (tabs.set): each space that differs from the PC's, and the remote tabs
// no space here lists any more, so a tab the PC opened meanwhile stays. A blank tab stays on the phone and leaves the
// PC's shown tab as it is; a blank tab shown on the PC (its space names no shown tab) leaves the phone's as it is, and
// that one never goes back to pull the PC's away. While the connection is down nothing goes: the read on reconnect
// brings the PC's spaces as they are now, so a stale whole space never replaces newer tabs. Nothing of it is kept on
// the phone.
// Owns: that link. Never: tab logic (pages.ts) or a tab's picture.

import '../../shared/api/methods-tabs.ts';
import type { PaneTabs } from '../../shared/api/methods-tabs.ts';
import type { SideSpace, SideSpaces } from '../../shared/api/workspace-browser.ts';
import { bridge } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';
import { fromSideSpace, toSideSpace } from './browser-model.ts';
import { acceptLayout, linkPhone, pagesListed, shownOf } from './pages.ts';

/** This pane shows its PC's side pane: no browser of its own here, and the session reads the PC's. */
export function phonePane(): boolean {
  return !bridge?.workspaceBrowser && can('tabs.get');
}

/** A space as this pane would send it back (what it shows of it, in its order). */
const normal = (space: SideSpace | undefined): SideSpace => (space ? toSideSpace(fromSideSpace(space), space.shown ?? '') : { tabs: [] });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What goes to the PC after `next` (this pane's spaces): each space that differs from `known` (the PC's), and the remote tabs closed here. */
export function phoneChanges(known: SideSpaces, next: SideSpaces): { spaces: SideSpaces; closed: string[] } | undefined {
  const spaces: SideSpaces = {};
  for (const key of new Set([...Object.keys(known), ...Object.keys(next)])) {
    const before = normal(known[key]);
    let mine = next[key] ?? { tabs: [] };
    // a blank tab shown here leaves the PC's choice as it is
    if (mine.shown === undefined && before.shown !== undefined && mine.tabs.some((tab) => tab.id === before.shown)) mine = { shown: before.shown, tabs: mine.tabs };
    if (!same(before, normal(mine))) spaces[key] = mine;
  }
  if (!Object.keys(spaces).length) return undefined;
  const listed = new Set(Object.values(next).flatMap((space) => space.tabs.map((tab) => tab.id)));
  const closed = Object.values(known).flatMap((space) => space.tabs).filter((tab) => tab.panel === 'remote' && !listed.has(tab.id)).map((tab) => tab.id);
  return { spaces, closed: [...new Set(closed)] };
}

let started = false;

/** Keeps this pane in step with its PC (idempotent; the phone only). */
export function watchPhoneTabs(): void {
  if (started || !phonePane()) return;
  started = true;
  let known: SideSpaces | undefined;
  const send = (layout: SideSpaces) => {
    const change = known && phoneChanges(known, layout);
    if (!change) return;
    known = { ...known, ...change.spaces }; // what the PC holds once it took it (its tabs.changed follows)
    rpc.call('tabs.set', change).catch((error: unknown) => toastError(error, 'The PC did not take that tab change'));
  };
  const take = (pane: PaneTabs) => {
    // first: taking them over below sends nothing back – where the PC shows a blank tab, the tab shown here stays
    // (acceptLayout) and counts as the PC's
    known = Object.fromEntries(Object.entries(pane.spaces).map(([key, space]) => [key, space.shown === undefined && shownOf(key) ? { ...space, shown: shownOf(key) } : space]));
    linkPhone({ device: pane.device, send });
    acceptLayout(pane.spaces);
    pagesListed.value = true;
  };
  const read = () => { rpc.call('tabs.get').then(take, () => undefined); };
  rpc.status.subscribe((status) => { if (status !== 'open') known = undefined; }); // nothing goes until the next read
  rpc.on('tabs.changed', take);
  rpc.onOpen(read);
  read();
}
