// "+ Chat" (B-050 K9): one searchable multi-select of the organisation's agents and people (people round,
// agents square – the avatars' shapes) and an optional topic. Exactly one member and no topic opens the
// pair's default 1:1 (chat/direct.ts – the chat that is named after the other member, K1/K2); with a topic
// or several members it creates a chat (chats.create with agents, people and the topic as its title) –
// repeated topic chats with the same member stay possible (new-chat.ts decides). The 16.10. rule "never
// names chats after agents" is revised by K1/K2: the default 1:1 is named after the other member, and a
// room started without a topic shows its other members' names per viewer until its first message names it.
// Owns: the dialog. Never: invents titles or fills the topic.

import { useEffect, useRef, useState } from 'preact/hooks';
import { AgentAvatar, Button, Dialog, Icon } from '../lib/ui.tsx';
import { agentMap, agents, conversations, upsertById } from '../lib/store.ts';
import { colleagues } from '../lib/people.ts';
import { rpc } from '../lib/rpc.ts';
import { navigate } from '../lib/router.ts';
import { newChatOpen } from '../lib/shell-state.ts';
import { toastError } from '../lib/toasts.ts';
import { directReachable, openDirect } from './direct.ts';
import { newChatPlan } from './new-chat.ts';

interface Choice { id: string; name: string; line: string; search: string }

export function NewChatDialog() {
  const request = newChatOpen.value;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!request) return;
    setQuery('');
    setTopic('');
    setSelected(request.agentIds ?? []);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [request]);

  const close = () => { newChatOpen.value = null; };
  const q = query.trim().toLowerCase();
  const people = colleagues().filter((person) => person.status === 'active');
  const choices: Choice[] = [
    ...agents.value.filter((agent) => !agent.archivedAt).map((agent) => ({ id: agent.id, name: agent.name, line: agent.role, search: `${agent.name} ${agent.role} ${agent.team ?? ''}` })),
    ...people.map((person) => ({ id: person.id, name: person.name, line: person.title, search: `${person.name} ${person.title}` })),
  ];
  const list = choices
    .filter((choice) => !q || choice.search.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toggle = (id: string) => setSelected(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
  const plan = newChatPlan(selected, topic, (id) => agentMap.value.has(id));
  const canCreate = plan !== null && !busy;

  const create = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      if (plan.kind === 'direct' && directReachable(plan.memberId)) {
        if (await openDirect(plan.memberId)) close();
        return;
      }
      const made = plan.kind === 'direct' ? { agentIds: [plan.memberId], people: [] } : plan; // an agent without chats.direct (an older runtime): a new chat
      const chat = await rpc.call('chats.create', {
        ...('title' in made && made.title ? { title: made.title } : {}), agentIds: made.agentIds, ...(made.people.length ? { people: made.people } : {}),
      });
      // The summary arrives via conversation.upserted; fetch it now so the row exists at once.
      const summary = await rpc.call('chats.get', { id: chat.id }).catch(() => null);
      if (summary) upsertById(conversations, summary);
      close();
      navigate({ view: 'chat', id: chat.id });
    } catch (error) {
      toastError(error, 'Chat could not be created');
    } finally {
      setBusy(false);
    }
  };

  const searchLabel = people.length ? 'Search agents and people' : 'Search agents';
  return (
    <Dialog open={!!request} onClose={close} title="New chat" width={440} class="new-chat">
      <input ref={searchRef} class="input" type="text" placeholder={searchLabel} aria-label={searchLabel} value={query}
        onInput={(event) => setQuery((event.target as HTMLInputElement).value)} />
      <div class="agent-choices" role="listbox" aria-multiselectable="true" aria-label="Members">
        {list.map((choice) => {
          const on = selected.includes(choice.id);
          return (
            <button type="button" role="option" aria-selected={on} class={`agent-choice${on ? ' on' : ''}`} key={choice.id} onClick={() => toggle(choice.id)}>
              <AgentAvatar agentId={choice.id} size={30} />
              <span class="agent-choice-text">
                <span>{choice.name}</span>
                {choice.line && <small>{choice.line}</small>}
              </span>
              <span class="check-circle" aria-hidden="true">{on && <Icon name="check" size={12} />}</span>
            </button>
          );
        })}
        {!list.length && <p class="empty-state">No one found</p>}
      </div>
      <label class="field-label" for="new-chat-topic">Topic (optional)</label>
      <input id="new-chat-topic" class="input" type="text" value={topic} maxLength={120}
        onInput={(event) => setTopic((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void create(); }} />
      <div class="dialog-actions">
        <Button variant="secondary" onClick={close}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!canCreate} onClick={() => void create()}>Start chat</Button>
      </div>
    </Dialog>
  );
}
