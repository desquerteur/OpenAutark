// Chat header (lib/header.tsx): one row above the chat column and its side panel. The title cell: the chat's
// avatar (a 1:1's other member opens their page; a group's picture toggles the details) and two fixed lines –
// the chat name, a button that toggles the details panel, and the sub line, always reserved: who is working
// (LiveLine.tsx → the working popover) or the chat's resting line. Right-click (long press) on the title opens the chat's menu (chat-actions.ts).
// Desktop: a segmented row – the title track has one fixed width and right after it sit Call (the chat's voice
// mode, call/CallHeader.tsx) and Chat tabs (opens and closes the chat's area above the messages, ChatArea.tsx; pressed
// while open, a dot while an agent's new tab waits there – workspace/attention.ts), so nothing moves when the title, the
// live line, the area or a panel changes; the open details panel's name and its X sit in the row above that panel (no
// second header inside it). Phone: Back as the lead and the cells [call][chat tabs] at the row's end (the details sheet
// keeps its own top line). B-075: who works and what comes from the chat's rows (the summary's live runs, live-text.ts
// liveRuns) – the same line on every device –, a running split group as one entry (B-057, splits/split-model.ts).
// Owns: the chat header's data and title markup. Never: shows provider logos or invented titles.

import type { ConversationSummary } from '../../shared/model/chat.ts';
import { Icon } from '../lib/ui.tsx';
import { ChatFace, chatPartner, chatSubtitle, chatTitle, partnerPage } from '../lib/chat-face.tsx';
import { Header, backCell } from '../lib/header.tsx';
import type { HeaderCell, HeaderProps } from '../lib/header.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { isMobile, knownAgentMap } from '../lib/store.ts';
import { back, go } from '../lib/router.ts';
import { chatAreaOpen, chatPanel, setChatPanel, toggleChatArea, toggleChatPanel, type ChatPanel } from '../lib/shell-state.ts';
import { LiveLine } from './LiveLine.tsx';
import { WorkingPopover, useWorkingPanel } from './WorkingPopover.tsx';
import { clock12 } from '../lib/format.ts';
import { liveNames, liveRuns, liveShort, liveStatus, type LiveEntry } from './live-text.ts';
import { liveGroupsOf } from '../splits/split-model.ts';
import { groupWorking } from '../splits/split-text.ts';
import { useCallCell } from './call/CallHeader.tsx';
import { chatMenu } from './chat-actions.ts';
import { chatAttention } from '../workspace/attention.ts';

export const PANEL_TITLES: Record<ChatPanel, string> = { details: 'Chat details', thread: 'Thread' };

/** The phone's Back (desktop: no lead). */
export function chatLead(): HeaderCell | undefined {
  return isMobile.value ? backCell(back) : undefined;
}

function ChatTitle(props: { chat: ConversationSummary }) {
  const { chat } = props;
  const partner = chatPartner(chat);
  const solo = partner?.kind === 'agent' ? partner.memberId : undefined; // a 1:1 names only what its agent does
  const entries: LiveEntry[] = [...liveRuns(chat), ...liveGroupsOf(chat.id).map((group) => ({ agentId: group.agentId, conversationId: chat.id, note: groupWorking(group) }))];
  const live = chat.working.length > 0 || entries.length > 0;
  const nameOf = (id: string) => knownAgentMap.value.get(id)?.name;
  const status = live ? liveStatus(chat, solo, entries, nameOf) : '';
  const resting = status ? '' : chatSubtitle(chat);
  const open = chatPanel.value === 'details';
  const working = useWorkingPanel(chat.id);
  const menu = useContextMenu(() => chatMenu(chat));
  const page = partnerPage(partner);
  const onAvatar = page ? () => (page.kind === 'agent' ? go.agent(page.id) : go.person(page.id)) : () => toggleChatPanel(chat.id, 'details');
  return (
    <div class="chat-head" {...menu}>
      <span class="chat-head-avatar">
        <ChatFace chat={chat} size={28} onClick={onAvatar} />
      </span>
      <div class="chat-head-text">
        <button type="button" class="chat-title-button" aria-expanded={open} onClick={() => toggleChatPanel(chat.id, 'details')}>
          <span class="chat-title">{chatTitle(chat)}</span>
          <Icon name={open ? 'caret-up' : 'caret-down'} size={12} class="chat-title-caret" />
        </button>
        <div class="chat-sub" ref={working.anchor} data-clock={clock12 ? '12' : undefined}>
          {status
            ? <LiveLine text={status} short={liveShort(chat, solo, entries, nameOf)} names={liveNames(chat, solo, entries, nameOf)} open={working.open} onToggle={working.toggle} />
            : resting && <span class="chat-resting">{resting}</span>}
        </div>
      </div>
      <WorkingPopover chat={chat} anchor={working.anchor.current} open={working.open} onClose={working.close} />
    </div>
  );
}

/** The chat header's data: title cell, the chat's own cells and (desktop) the open panel's name and X. */
export function useChatHeader(chat: ConversationSummary): HeaderProps {
  const panel = chatPanel.value;
  const call = useCallCell(chat);
  const title = <ChatTitle chat={chat} />;
  const open = chatAreaOpen.value;
  const tabs = (id: string): HeaderCell => ({
    id, icon: 'globe', label: 'Chat tabs', pressed: open, expanded: open, badge: !open && chatAttention.value === chat.id ? 'dot' : undefined, onClick: () => toggleChatArea(chat.id),
  });
  if (isMobile.value) return { zone: 'main', class: 'chat-header', lead: chatLead(), title, cells: [call, tabs('workspace')] };
  return {
    zone: 'main', class: 'chat-header', title, near: [call, tabs('browser')], cells: [],
    panel: panel ? { title: PANEL_TITLES[panel], onClose: () => setChatPanel(chat.id, null) } : undefined,
  };
}

export function ChatHeader(props: { chat: ConversationSummary }) {
  return <Header {...useChatHeader(props.chat)} />;
}
