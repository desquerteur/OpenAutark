// The right-click menus of the team (lib/context-menu.tsx): ONE section builder per object, used by the
// sidebar rows, the agent page's name dropdown, a person's page and the org rows alike. Agent: Message ·
// Browser · Open in side panel (its browser as a tab of the side pane) · Connect Telegram… · Duplicate… and
// Change reports-to… (both "set up with AI": the Manager's chat opens with
// the request, the skill agent-duplicate does the copy) · Export · Archive; an archived agent offers Restore.
// Person: Message · Edit · Invite a device · Devices and chats · Remove access. Text only, no icons.
// Owns: which items an agent or a person offers and what they call. Never: draws a menu or a dialog (the
// person dialogs are mounted by person-dialogs.tsx; Browser is shown by AgentView).

import { signal } from '@preact/signals';
import type { Agent } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';
import type { MenuSection } from '../lib/popover.tsx';
import { confirm } from '../lib/dialog.tsx';
import { platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { go, navigate, route } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { setChatPanel } from '../lib/shell-state.ts';
import { agents, conversations, isMobile, removeById, upsertById } from '../lib/store.ts';
import { upsertPerson } from '../lib/people.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { directReachable, messageMember, openDirect } from '../chat/direct.ts';
import { openAgentBrowser } from '../workspace/pages.ts';
import { personDialog } from './person-dialogs.tsx';
import { duplicateRequest, reportsToRequest, setUpWithAi } from './set-up-with-ai.ts';

/** The agent whose own browser the agent page shows instead of its profile (set by "Browser"). */
export const agentBrowser = signal<string | null>(null);

export async function exportAgent(agent: Agent): Promise<void> {
  try {
    const file = await rpc.call('agents.export', { id: agent.id, includeKnowledge: true });
    await rpc.call('files.open', { id: file.id, reveal: true });
    pushToast({ title: 'Exported', body: file.name });
  } catch (error) {
    toastError(error, 'Could not export');
  }
}

/** "Connect Telegram…": the agent's 1:1 chat with its details open (the bridges are there). */
async function connectTelegram(agent: Agent): Promise<void> {
  try {
    const chat = await rpc.call('chats.direct', { memberId: agent.id });
    upsertById(conversations, chat);
    go.chat(chat.id);
    setChatPanel(chat.id, 'details');
  } catch (error) {
    toastError(error, 'Could not open the chat');
  }
}

async function archiveAgent(agent: Agent): Promise<void> {
  const ok = await confirm({ title: `Archive ${agent.name}?`, body: 'Its reports move up to its manager. Chats and history stay readable.', confirmLabel: 'Archive', danger: true });
  if (!ok) return;
  try {
    await rpc.call('agents.archive', { id: agent.id });
    removeById(agents, agent.id);
    const current = route.value;
    if (current.view === 'team' && current.agentId === agent.id) navigate({ view: 'team' }, { replace: true });
  } catch (error) {
    toastError(error, 'Could not archive');
  }
}

async function restoreAgent(agent: Agent): Promise<void> {
  try { upsertById(agents, await rpc.call('agents.restore', { id: agent.id })); } catch (error) { toastError(error, 'Could not restore'); }
}

export function agentMenu(agent: Agent): MenuSection[] {
  if (agent.archivedAt !== undefined) return [{ items: [{ label: 'Restore', onSelect: () => void restoreAgent(agent) }] }];
  const browserShown = agentBrowser.value === agent.id && route.value.view === 'team' && route.value.agentId === agent.id;
  return [
    { items: [
      { label: 'Message', onSelect: () => messageMember(agent.id) },
      { label: browserShown ? 'Profile' : 'Browser', onSelect: () => { agentBrowser.value = browserShown ? null : agent.id; if (!browserShown) go.agent(agent.id); } },
      ...(!isMobile.value ? [{ label: 'Open in side panel', onSelect: () => openAgentBrowser(agent.id) }] : []),
      { label: 'Connect Telegram…', onSelect: () => void connectTelegram(agent) },
    ] },
    { items: [
      ...(can('agents.create') ? [{ label: 'Duplicate…', onSelect: () => void setUpWithAi(duplicateRequest(agent)) }] : []),
      { label: 'Change reports-to…', onSelect: () => void setUpWithAi(reportsToRequest(agent)) },
      ...(platform === 'desktop' ? [{ label: 'Export', onSelect: () => void exportAgent(agent) }] : []),
    ] },
    { items: [{ label: 'Archive', danger: true, onSelect: () => void archiveAgent(agent) }] },
  ];
}

async function removeAccess(person: Person): Promise<void> {
  if (!(await confirm({ title: `Remove ${person.name}'s access?`, body: 'Their devices are signed out at once, they leave their chats and their open work goes back to the team. Their messages stay.', confirmLabel: 'Remove access', danger: true }))) return;
  try { upsertPerson(await rpc.call('people.revoke', { id: person.id })); } catch (error) { toastError(error, 'Could not remove the access'); }
}

export function personMenu(person: Person): MenuSection[] {
  const admin = can('people.save');
  const others = admin && !person.owner;
  return [
    { items: person.id !== 'human' && person.status === 'active' && directReachable(person.id) ? [{ label: 'Message', onSelect: () => void openDirect(person.id) }] : [] },
    { items: [
      ...(admin ? [{ label: 'Edit', onSelect: () => { personDialog.value = { kind: 'edit', id: person.id }; } }] : []),
      ...(others ? [{ label: person.status === 'revoked' ? 'Invite again' : 'Invite a device', onSelect: () => { personDialog.value = { kind: 'invite', id: person.id }; } }] : []),
      ...(others ? [{ label: 'Devices and chats', onSelect: () => { personDialog.value = { kind: 'details', id: person.id }; } }] : []),
    ] },
    { items: others && person.status !== 'revoked' ? [{ label: 'Remove access', danger: true, onSelect: () => void removeAccess(person) }] : [] },
  ];
}
