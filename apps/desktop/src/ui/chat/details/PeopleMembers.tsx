// Chat details › Members, the people part (F-52): the humans of the chat besides you (people of the
// organisation, and on a person's device the CEO), each with title and – where membership may be
// changed here – Remove from chat; the people the Add picker offers; and the chat's history rule
// for people who join later (from their join / the whole chat; chats.update settings.history).
// B-041: a known person's avatar and name open their page (#/team/person/<id>).
// Owns: those rows, the candidate list and the history row. Never: shows a person's other chats.

import { useRef, useState } from 'preact/hooks';
import type { ConversationSummary, Member } from '../../../shared/model/chat.ts';
import type { Person } from '../../../shared/model/people.ts';
import { go } from '../../lib/router.ts';
import { rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { colleagues, peopleMap } from '../../lib/people.ts';
import { toastError } from '../../lib/toasts.ts';
import { AgentAvatar, confirm, Icon, Menu, Select } from '../../lib/ui.tsx';
import type { MenuItem } from '../../lib/ui.tsx';

/** Human members of the chat other than the one using this app ('human'). */
export function personMembers(chat: ConversationSummary): Member[] {
  return chat.members.filter((member) => member.kind === 'human' && member.memberId !== 'human' && !member.leftAt);
}

/** People the Add picker offers: active colleagues (and, on a person's device, the CEO) not in the chat yet. */
export function peopleCandidates(chat: ConversationSummary, query: string): Person[] {
  const present = new Set(chat.members.filter((member) => !member.leftAt).map((member) => member.memberId));
  const q = query.trim().toLowerCase();
  return colleagues().filter((person) => person.status === 'active' && !present.has(person.id))
    .filter((person) => !q || `${person.name} ${person.title}`.toLowerCase().includes(q));
}

export function PersonMemberRow(props: { chat: ConversationSummary; member: Member; canEdit: boolean }) {
  const { chat, member } = props;
  const person = peopleMap.value.get(member.memberId);
  const name = person?.name ?? 'Former colleague';
  const openPage = person ? () => go.person(member.memberId) : undefined;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const items: MenuItem[] = [{
    label: 'Remove from chat', icon: 'x' as const, danger: true, description: 'They no longer see this chat',
    onSelect: async () => {
      if (!(await confirm({ title: `Remove ${name}?`, body: 'They no longer see this chat. Earlier messages stay.', confirmLabel: 'Remove', danger: true }))) return;
      try { await rpc.call('chats.members', { id: chat.id, remove: [member.memberId] }); } catch (error) { toastError(error, 'Could not remove the member'); }
    },
  }];
  return (
    <li class="details-member">
      <AgentAvatar agentId={member.memberId} size={32} onClick={openPage} />
      <div class="details-member-text">
        {openPage
          ? <button type="button" class="details-member-name" onClick={openPage}><span>{name}</span></button>
          : <span class="details-member-name"><span>{name}</span></span>}
        <span class="details-member-role">{person?.title || (person?.owner ? 'Owner' : 'Person')}</span>
      </div>
      {props.canEdit && (
        <>
          <button ref={ref} type="button" class="icon-button small" aria-label={`${name} options`} title="Options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="dots-three" size={16} />
          </button>
          <Menu anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={240} sections={[{ items }]} label={name} />
        </>
      )}
    </li>
  );
}

const HISTORY_OPTIONS = [
  { value: 'join', label: 'From when they join' },
  { value: 'full', label: 'The whole chat' },
];

/** "People added later see": only where chat settings may be changed and the chat has people. */
export function HistoryRow(props: { chat: ConversationSummary }) {
  const { chat } = props;
  if (!can('chats.update') || chat.settings.system) return null;
  const value = chat.settings.history ?? 'join';
  const set = async (next: string) => {
    if (next === value) return;
    try { await rpc.call('chats.update', { id: chat.id, settings: { history: next as 'join' | 'full' } }); } catch (error) { toastError(error, 'Could not save'); }
  };
  return (
    <div class="details-row person-history">
      <span class="details-member-text"><span>People added later see</span></span>
      <Select native label="People added later see" value={value} options={HISTORY_OPTIONS} onChange={(next) => void set(next)} />
    </div>
  );
}
