// A tab's icon, its right-click menu and the list of all tabs. The list (All tabs in the surface's menu, PaneMenu.tsx) is
// a popover at the menu cell: one row per tab (TabIcon, name, ×), the shown tab marked, in reserved columns so a closed tab
// moves nothing else; up and down move through the rows, the list closes with a choice. A tab's menu (the strip and the
// list use the same): Keep tab for an agent's preview tab, Close, Close others, Mute, Copy address, Open in system
// browser, Show download (lib/context-menu.tsx).
// Owns: the icon, the menu and the list. Never: which tabs exist (pages.ts, tab-list.ts).

import { useEffect, useRef } from 'preact/hooks';
import { useContextMenu } from '../lib/context-menu.tsx';
import { openExternal } from '../lib/platform.ts';
import { agentName } from '../lib/store.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { AgentAvatar, Icon, IconButton, Popover, Spinner, type IconName, type MenuSection } from '../lib/ui.tsx';
import { tabName, type TabInfo, type TabKind } from './browser-model.ts';
import { closeOthers, closePage, command, selectPage } from './pages.ts';
import { useSpace } from './space.ts';

const KIND_ICON: Record<TabKind, IconName> = { new: 'globe', website: 'globe', day: 'sun', work: 'list-checks', activity: 'chart-bar', agent: 'browsers', notes: 'file-text', media: 'image', video: 'play', screen: 'monitor', file: 'file', folder: 'folder', page: 'app-window', remote: 'globe' };

export function copyAddress(url: string): void {
  navigator.clipboard.writeText(url).then(() => pushToast({ title: 'Copied', tone: 'info' }, 1500), (error: unknown) => toastError(error, 'Could not copy'));
}

/** An agent's preview tab becomes a tab of its own (a double-click on it, Keep tab). */
export function keepTab(tab: TabInfo): void {
  if (tab.transient) void command({ action: 'keep', id: tab.id });
}

/** What a tab shows in its 16 px cell: the speaker while it plays sound or is muted, an agent's own browser its avatar, a spinner while loading, the page's icon, else its kind's. */
export function TabIcon(props: { tab: TabInfo }) {
  const { tab } = props;
  if (tab.muted) return <Icon name="speaker-slash" size={16} />;
  if (tab.audible) return <Icon name="speaker-high" size={16} />;
  if (tab.agentId) return <AgentAvatar agentId={tab.agentId} size={16} />;
  if (tab.loading) return <Spinner size={12} />;
  if (tab.favicon) return <img src={tab.favicon} width={16} height={16} alt="" />;
  return <Icon name={KIND_ICON[tab.kind]} size={16} />;
}

/** A tab's tooltip: its name and address, the agent that opened it, and what a preview tab is. */
export function tabTitle(tab: TabInfo): string {
  return [
    tabName(tab), tab.url,
    tab.opener ? `Opened by ${agentName(tab.opener.agentId)}` : '',
    tab.transient ? "Preview – the agent's next page replaces it; double-click to keep" : '',
  ].filter(Boolean).join('\n');
}

/** A tab's right-click menu; `count`: how many tabs its space has. */
export function tabMenu(tab: TabInfo, count: number, space: string): MenuSection[] {
  return [{ items: [
    ...(tab.transient ? [{ label: 'Keep tab', onSelect: () => keepTab(tab) }] : []),
    { label: 'Close', onSelect: () => void closePage(tab.id, space).catch((error) => toastError(error)) },
    { label: 'Close others', disabled: count < 2, onSelect: () => void closeOthers(tab.id, space).catch((error) => toastError(error)) },
    ...(tab.kind === 'website' ? [{ label: tab.muted ? 'Unmute tab' : 'Mute tab', onSelect: () => void command({ action: 'mute', id: tab.id }) }] : []),
    { label: 'Copy address', disabled: !tab.url, onSelect: () => copyAddress(tab.url) },
    { label: 'Open in system browser', disabled: !tab.url, onSelect: () => openExternal(tab.url) },
    ...(tab.download?.state === 'saved' ? [{ label: 'Show download', onSelect: () => void command({ action: 'reveal', id: tab.id }) }] : []),
  ] }];
}

function Row(props: { tab: TabInfo; count: number; space: string; selected: boolean; onChoose: () => void }) {
  const { tab, space } = props;
  const menu = useContextMenu(() => tabMenu(tab, props.count, space));
  const name = tabName(tab);
  return (
    <div class={`browser-tab-row${props.selected ? ' selected' : ''}${tab.transient ? ' transient' : ''}`} {...menu}>
      <button type="button" role="menuitem" class="menu-item" aria-current={props.selected ? 'true' : undefined} title={tabTitle(tab)} onClick={props.onChoose}>
        <span class="browser-tab-icon" aria-hidden="true"><TabIcon tab={tab} /></span>
        <span class="menu-label"><span>{name}</span>{tab.host && tab.host !== name && <small>{tab.host}</small>}</span>
      </button>
      <IconButton icon="x" label={`Close ${name}`} size="small" class="browser-tab-close" onClick={() => void closePage(tab.id, space).catch((error) => toastError(error))} />
    </div>
  );
}

/** All tabs of the surface's space, a popover at `anchor` (the menu cell) while it is set. */
export function AllTabs(props: { anchor: HTMLElement | null; onClose: () => void; tabs: readonly TabInfo[]; shown: string | undefined }) {
  const { tabs, anchor } = props;
  const space = useSpace();
  const list = useRef<HTMLDivElement>(null);
  const rows = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('button[role=menuitem]') ?? [])];
  useEffect(() => {
    if (anchor) requestAnimationFrame(() => (rows().find((row) => row.getAttribute('aria-current') === 'true') ?? rows()[0])?.focus({ preventScroll: true }));
  }, [anchor]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = rows();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus({ preventScroll: true });
  };
  return (
    <Popover anchor={anchor} open={anchor !== null} onClose={props.onClose} placement="bottom-end" role="menu" label="Tabs" class="menu browser-tabs-menu" width={300}>
      <div ref={list} onKeyDown={onKeyDown}>
        {tabs.map((tab) => <Row key={tab.id} tab={tab} count={tabs.length} space={space} selected={tab.id === props.shown} onChoose={() => { props.onClose(); selectPage(tab.id, space); }} />)}
      </div>
    </Popover>
  );
}
