// One 56 px chat-list row: avatar (B-050 K9: the other member of a two-member room – an agent square, a
// person round –, else the group's image or initials; working ring), the chat's name as the caller sees it
// (K2, lib/chat-face.tsx chatTitle), last message (sender only in groups; row-preview.ts), time, pin and the
// unread badge in a slot every row reserves (two digits wide), so a badge arriving or growing never re-cuts
// the preview; unread is colour only (badge, time), never weight – red while an unread message is important
// (K4, importantUnread). A row without a second line yet – an empty default 1:1, made with its agent (Nachtrag
// Runde 4) – shows the name and avatar only and keeps that line's height, so a first line or a draft never
// moves the name. While the list is searched (`mark`) the searched
// words in the name and the second line are marked (colour only), and a second line whose match lies
// past its visible start begins shortly before it.
// A muted chat's row is quieter in colour (no bell icon). Row → chat; right-click (long press) → the chat's
// menu (chat-actions.ts). The other member's avatar → their page (an agent's insight, a person's page); B-078 any other
// avatar → the chat with its details panel. A row with sub-chats has a caret in the row's left inset (it takes no room,
// nothing moves) that shows or hides them; a sub-chat's row is indented (`child`) with a smaller avatar.
// B-075: who works and what comes from the summary's live runs (the chat's streaming rows), as in the header.
// Owns: the row markup. Never: list ordering (ChatList does).

import type { ConversationSummary } from '../../shared/model/chat.ts';
import { Icon } from '../lib/ui.tsx';
import { ChatFace, chatPartner, chatTitle, partnerPage } from '../lib/chat-face.tsx';
import { knownAgentMap } from '../lib/store.ts';
import { go, navigate } from '../lib/router.ts';
import { setChatPanel } from '../lib/shell-state.ts';
import { listTime } from '../lib/format.ts';
import { Marked } from '../lib/mark.tsx';
import { markRanges } from '../lib/mark-ranges.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { chatMenu } from './chat-actions.ts';
import { liveRuns, liveStatus } from './live-text.ts';
import { rowPreview } from './row-preview.ts';

/** The row's second line as shown: a draft first, else the last message (row-preview.ts); the list's search matches it too.
 *  While agents work on a message without text yet, the chat header's live line (live-text.ts) – one source for who works. */
export function previewText(chat: ConversationSummary): string {
  const nameOf = (id: string) => knownAgentMap.value.get(id)?.name;
  const partner = chatPartner(chat);
  const live = () => {
    const entries = liveRuns(chat);
    return entries.length ? liveStatus(chat, partner?.kind === 'agent' ? partner.memberId : undefined, entries, nameOf) : '';
  };
  return rowPreview(chat, nameOf, live);
}

/** A searched preview whose first match starts past this many characters (the row shows about 30) begins LEAD characters before it. */
const SHOWN = 20;
const LEAD = 10;

/** While the list is searched: a preview whose first match lies past its visible start begins shortly before it ("…the launch date"). */
function matchWindow(text: string, query: string): string {
  const first = markRanges(text, query)[0];
  if (!first || first[0] <= SHOWN) return text;
  const space = text.indexOf(' ', first[0] - LEAD);
  return `…${text.slice(space !== -1 && space < first[0] ? space + 1 : first[0] - LEAD)}`;
}

/** B-078: a row with sub-chats – whether they show and the caret's toggle. */
export interface RowTree { open: boolean; count: number; onToggle: () => void }

/** B-078: the group's (or any non-partner) avatar opens the chat with its details panel. */
function openDetails(chatId: string): void {
  setChatPanel(chatId, 'details');
  navigate({ view: 'chat', id: chatId });
}

export function ChatRow(props: { chat: ConversationSummary; active: boolean; muted?: boolean; mark?: string; tree?: RowTree; child?: boolean }) {
  const { chat, active } = props;
  const preview = previewText(chat);
  const title = chatTitle(chat);
  const notifications = chat.settings.notifications ?? 'default';
  const silenced = notifications === 'off'; // B-078 D17: only the chat's own level – no hidden global switch dims the list
  // Both avatars lie above the row's click overlay: the other member's opens their page, every other avatar –
  // groups, custom images – the chat with its details panel (B-078).
  const page = chat.settings.image ? undefined : partnerPage(chatPartner(chat));
  const important = (chat.importantUnread ?? 0) > 0;
  const menu = useContextMenu(() => chatMenu(chat, { open: true }));
  return (
    <div class={`chat-row${active ? ' active' : ''}${props.muted ? ' muted-row' : ''}${silenced ? ' silenced' : ''}${props.child ? ' child' : ''}`} aria-current={active ? 'page' : undefined} {...menu}>
      {props.tree && (
        <button type="button" class="chat-tree-caret" aria-expanded={props.tree.open}
          aria-label={`${props.tree.open ? 'Hide' : 'Show'} ${props.tree.count} sub-chat${props.tree.count === 1 ? '' : 's'}`}
          onClick={(event) => { event.stopPropagation(); props.tree!.onToggle(); }}>
          <Icon name={props.tree.open ? 'caret-down' : 'caret-right'} size={10} />
        </button>
      )}
      {page
        ? <span class="chat-row-avatar to-agent" title={page.kind === 'agent' ? 'Open agent' : 'Open profile'}
          onClick={(event) => { event.stopPropagation(); if (page.kind === 'agent') go.agent(page.id); else go.person(page.id); }}><ChatFace chat={chat} size={props.child ? 28 : 36} /></span>
        : <span class="chat-row-avatar to-details" title="Chat details"
          onClick={(event) => { event.stopPropagation(); openDetails(chat.id); }}><ChatFace chat={chat} size={props.child ? 28 : 36} /></span>}
      <button type="button" class="chat-row-open" onClick={() => navigate({ view: 'chat', id: chat.id })}>
        <span class="chat-row-line">
          <span class="row-title">{props.mark ? <Marked text={title} query={props.mark} /> : title}</span>
          <span class="row-time tabular">{listTime(chat.lastPreview?.at ?? chat.lastMessageAt)}</span>
        </span>
        <span class="chat-row-line">
          <span class={`row-preview${chat.draft ? ' draft' : ''}`}>{!preview ? <>&nbsp;</> : props.mark ? <Marked text={matchWindow(preview, props.mark)} query={props.mark} /> : preview}</span>
          {chat.pinned && <Icon name="push-pin" size={12} class="row-pin" title="Pinned" />}
          {!props.muted && (
            <span class="unread-slot">
              {chat.unread > 0 && <span class={`unread-badge tabular${important ? ' important' : ''}`} aria-label={`${chat.unread} unread${important ? ', important' : ''}`}>{chat.unread > 99 ? '99+' : chat.unread}</span>}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}
