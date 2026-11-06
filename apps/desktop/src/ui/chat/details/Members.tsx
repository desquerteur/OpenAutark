// Chat details › Members (WhatsApp-like): the chat's agents with avatar (→ agent view), role and
// lead marker; right-click (long press) on a row makes the member lead or removes it (the composer's
// model chip picks a member's model). "Add" opens a searchable agent picker. Changing members needs
// chats.members (session.can); without it the list is read-only (open the agent only).
// C8: external agents ('ext:api:' members) are listed by their label as "External agent";
// removing one ends its access at once. "Connect external agent" (chats.connectExternal,
// session.can; not in system or archived chats) asks for a name and shows the agent's token once,
// with Copy, until Done – together with the `/ws` address(es) it can use (the PC: pwa.state through
// shared externalSocketUrls; a phone: the address it reached the PC on).
// F-52: people of the organisation are members too (PeopleMembers.tsx: rows, picker entries, history rule).
// B-078 D7: a 1:1 stays two – it has no "Add"; "Start a group with them" opens New chat with its members chosen.
// Owns: member rows, the picker and the connect form. Never: deletes agents (only membership),
// hides historical authors (their messages stay in the chat) or keeps a token after Done.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useContextMenu } from '../../lib/context-menu.tsx';
import type { ConversationSummary, Member } from '../../../shared/model/chat.ts';
import { externalAgentName, externalSocketUrls, isExternalAgent, type ExternalAgentToken } from '../../../shared/model/external-agents.ts';
import { agentMembers } from '../../lib/avatar.tsx';
import { platform } from '../../lib/platform.ts';
import { inHostedApp } from '../../pwa/native.ts';
import { go } from '../../lib/router.ts';
import { errorText, rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { agents, knownAgentMap } from '../../lib/store.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { newChatOpen } from '../../lib/shell-state.ts';
import { canStartChat } from '../../shell/gates.ts';
import { pushToast, toastError } from '../../lib/toasts.ts';
import { AgentAvatar, Button, confirm, Icon, Popover } from '../../lib/ui.tsx';
import type { MenuItem } from '../../lib/ui.tsx';
import { HistoryRow, PersonMemberRow, peopleCandidates, personMembers } from './PeopleMembers.tsx';

async function changeMembers(chatId: string, change: { add?: string[]; remove?: string[]; lead?: string }, failTitle: string): Promise<void> {
  try { await rpc.call('chats.members', { id: chatId, ...change }); } catch (error) { toastError(error, failTitle); }
}

function MemberRow(props: { chat: ConversationSummary; member: Member; canEdit: boolean; canRemove: boolean }) {
  const { chat, member } = props;
  const agent = knownAgentMap.value.get(member.memberId);
  const name = agent?.name ?? 'Former member';
  const lead = member.role === 'lead';
  const working = chat.working.includes(member.memberId);
  const items: MenuItem[] = [
    { label: 'Open agent', onSelect: () => go.agent(member.memberId) },
    ...(!lead && props.canEdit ? [{ label: 'Make lead', description: 'Answers messages without @mention', onSelect: () => void changeMembers(chat.id, { lead: member.memberId }, 'Could not change the lead') }] : []),
    ...(props.canEdit && props.canRemove ? [{
      label: 'Remove from chat', danger: true,
      onSelect: async () => {
        if (await confirm({ title: `Remove ${name}?`, body: 'Earlier messages stay in the chat.', confirmLabel: 'Remove', danger: true })) {
          void changeMembers(chat.id, { remove: [member.memberId] }, 'Could not remove the member');
        }
      },
    }] : []),
  ];
  const menu = useContextMenu(() => [{ items }]);
  return (
    <li class="details-member" {...menu}>
      <AgentAvatar agentId={member.memberId} size={32} working={working} onClick={() => go.agent(member.memberId)} />
      <div class="details-member-text">
        <button type="button" class="details-member-name" onClick={() => go.agent(member.memberId)}>
          <span>{name}</span>
          {lead && <span class="details-lead" title="Answers messages without @mention">Lead</span>}
        </button>
        <span class="details-member-role">{agent?.role || agent?.team || ''}</span>
      </div>
    </li>
  );
}

/** C8: an external agent – its label, "External agent", and Remove (which ends its access). */
function ExternalRow(props: { chat: ConversationSummary; member: Member; canEdit: boolean }) {
  const name = externalAgentName(props.member.memberId);
  const items: MenuItem[] = !props.canEdit ? [] : [{
    label: 'Remove from chat', danger: true, description: 'Its token stops working',
    onSelect: async () => {
      if (await confirm({ title: `Remove ${name}?`, body: 'Its token stops working at once. Earlier messages stay in the chat.', confirmLabel: 'Remove', danger: true })) {
        void changeMembers(props.chat.id, { remove: [props.member.memberId] }, 'Could not remove the external agent');
      }
    },
  }];
  const menu = useContextMenu(() => [{ items }]);
  return (
    <li class="details-member" {...menu}>
      <span class="details-add-icon" aria-hidden="true"><Icon name="plugs" size={16} /></span>
      <div class="details-member-text">
        <span class="details-member-name">{name}</span>
        <span class="details-member-role">External agent</span>
      </div>
    </li>
  );
}

function AddMember(props: { chat: ConversationSummary }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const present = new Set(agentMembers(props.chat));
  const q = query.trim().toLowerCase();
  const candidates = agents.value
    .filter((agent) => !agent.archivedAt && !present.has(agent.id))
    .filter((agent) => !q || `${agent.name} ${agent.role} ${agent.team ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const humans = peopleCandidates(props.chat, query); // F-52: people of the organisation
  const add = (id: string) => {
    setOpen(false);
    setQuery('');
    void changeMembers(props.chat.id, { add: [id] }, 'Could not add the member');
  };
  return (
    <>
      <button ref={ref} type="button" class="details-add" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="details-add-icon"><Icon name="user-plus" size={16} /></span>
        <span>Add member</span>
      </button>
      <Popover anchor={ref.current} open={open} onClose={() => { setOpen(false); setQuery(''); }} placement="bottom-start" width={300} class="menu details-picker" label="Add member">
        <input class="input menu-search" type="search" placeholder="Search agents and people" aria-label="Search agents and people" value={query} autoFocus
          onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && candidates[0]) add(candidates[0].id); }} />
        <div role="listbox" aria-label="Agents and people" class="details-picker-list">
          {humans.map((person) => (
            <button key={person.id} type="button" role="option" aria-selected="false" class="menu-item" onClick={() => add(person.id)}>
              <AgentAvatar agentId={person.id} size={26} />
              <span class="menu-label"><span>{person.name}</span><small>{person.title || 'Person'}</small></span>
            </button>
          ))}
          {candidates.map((agent) => (
            <button key={agent.id} type="button" role="option" aria-selected="false" class="menu-item" onClick={() => add(agent.id)}>
              <AgentAvatar agentId={agent.id} size={26} />
              <span class="menu-label"><span>{agent.name}</span>{agent.role && <small>{agent.role}</small>}</span>
            </button>
          ))}
          {!candidates.length && !humans.length && <p class="empty-state">{q ? 'No matches' : 'Everyone is in this chat'}</p>}
        </div>
      </Popover>
    </>
  );
}

/** C8: the `/ws` addresses an external agent can use – the PC's (pwa.state), else the one this page reached the PC on. */
function useSocketUrls(): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    if (!can('pwa.state')) {
      // Inside the iPhone web app the page's host is the website, not the PC: no address to show.
      const web = platform === 'pwa' && !inHostedApp() && (location.protocol === 'https:' || location.protocol === 'http:') && location.host;
      if (web) setUrls([`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`]);
      return;
    }
    let alive = true;
    rpc.call('pwa.state').then((state) => { if (alive) setUrls(externalSocketUrls(state)); }, () => undefined);
    return () => { alive = false; };
  }, []);
  return urls;
}

/** C8: names the external agent, then shows its token once (Copy, Done – the token is gone after Done). */
function ConnectExternal(props: { chat: ConversationSummary; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<ExternalAgentToken | null>(null);
  const urls = useSocketUrls();
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setMade(await rpc.call('chats.connectExternal', { conversationId: props.chat.id, name: name.trim() }));
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const copy = (token: string) => {
    navigator.clipboard.writeText(token).then(() => pushToast({ title: 'Copied' }), (error: unknown) => toastError(error, 'Could not copy'));
  };
  if (made) {
    return (
      <div class="bridge-form">
        <label class="bridge-field">
          <span>Token for {externalAgentName(made.memberId)}</span>
          <input class="input" type="text" readOnly spellcheck={false} value={made.token} onFocus={(event) => (event.currentTarget as HTMLInputElement).select()} />
          <small style={{ overflowWrap: 'anywhere' }}>
            Shown only this once. The agent connects to {urls.length ? urls.join(' or ') : "this PC's /ws address"} and sends it as the token of its first message.
            From another computer it connects over the tailnet or the HTTPS address. It can read and write in this chat only and never approves anything.
          </small>
        </label>
        <div class="bridge-actions">
          <Button variant="ghost" onClick={() => copy(made.token)}>Copy</Button>
          <Button variant="primary" onClick={() => { setMade(null); props.onClose(); }}>Done</Button>
        </div>
      </div>
    );
  }
  return (
    <form class="bridge-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void submit(); }}>
      <label class="bridge-field">
        <span>Name</span>
        <input class="input" type="text" autocomplete="off" spellcheck={false} value={name} maxLength={60} autoFocus
          onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)} />
        <small>An agent outside this app joins this chat and can read its earlier messages. Agents here can @mention it; it never acts for you.</small>
      </label>
      {problem && <p class="bridge-problem" role="alert">{problem}</p>}
      <div class="bridge-actions">
        <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Connect</Button>
      </div>
    </form>
  );
}

/** D7: in a 1:1 – a group with its members instead of a third one here (New chat, its members chosen). */
function StartGroup(props: { chat: ConversationSummary }) {
  const ids = props.chat.members.filter((member) => !member.leftAt && member.memberId !== HUMAN_ID && member.kind !== 'external').map((member) => member.memberId);
  return (
    <button type="button" class="details-add" onClick={() => { newChatOpen.value = { agentIds: ids }; }}>
      <span class="details-add-icon"><Icon name="users-three" size={16} /></span>
      <span>Start a group with them</span>
    </button>
  );
}

export function Members(props: { chat: ConversationSummary }) {
  const { chat } = props;
  const [connecting, setConnecting] = useState(false);
  useEffect(() => setConnecting(false), [chat.id]); // another chat: the form (and a shown token) goes away
  const members = chat.members.filter((member) => member.kind === 'agent' && !member.leftAt);
  const external = chat.members.filter((member) => member.kind === 'external' && isExternalAgent(member.memberId) && !member.leftAt);
  const humans = personMembers(chat); // F-52: people of the organisation (PeopleMembers.tsx)
  const canEdit = can('chats.members');
  const connectVisible = can('chats.connectExternal') && !chat.settings.system && chat.archivedAt === undefined; // the runtime refuses the others
  const count = members.length + external.length + humans.length;
  return (
    <section class="details-section" aria-label="Members">
      <h3 class="details-heading">{count === 1 ? '1 member' : `${count} members`}</h3>
      {canEdit && !chat.settings.direct && <AddMember chat={chat} />}
      {chat.settings.direct && canStartChat() && <StartGroup chat={chat} />}
      {connectVisible && !connecting && (
        <button type="button" class="details-add" onClick={() => setConnecting(true)}>
          <span class="details-add-icon"><Icon name="plugs" size={16} /></span>
          <span>Connect external agent</span>
        </button>
      )}
      {connecting && <ConnectExternal chat={chat} onClose={() => setConnecting(false)} />}
      <ul class="details-members">
        {members.map((member) => <MemberRow key={member.memberId} chat={chat} member={member} canEdit={canEdit} canRemove={members.length > 1} />)}
        {external.map((member) => <ExternalRow key={member.memberId} chat={chat} member={member} canEdit={canEdit} />)}
        {humans.map((member) => <PersonMemberRow key={member.memberId} chat={chat} member={member} canEdit={canEdit} />)}
      </ul>
      {(humans.length > 0 || canEdit) && <HistoryRow chat={chat} />}
    </section>
  );
}
