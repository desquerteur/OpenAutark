// Sidebar chat list: its header data (chatListHeader – "Chats", the destination's one name (lib/vocab.ts,
// as the rail and the phone tab say it), with the in-place search, drawn by the frame's side header
// row, shell/views.ts; the phone's Chats tab uses its search), "New chat" (as the palette says it; only
// where chats.create is allowed, shell/gates.ts canStartChat), one flat list (pinned first,
// then recent activity; an empty default 1:1 after every chat with a line – list-order.ts) and
// two collapsed, muted sections at the end: "Team activity"
// for agent-only rooms and "Archived" (C2: archived chats – their agents keep working; a chat
// comes back by itself when something needs the person). All come from the one store list
// (loaded with includeHidden), sorted by archive.ts listSection(); app-owned system chats (To-do,
// Customize) appear in none. Search filters names (as the caller sees them, B-050 K2) and the rows' second lines (drafts too) locally (folded sections included)
// and finds message text via chats.search: each hit names its sender, chat and time on a quiet
// first line and shows the text as written around its first match (search-snippet.ts) with the
// searched words marked; a row found by its name or last message marks them there too.
// B-078: sub-chats sit under their parent (list-order.ts nestChats, one level; threads are never rows): shown while
// searching or after its caret opened them (remembered per window); under a closed parent an unread sub-chat or the
// open one shows too, so nothing new hides – and stays shown until the caret is used, so opening chats moves no row.
// Owns: list ordering, search and rendering the sections. Never: creates chats itself
// (NewChatDialog), draws header markup (lib/header.tsx does) or defines which chat goes where
// (shared/text/chat-sections.ts, archive.ts).

import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { ConversationSummary, Message } from '../../shared/model/chat.ts';
import { Icon } from '../lib/ui.tsx';
import type { HeaderProps } from '../lib/header.tsx';
import { Marked } from '../lib/mark.tsx';
import { DESTINATIONS } from '../lib/vocab.ts';
import { activeConversationId, agentName, conversationMap, conversations, drafts } from '../lib/store.ts';
import { chatTitle } from '../lib/chat-face.tsx';
import { rpc } from '../lib/rpc.ts';
import { navigate } from '../lib/router.ts';
import { focusMessage, newChatOpen } from '../lib/shell-state.ts';
import { listTime } from '../lib/format.ts';
import { canStartChat } from '../shell/gates.ts';
import { listSection, type ListSection } from './archive.ts';
import { ChatRow, previewText } from './ChatRow.tsx';
import { nestChats, orderChats, type ChatNode } from './list-order.ts';
import { hitSnippet } from './search-snippet.ts';

const order = (list: ConversationSummary[]): ConversationSummary[] => orderChats(list, chatTitle);

type Hit = { message: Message; conversationTitle: string; snippet: string };

/** Who wrote a hit, as the chat shows it. */
function hitAuthor(message: Message): string {
  if (message.authorKind === 'human') return 'You';
  if (message.authorKind === 'system') return '';
  return message.authorId.startsWith('ext:') ? message.authorId.split(':').pop() || message.authorId : agentName(message.authorId);
}

/** The search of the list, shared by its header (field in the title's place) and the rows. */
const search = signal({ open: false, query: '' });

/** The Chats side header: "Chats" and the magnifier, whose field takes the title's place. */
export function chatListHeader(): HeaderProps {
  const state = search.value;
  return {
    title: DESTINATIONS.chats,
    search: {
      label: 'Search chats', open: state.open, query: state.query,
      onQuery: (query) => { search.value = { ...search.peek(), query }; },
      onOpenChange: (open) => { search.value = { ...search.peek(), open }; },
    },
  };
}

