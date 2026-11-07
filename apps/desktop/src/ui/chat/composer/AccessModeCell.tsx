// AF-013: the composer's access mode cell – a small labelled cell of one fixed width that names the mode the addressed
// agent works in here ("Read only", "Ask first", "Project", "Full access"). A click, or Shift+Tab in the message field
// (like Claude Code), switches this chat to the next mode; landing on the agent's own mode clears the chat's override.
// Its right-click menu picks a mode, goes back to the agent's own, or opens the agent's access rules. Only the person on
// the PC changes it; elsewhere it only shows. Without an agent: an inert box of the same width.
// Owns: the cell. Never: judges anything (the runtime does) or keeps the mode itself.

import { useEffect } from 'preact/hooks';
import type { ConversationSummary } from '../../../shared/model/chat.ts';
import { ACCESS_MODE_LABELS, ACCESS_MODES, type AccessMode } from '../../../shared/model/access.ts';
import { accessFor, nextMode, setChatMode } from '../../lib/access.ts';
import { useContextMenu } from '../../lib/context-menu.tsx';
import { isOwner } from '../../lib/session.ts';
import { navigate } from '../../lib/router.ts';
import { toastError } from '../../lib/toasts.ts';
import { Icon } from '../../lib/ui.tsx';
import type { IconName } from '../../lib/icons.tsx';

const ICONS: Readonly<Record<AccessMode, IconName>> = { read: 'lock-simple', ask: 'shield-check', project: 'folder', full: 'lightning' };

async function choose(chatId: string, mode: AccessMode, agentMode: AccessMode | undefined): Promise<void> {
  try { await setChatMode(chatId, mode === agentMode ? null : mode); } catch (error) { toastError(error); }
}

export function AccessModeCell(props: { chat: ConversationSummary; agentId: string | null }) {
  const { chat, agentId } = props;
  const access = agentId ? accessFor(agentId, chat.id).value : null;
  const owner = isOwner();
  const cycle = () => { if (access && owner) void choose(chat.id, nextMode(access.mode), access.agentMode); };

  // Shift+Tab in this composer's field switches the mode (Claude Code's shortcut); elsewhere Shift+Tab moves focus as usual.
  useEffect(() => {
    if (!access || !owner) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== 'Tab' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !target?.classList.contains('composer-input')) return;
      if (target.closest('.composer-area') !== document.querySelector(`[data-access-chat="${chat.id}"]`)?.closest('.composer-area')) return;
      event.preventDefault();
      cycle();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  const menu = useContextMenu(() => {
    if (!access || !owner || !agentId) return [];
    return [
      { title: 'Access in this chat', items: ACCESS_MODES.map((mode) => ({ label: ACCESS_MODE_LABELS[mode].label, description: ACCESS_MODE_LABELS[mode].description, checked: access.mode === mode, onSelect: () => void choose(chat.id, mode, access.agentMode) })) },
      { items: [
        ...(access.source === 'chat' ? [{ label: `Use the agent's own mode (${ACCESS_MODE_LABELS[access.agentMode].label})`, onSelect: () => void setChatMode(chat.id, null).catch(toastError) }] : []),
        { label: 'Access rules…', onSelect: () => navigate({ view: 'team', agentId }) },
      ] },
    ];
  });

  if (!access) return <span class="access-mode-cell placeholder" aria-hidden="true" data-tour="permission-mode" />;
  const text = ACCESS_MODE_LABELS[access.mode];
  const title = `${text.label}${access.source === 'chat' ? ' (this chat)' : ''} – ${text.description}${owner ? ' Click or Shift+Tab: next mode. Right-click: more.' : ''}`;
  return (
    <button type="button" class={`access-mode-cell mode-${access.mode}${access.source === 'chat' ? ' override' : ''}`} data-tour="permission-mode" data-access-chat={chat.id}
      title={title} aria-label={`Access: ${text.label}`} disabled={!owner} onClick={cycle} {...menu}>
      <Icon name={ICONS[access.mode]} size={14} />
      <span class="access-mode-label">{text.short}</span>
    </button>
  );
}
