// Inline autocomplete for the composer: "@name" → chat members (agents), "/cmd" at the
// start → slash commands. Keyboard: ↑/↓ choose, Enter/Tab accept, Escape dismiss.
// Owns: token detection and the suggestion list. Never: sends or edits other state.

import { useState } from 'preact/hooks';
import type { ConversationSummary } from '../../../shared/model/chat.ts';
import { AgentAvatar, Icon } from '../../lib/ui.tsx';
import { agentMembers } from '../../lib/avatar.tsx';
import { agentMap } from '../../lib/store.ts';
import { availableCommands } from './slash.ts';

export interface Suggestion {
  key: string;
  label: string;
  hint?: string;
  agentId?: string;
  /** Replacement for the token (start..caret). */
  insert: string;
}

interface Token { kind: 'mention' | 'slash'; query: string; start: number }

export function findToken(text: string, caret: number): Token | null {
  const before = text.slice(0, caret);
  const slash = /^\/([a-z]*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1], start: 0 };
  const mention = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(before);
  if (mention) return { kind: 'mention', query: mention[2].toLowerCase(), start: before.length - mention[2].length - 1 };
  return null;
}

export function suggestionsFor(chat: ConversationSummary, token: Token | null): Suggestion[] {
  if (!token) return [];
  if (token.kind === 'slash') {
    return availableCommands().filter((command) => command.name.startsWith(token.query))
      .map((command) => ({ key: command.name, label: `/${command.name}`, hint: command.hint, insert: `/${command.name} ` }));
  }
  return agentMembers(chat)
    .map((id) => agentMap.value.get(id))
    .filter((agent) => !!agent && agent.name.toLowerCase().includes(token.query))
    .slice(0, 8)
    .map((agent) => ({ key: agent!.id, label: agent!.name, hint: agent!.role, agentId: agent!.id, insert: `@${agent!.name} ` }));
}

/** Controller hook: returns the list state and a keydown handler (true = handled). */
export function useSuggestions() {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  return {
    active,
    setActive,
    dismissed,
    dismiss: (key: string | null) => setDismissed(key),
    onKeyDown(event: KeyboardEvent, items: Suggestion[], accept: (item: Suggestion) => void): boolean {
      if (!items.length) return false;
      if (event.key === 'ArrowDown') { setActive((active + 1) % items.length); return true; }
      if (event.key === 'ArrowUp') { setActive((active - 1 + items.length) % items.length); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { accept(items[Math.min(active, items.length - 1)]); setActive(0); return true; }
      if (event.key === 'Escape') { setDismissed(items.map((item) => item.key).join()); return true; }
      return false;
    },
  };
}

export function SuggestionList(props: { items: Suggestion[]; active: number; onPick: (item: Suggestion) => void; onHover: (index: number) => void }) {
  if (!props.items.length) return null;
  return (
    <div class="suggestions popover-inline" role="listbox" aria-label="Suggestions">
      {props.items.map((item, index) => (
        <button type="button" role="option" aria-selected={index === props.active} key={item.key} class="suggestion-row"
          onMouseDown={(event) => { event.preventDefault(); props.onPick(item); }} onMouseMove={() => props.onHover(index)}>
          {item.agentId ? <AgentAvatar agentId={item.agentId} size={22} /> : <Icon name="lightning" size={16} />}
          <span class="suggestion-label">{item.label}</span>
          {item.hint && <span class="menu-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