/** B-078: caret choices per parent (true: open, false: closed); absent: open while the parent or a sub-chat is open. */
const TREE_KEY = 'wf.chatTreeOpen';
const treeChoice = signal<Record<string, boolean>>((() => { try { return JSON.parse(localStorage.getItem(TREE_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; } })());

/** Sub-chats once shown under a closed parent (unread, or the open one): they stay until its caret is used, so moving
 * between chats never takes a row away under the pointer. */
const keptChildren = new Set<string>();

function setTree(id: string, open: boolean, children: readonly { id: string }[] = []): void {
  for (const child of children) keptChildren.delete(child.id);
  treeChoice.value = { ...treeChoice.peek(), [id]: open };
  try { localStorage.setItem(TREE_KEY, JSON.stringify(treeChoice.peek())); } catch { /* storage may be blocked */ }
}

/** Rows of one section: each top chat, then its sub-chats while they show (see the header). */
function Rows(props: { nodes: ChatNode<ConversationSummary>[]; activeId: string | null; muted?: boolean; mark?: string }) {
  const { activeId, muted, mark } = props;
  return (
    <>
      {props.nodes.map(({ chat, children }) => {
        // only the caret opens or closes a parent: opening a chat never adds or removes rows (a click moves no neighbour)
        const open = children.length > 0 && (Boolean(mark) || treeChoice.value[chat.id] === true);
        const shown = open ? children : children.filter((child) => child.unread > 0 || child.id === activeId || keptChildren.has(child.id));
        if (!open) for (const child of shown) keptChildren.add(child.id);
        const tree = children.length ? { open, count: children.length, onToggle: () => setTree(chat.id, !open, children) } : undefined;
        return [
          <ChatRow key={chat.id} chat={chat} active={chat.id === activeId} muted={muted} mark={mark} tree={tree} />,
          ...shown.map((child) => <ChatRow key={child.id} chat={child} active={child.id === activeId} muted={muted} mark={mark} child />),
        ];
      })}
    </>
  );
}

/** A collapsed, muted section; open while searching or while it holds the open chat. Remembers its state per window. */
function Folded(props: { label: string; storageKey: string; class: string; chats: ConversationSummary[]; activeId: string | null; reveal: boolean; mark?: string }) {
  const { chats, activeId } = props;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(props.storageKey) === '1'; } catch { return false; } });
  if (!chats.length) return null;
  const toggle = () => {
    setOpen(!open);
    try { localStorage.setItem(props.storageKey, open ? '0' : '1'); } catch { /* ignore */ }
  };
  return (
    <div class={props.class}>
      <button type="button" class="section-toggle" aria-expanded={open} onClick={toggle}>
        <Icon name={open ? 'caret-down' : 'caret-right'} size={12} /> {props.label}
        <span class="nav-count tabular">{chats.length}</span>
      </button>
      {(open || props.reveal || chats.some((chat) => chat.id === activeId)) && <Rows nodes={nestChats(chats)} activeId={activeId} muted mark={props.mark} />}
    </div>
  );
}

export function ChatList() {
  const query = search.value.query;
  const [hits, setHits] = useState<Hit[]>([]);
  useEffect(() => () => { search.value = { open: false, query: '' }; }, []); // a list shown again starts without a search
  const activeId = activeConversationId.value;
  const draftMap = drafts.value;
  const q = query.trim().toLowerCase();

  // Message-text search (debounced, only for 3+ characters).
  useEffect(() => {
    if (q.length < 3) { setHits([]); return; }
    const timer = setTimeout(() => {
      rpc.call('chats.search', { text: q, limit: 20 }).then((result) => setHits(result)).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const all = conversations.value
    .map((chat) => (draftMap[chat.id] && chat.id !== activeId ? { ...chat, draft: draftMap[chat.id] } : { ...chat, draft: undefined }));
  // what the row shows: its name and its second line – a draft too ("Draft: …"), not only the last message
  const matches = (chat: ConversationSummary) => !q || chatTitle(chat).toLowerCase().includes(q) || previewText(chat).toLowerCase().includes(q);
  const section = (name: ListSection) => order(all.filter((chat) => listSection(chat) === name && !chat.settings.anchorId && matches(chat)));
  const main = section('main');

  return (
    <div class="chat-list" data-tour="chat-list">
      {canStartChat() && (
        <button type="button" class="sidebar-action" onClick={() => { newChatOpen.value = {}; }}>
          <Icon name="plus" size={18} /> New chat
        </button>
      )}
      <div class="chat-rows" role="list">
        <Rows nodes={nestChats(main)} activeId={activeId} mark={q} />
      </div>
      {hits.length > 0 && (
        <div class="search-hits">
          <div class="menu-title">Messages</div>
          {hits.map((hit) => {
            const author = hitAuthor(hit.message);
            const known = conversationMap.value.get(hit.message.conversationId);
            const where = known ? chatTitle(known) : hit.conversationTitle; // the name the row shows (B-050 K2)
            return (
              <button type="button" class="search-hit" key={hit.message.id}
                onClick={() => { focusMessage.value = { conversationId: hit.message.conversationId, messageId: hit.message.id }; navigate({ view: 'chat', id: hit.message.conversationId }); }}>
                <span class="search-hit-head">
                  <span class="search-hit-where">{author ? `${author} · ${where}` : where}</span>
                  <time class="tabular">{listTime(hit.message.createdAt)}</time>
                </span>
                <span class="search-hit-text"><Marked text={hitSnippet(hit.message.body, q, hit.snippet)} query={q} /></span>
              </button>
            );
          })}
        </div>
      )}
      <Folded label="Team activity" storageKey="wf.teamActivityOpen" class="team-activity" chats={section('team')} activeId={activeId} reveal={!!q} mark={q} />
      {/* Same look as Team activity (its spacing comes from .team-activity). */}
      <Folded label="Archived" storageKey="wf.archivedOpen" class="team-activity archived-chats" chats={section('archived')} activeId={activeId} reveal={!!q} mark={q} />
    </div>
  );
}
