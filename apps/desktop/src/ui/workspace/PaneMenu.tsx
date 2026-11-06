// The one menu cell at the end of a surface's address row (and of an agent browser's toolbar): for a website Find in page,
// the zoom (kept per site), Mute, Mark a region, DevTools, Copy address, Open in system browser and Send page to chat;
// on the Screen tab Mark a region; Keep tab on an agent's preview tab; All tabs (the list of the surface's tabs, a popover
// at this cell – TabsMenu.tsx); in the desktop app History (Ctrl+H, a popover at this cell too) and Reopen closed tab; on
// a computer Full view. A fixed cell; the menu is text only, and over a page the native view hides while it is open
// (native-surface.ts).
// Owns: the cell and its items. Never: what they do (pages.ts, send-page.ts, full-view.ts, RegionDialog.tsx).

import { useEffect, useRef, useState } from 'preact/hooks';
import { modKey, openExternal } from '../lib/platform.ts';
import { can } from '../lib/session.ts';
import { isMobile } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { IconButton, Menu, type MenuSection } from '../lib/ui.tsx';
import { fullView, toggleFullView } from './full-view.ts';
import { HistoryPopover } from './HistoryPopover.tsx';
import { browserPages, command, goTo, hasPersonalBrowser, historyAsk, openFind, openWebsite, reopenTab, shownEntry } from './pages.ts';
import { markPage, markScreen } from './RegionDialog.tsx';
import { sendPageToChat } from './send-page.ts';
import { useSpace } from './space.ts';
import { tabInfosOf } from './tab-list.ts';
import { AllTabs, copyAddress, keepTab } from './TabsMenu.tsx';

/** The last history request this window acted on (one made while no menu cell was drawn still counts once). */
let handledHistory = 0;

/** A history row opens in the tab `space` shows when that is a page or a blank tab, else (or asked) in a new one. */
function openFromHistory(space: string, url: string, newTab: boolean): void {
  const shown = shownEntry(space);
  if (!newTab && (shown?.kind === 'website' || shown?.kind === 'new')) void goTo(shown.id, url, space);
  else void openWebsite(url, { space }).catch((error) => toastError(error));
}

export function PaneMenu(props: { id: string | undefined }) {
  const { id } = props;
  const space = useSpace();
  const cell = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [historyAt, setHistoryAt] = useState<HTMLElement | null>(null);
  const [listAt, setListAt] = useState<HTMLElement | null>(null);
  const atCell = () => cell.current?.firstElementChild as HTMLElement | null;
  const showHistory = () => setHistoryAt(atCell());
  const asked = historyAsk.value;
  useEffect(() => {
    if (asked.space !== space || asked.ask === handledHistory) return;
    handledHistory = asked.ask;
    showHistory();
  }, [asked]);
  const tabs = tabInfosOf(space);
  const shownTab = tabs.find((tab) => tab.id === id);
  const kind = shownTab?.kind;
  const website = kind === 'website';
  const page = website ? browserPages.value.find((item) => item.id === id) : undefined;
  const url = page?.url ?? '';
  const full = fullView.value === space;
  const zoom = page?.zoom ?? 100;
  const tab = (action: 'mute' | 'devtools') => { if (id) void command({ action, id }); };
  const zoomTo = (step: 1 | -1 | 0) => { if (id) void command({ action: 'zoom', id, step }); };
  const sections: MenuSection[] = [
    ...(website && id ? [{ items: [
      { label: 'Find in page', hint: `${modKey}F`, onSelect: () => { requestAnimationFrame(() => openFind(space)); } },
      { label: 'Zoom in', hint: `${zoom}%`, disabled: !page, onSelect: () => zoomTo(1) },
      { label: 'Zoom out', disabled: !page, onSelect: () => zoomTo(-1) },
      { label: 'Actual size', disabled: zoom === 100, onSelect: () => zoomTo(0) },
      { label: page?.muted ? 'Unmute tab' : 'Mute tab', disabled: !page, onSelect: () => tab('mute') },
      { label: 'Mark a region', disabled: !url, onSelect: () => void markPage(id) },
      { label: 'DevTools', hint: 'F12', disabled: !page, onSelect: () => tab('devtools') },
    ] }, { items: [
      { label: 'Copy address', disabled: !url, onSelect: () => copyAddress(url) },
      { label: 'Open in system browser', disabled: !url, onSelect: () => openExternal(url) },
      { label: 'Send page to chat', disabled: !url, onSelect: () => void sendPageToChat(id).catch((error) => toastError(error)) },
    ] }] : []),
    ...(kind === 'screen' && can('computer.preview') ? [{ items: [{ label: 'Mark a region', onSelect: () => void markScreen() }] }] : []),
    { items: [
      ...(shownTab?.transient ? [{ label: 'Keep tab', onSelect: () => keepTab(shownTab) }] : []),
      { label: 'All tabs', hint: String(tabs.length), onSelect: () => setListAt(atCell()) },
      ...(hasPersonalBrowser() ? [
        { label: 'History', hint: `${modKey}H`, onSelect: showHistory },
        { label: 'Reopen closed tab', hint: `${modKey}Shift+T`, onSelect: () => void reopenTab(space) },
      ] : []),
    ] },
    ...(!isMobile.value ? [{ items: [{ label: full ? 'Exit full view' : 'Full view', onSelect: () => toggleFullView(space) }] }] : []),
  ];
  return (
    <>
      <span ref={cell} class="browser-menu-cell">
        <IconButton icon="dots-three-vertical" label="Browser menu" title="Menu" size="small" aria-haspopup="menu" aria-expanded={anchor !== null}
          onClick={(event) => setAnchor(anchor ? null : event.currentTarget as HTMLElement)} />
      </span>
      <Menu anchor={anchor} open={anchor !== null} onClose={() => setAnchor(null)} placement="bottom-end" label="Browser menu" sections={sections} />
      <AllTabs anchor={listAt} onClose={() => setListAt(null)} tabs={tabs} shown={id} />
      {hasPersonalBrowser() && <HistoryPopover anchor={historyAt} onClose={() => setHistoryAt(null)} onOpen={(url, newTab) => openFromHistory(space, url, newTab)} />}
    </>
  );
}
