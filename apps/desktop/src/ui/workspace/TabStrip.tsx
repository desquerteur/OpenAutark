// A surface's tab strip, like Chrome's: the tabs of its space (space.ts) and "+" (a new tab) right after the last one. On a
// wide window the global pane's strip is the window's title row (workspace-browser.css); a chat's area has it as its
// first line. A tab is its icon (TabIcon: favicon first), its title and a close cell shown on hover and on the shown tab;
// the tabs share the room (strip-slots.ts cellFit) and below 72 px show their icon only. Nothing moves under the pointer:
// while it is on the tabs or "+" the widths stay, a closed tab keeps its place as an empty one and nothing scrolls by
// itself (strip-slots.ts placeSlots); once it left, or on a "+" click, the tabs close up and a shown tab out of view comes
// into view with the least slide. When even the narrowest tabs do not fit, "+" stays at the room's end and the tabs
// scroll by whole tabs. A tab with sound shows the speaker in its icon's cell, and a click there mutes it. An agent's
// preview tab has its title in italics; a double-click keeps it. A tab of another PC (B-076: its website, its file)
// carries a small blue dot on its icon. Right click: the tab's menu; middle click closes. Left and right move along
// the tabs.
// Owns: the strip's markup, its measuring and its scrolling. Never: which tabs exist (it draws what it is handed).

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useContextMenu } from '../lib/context-menu.tsx';
import { modKey } from '../lib/platform.ts';
import { toastError } from '../lib/toasts.ts';
import { Icon, IconButton } from '../lib/ui.tsx';
import { tabName, type TabInfo } from './browser-model.ts';
import { addPage, closePage, command, selectPage } from './pages.ts';
import { useSpace } from './space.ts';
import { cellFit, hasGhosts, placeSlots, revealTarget, type CellFit, type Slot } from './strip-slots.ts';
import { keepTab, TabIcon, tabMenu, tabTitle } from './TabsMenu.tsx';

const GAP = 2;

const closeTab = (id: string, space: string) => { void closePage(id, space).catch((error) => toastError(error)); };

function Tab(props: { tab: TabInfo; count: number; selected: boolean }) {
  const { tab, selected } = props;
  const space = useSpace();
  const menu = useContextMenu(() => tabMenu(tab, props.count, space));
  const name = tabName(tab);
  return (
    <div class={`browser-strip-tab${selected ? ' selected' : ''}${tab.transient ? ' transient' : ''}${tab.device ? ' remote' : ''}`} data-tab={tab.id} {...menu}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id, space); } }} onDblClick={() => keepTab(tab)}>
      <button type="button" role="tab" class="browser-strip-choose" aria-selected={selected} tabIndex={selected ? 0 : -1} title={tabTitle(tab)} onClick={() => selectPage(tab.id, space)}>
        <span class="browser-tab-icon" aria-hidden="true"><TabIcon tab={tab} /></span>
        <span class="browser-strip-title">{name}</span>
      </button>
      {(tab.audible || tab.muted) && <button type="button" class="browser-strip-sound" aria-label={`${tab.muted ? 'Unmute' : 'Mute'} ${name}`} title={tab.muted ? 'Unmute tab' : 'Mute tab'} tabIndex={-1} onClick={() => void command({ action: 'mute', id: tab.id })} />}
      <button type="button" class="browser-strip-close" aria-label={`Close ${name}`} tabIndex={-1} onClick={() => closeTab(tab.id, space)}><Icon name="x" size={12} /></button>
    </div>
  );
}

export function TabStrip(props: { tabs: readonly TabInfo[]; shown: string | undefined }) {
  const { tabs, shown } = props;
  const space = useSpace();
  const room = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const held = useRef(false);
  const missed = useRef(false); // the shown tab went out of view while the pointer held the strip
  const stale = useRef(false); // the widths waited for the pointer to leave
  const slots = useRef<Slot[]>([]);
  const kept = useRef<CellFit | null>(null);
  const [client, setClient] = useState(0);
  const [letGo, setLetGo] = useState(0);

  useLayoutEffect(() => {
    const element = room.current;
    if (!element) return;
    const measure = () => setClient(Math.floor(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  slots.current = placeSlots(slots.current, tabs.map((tab) => tab.id), held.current);
  const places = slots.current;
  const next = cellFit(client, GAP, tabs.length);
  if (!held.current || !kept.current) { kept.current = next; stale.current = false; } // the widths change only while the pointer is off the tabs
  else if (next.width !== kept.current.width || next.view !== kept.current.view) stale.current = true;
  const fit = kept.current;

  useLayoutEffect(() => { // the shown tab comes into view unless the pointer is on the tabs
    const element = scroller.current;
    if (!element || !client) return;
    const at = places.findIndex((slot) => slot.key === shown);
    if (at < 0) return;
    const start = at * (fit.width + GAP);
    const target = revealTarget(start, start + fit.width, element.scrollLeft, element.clientWidth, element.scrollWidth - element.clientWidth);
    missed.current = held.current && target !== element.scrollLeft;
    if (!held.current) element.scrollLeft = target;
  }, [shown, places.length, fit.width, fit.view, letGo]);

  const onWheel = (event: WheelEvent) => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta || !scroller.current) return;
    event.preventDefault();
    scroller.current.scrollBy({ left: Math.sign(delta) * (fit.width + GAP) });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') || !(event.target as HTMLElement).matches('[role=tab]') || !tabs.length) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === shown);
    const target = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectPage(target.id, space);
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLButtonElement>(`[data-tab="${target.id}"] [role=tab]`)?.focus({ preventScroll: true }));
  };
  const hold = () => { held.current = true; };
  const release = () => { held.current = false; if (hasGhosts(slots.current) || missed.current || stale.current) setLetGo((n) => n + 1); };
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  return (
    <div class="browser-strip" style={{ '--tab-width': `${fit.width}px` }}>
      <div class="browser-strip-room" ref={room}>
        {/* the hold: the tabs and "+" together, so moving from a tab to "+" keeps everything in place */}
        <div class="browser-strip-hold" onPointerEnter={hold} onPointerLeave={release}>
          <div class="browser-strip-tabs" ref={scroller} role="tablist" aria-label="Tabs" style={{ width: `${places.length ? fit.view : 0}px` }} onWheel={onWheel} onKeyDown={onKeyDown}
            onPointerEnter={hold}>
            {places.map((slot) => {
              const tab = byId.get(slot.key);
              return tab ? <Tab key={slot.key} tab={tab} count={tabs.length} selected={slot.key === shown} /> : <span key={slot.key} class="browser-strip-ghost" aria-hidden="true" />;
            })}
          </div>
          {/* its click lays the strip out at once (the new tab shows); back on the tabs the hold starts again */}
          <IconButton icon="plus" label="New tab" title={`New tab (${modKey}T)`} size="small" class="browser-strip-new" onClick={() => { release(); addPage(space); }} />
        </div>
      </div>
    </div>
  );
}
