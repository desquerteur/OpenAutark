// What a blank tab shows under the address field: the panels it can become – Notes, Media, Files, Agents, on a wide
// window also My day and Work beside a chat – and the views anyone added in <data>/pages. B-078 cut Activity (Team ›
// Activity and Work's report hold it) and Screen (a view of the PC one sits at; the AI sees screens with its own tools);
// on the phone My day and Work are its bottom tabs already, so its sheet offers only the rest. Existing Activity and
// Screen tabs still open. A panel takes the blank tab's place in the strip of its own
// surface (pages.ts openPanel, the space from space.ts). Notes opens the open chat's notes, or lists the chats to choose
// from; Media is the library with its search (MediaLibrary.tsx); Files opens the data folder; Agents lists the agents –
// "Browsing now" marks one whose own browser is open – and opens an agent's own browser. The rows are plain text with their
// icon; hover and press change colour only.
// Owns: that page and its lists. Never: tab logic (pages.ts) or what a panel shows.

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { chatTitle } from '../lib/chat-face.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';
import { activeConversationId, agents, conversations, isMobile } from '../lib/store.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import { AgentAvatar, EmptyState, Icon, type IconName } from '../lib/ui.tsx';
import { canOpenChat } from '../tasks/jump.ts';
import { byActivity } from '../chat/list-order.ts';
import type { AppTab } from './browser-model.ts';
import { browserSessions, watchBrowserSessions } from './BrowserTab.tsx';
import { openFileTab, openFolderTab, pathMenu } from './file-tabs.ts';
import { openPanel } from './pages.ts';
import { useSpace } from './space.ts';
import { userPages } from './user-pages.ts';

type Chooser = 'notes' | 'agents';

export function Row(props: { icon?: IconName; lead?: ComponentChildren; label: string; hint?: string; disabled?: boolean; menu?: ReturnType<typeof useContextMenu>; onClick: () => void }) {
  return (
    <li>
      <button type="button" class="new-tab-row" disabled={props.disabled} {...props.menu} onClick={props.onClick}>
        <span class="new-tab-icon" aria-hidden="true">{props.lead ?? <Icon name={props.icon!} size={16} />}</span>
        <span class="new-tab-label">{props.label}</span>
        {props.hint && <span class="new-tab-hint">{props.hint}</span>}
      </button>
    </li>
  );
}

function ChatList(props: { id: string; space: string }) {
  const chats = conversations.value.filter((chat) => canOpenChat(chat.id)).sort(byActivity).slice(0, 40);
  if (!chats.length) return <EmptyState>No chats yet.</EmptyState>;
  return <ul class="new-tab-list">{chats.map((chat) => <Row key={chat.id} icon="file-text" label={chatTitle(chat)} onClick={() => openPanel({ kind: 'notes', conversationId: chat.id }, props.id, props.space)} />)}</ul>;
}

function AgentList(props: { id: string; space: string }) {
  useEffect(() => { watchBrowserSessions(); }, []);
  const list = agents.value.filter((agent) => agent.archivedAt === undefined);
  const browsing = new Set(browserSessions.value.map((session) => session.agentId));
  if (!list.length) return <EmptyState>No agents yet.</EmptyState>;
  return (
    <ul class="new-tab-list">
      {list.map((agent) => <Row key={agent.id} lead={<AgentAvatar agentId={agent.id} size={20} />} label={agent.name} hint={browsing.has(agent.id) ? 'Browsing now' : agent.role}
        onClick={() => openPanel({ kind: 'agent', agentId: agent.id }, props.id, props.space)} />)}
    </ul>
  );
}

/** A view from <data>/pages; a right click opens its file. */
function PageRow(props: { id: string; space: string; name: string; path: string }) {
  const { id, space, name, path } = props;
  const menu = useContextMenu(() => [{ items: [{ label: 'Edit file', onSelect: () => openFileTab(path, undefined, space) }] }, ...pathMenu(path)]);
  return <Row icon="app-window" label={name} menu={menu} onClick={() => openPanel({ kind: 'page', name }, id, space)} />;
}

const PICK_TITLE: Record<Chooser, string> = { notes: 'Notes', agents: 'Agents' };

export function NewTabPage(props: { id: string }) {
  const { id } = props;
  const space = useSpace();
  const [pick, setPick] = useState<Chooser | null>(null);
  if (pick) {
    return (
      <div class="new-tab">
        <ul class="new-tab-list new-tab-head"><Row icon="caret-left" label={PICK_TITLE[pick]} onClick={() => setPick(null)} /></ul>
        {pick === 'notes' && <ChatList id={id} space={space} />}
        {pick === 'agents' && <AgentList id={id} space={space} />}
      </div>
    );
  }
  const open = (tab: AppTab) => openPanel(tab, id, space);
  const notes = () => {
    const chat = activeConversationId.peek();
    if (chat) open({ kind: 'notes', conversationId: chat }); else setPick('notes');
  };
  const files = () => { rpc.call('system.root').then((root) => openFolderTab(root.path, id, space), (error: unknown) => toastError(error, 'Could not open the folder')); };
  return (
    <div class="new-tab">
      <ul class="new-tab-list" aria-label="Open in this tab">
        {!isMobile.value && <Row icon="sun" label={DESTINATIONS.day} onClick={() => open({ kind: 'day' })} />}
        {!isMobile.value && <Row icon="list-checks" label={DESTINATIONS.tasks} onClick={() => open({ kind: 'work' })} />}
        <Row icon="file-text" label="Notes" onClick={notes} />
        {can('media.list') && <Row icon="image" label="Media" onClick={() => open({ kind: 'media' })} />}
        {can('files.listPath') && <Row icon="folder" label="Files" onClick={files} />}
        <Row icon="users-three" label="Agents" onClick={() => setPick('agents')} />
        {userPages.value?.map((page) => <PageRow key={page.name} id={id} space={space} name={page.name} path={page.path} />)}
      </ul>
    </div>
  );
}
