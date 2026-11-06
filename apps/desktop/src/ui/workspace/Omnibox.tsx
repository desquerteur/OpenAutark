// The address field, like Chrome's omnibox: an address or a search, with suggestions under it while the person types –
// what Enter opens first (highlighted), then open tabs ("Switch to this tab") and history (omnibox.ts ranks them; main's
// history never holds an address with a token). ↑ / ↓ move, Enter opens the highlighted row, Esc closes the list and, once
// more, gives the field up (onEscape); a click opens a row. The list is a popover over the page (native-surface.ts hides
// the native view under it), so nothing moves. The field keeps the textbox role and its name "Website address".
// Owns: the field and its list. Never: reads a page, keeps what was typed or opens anything itself (the caller does).

import type { Ref } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { bridge } from '../lib/platform.ts';
import { Icon, type IconName } from '../lib/ui.tsx';
import { rankSuggestions, type OpenTab, type Suggestion } from './omnibox.ts';

const ROW_ICON: Record<Suggestion['kind'], IconName> = { go: 'globe', search: 'magnifying-glass', tab: 'app-window', history: 'clock' };

function rowNote(item: Suggestion): string {
  if (item.kind === 'search') return 'Google search';
  if (item.kind === 'tab') return 'Switch to this tab';
  if (item.kind === 'go') return 'Open';
  try { const url = new URL(item.url); return `${url.host}${url.pathname === '/' ? '' : url.pathname}`; } catch { return item.url; }
}

export interface OmniboxProps {
  field: Ref<HTMLInputElement>;
  /** The tab the field belongs to (no "switch" to itself). */
  id: string | undefined;
  draft: string;
  onDraft(text: string): void;
  tabs(): readonly OpenTab[];
  onOpen(url: string): void;
  onSwitch(tabId: string): void;
  onEscape(): void;
  onBlur(): void;
}

export function Omnibox(props: OmniboxProps) {
  const { draft } = props;
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const asked = useRef(0);
  const moved = useRef(false); // the person moved the highlight (else Enter on a known page's row submits what was typed)
  const open = items.length > 0;

  const close = () => { setItems([]); setActive(0); moved.current = false; asked.current++; };
  const suggest = (text: string) => {
    const ask = ++asked.current;
    const show = (history: Parameters<typeof rankSuggestions>[1]) => {
      if (ask !== asked.current) return;
      setItems(rankSuggestions(text, history, props.tabs(), Date.now(), props.id)); setActive(0); moved.current = false;
    };
    if (!text.trim()) { close(); return; }
    const history = bridge?.workspaceBrowser?.history;
    if (!history) return; // a phone: the system browser opens the address, no list to choose from
    history({ query: text.trim(), limit: 40 }).then(show, () => show([]));
  };
  const choose = (item: Suggestion) => {
    close();
    if (item.kind === 'tab' && item.tabId) props.onSwitch(item.tabId); else props.onOpen(item.url);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) { if (event.key === 'ArrowDown' && draft.trim()) { event.preventDefault(); suggest(draft); } return; }
      event.preventDefault();
      moved.current = true;
      setActive((active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (event.key === 'Enter' && open && items[active] && (moved.current || items[0]!.kind === 'go' || items[0]!.kind === 'search' || items[1]?.kind === 'search')) {
      event.preventDefault();
      choose(items[active]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (open) close(); else props.onEscape();
    }
  };

  const list = 'browser-suggestions';
  return (
    <span class="browser-omnibox">
      <input ref={props.field} class="browser-address" type="text" aria-label="Website address" placeholder="Search or enter address" spellcheck={false} autocomplete="off"
        value={draft} aria-autocomplete="list" aria-controls={open ? list : undefined} aria-activedescendant={open && items[active] ? `${list}-${active}` : undefined}
        onInput={(event) => { props.onDraft(event.currentTarget.value); suggest(event.currentTarget.value); }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => { close(); props.onBlur(); }} onKeyDown={onKeyDown} />
      {open && (
        <div id={list} class="popover browser-suggestions" role="listbox" aria-label="Suggestions">
          {items.map((item, index) => (
            <div key={`${item.kind}:${item.tabId ?? item.url}`} id={`${list}-${index}`} role="option" aria-selected={index === active}
              class={`browser-suggestion${index === active ? ' selected' : ''}`}
              onMouseDown={(event) => event.preventDefault()} onMouseMove={() => { if (index !== active) setActive(index); }} onClick={() => choose(item)}>
              <Icon name={ROW_ICON[item.kind]} size={14} />
              <span class="browser-suggestion-text">
                <span class="browser-suggestion-title">{item.kind === 'go' ? item.url : item.title}</span>
                <span class="browser-suggestion-note">{rowNote(item)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
