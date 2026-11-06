// The person's browser history (Ctrl+H or the pane's menu, like Chrome's): a popover at the menu cell with a search field
// (every word in the title or the address), the pages newest first – title, host and when (a click opens it in this tab,
// Ctrl / middle click in a new tab) – and Clear history (confirmed; open tabs, sign-ins and downloads stay). Main keeps at
// most 5,000 addresses and never one with a credential or token (main/workspace-history.ts).
// Owns: the popover. Never: keeps the list after it closes or opens a page by itself.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { HistoryEntry } from '../../shared/api/workspace-browser.ts';
import { fullDate, listTime } from '../lib/format.ts';
import { bridge } from '../lib/platform.ts';
import { toastError } from '../lib/toasts.ts';
import { Button, Icon, Popover, confirm } from '../lib/ui.tsx';

function hostPath(url: string): string {
  try { const parsed = new URL(url); return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`; } catch { return url; }
}

export function HistoryPopover(props: { anchor: HTMLElement | null; onClose: () => void; onOpen: (url: string, newTab: boolean) => void }) {
  const history = bridge?.workspaceBrowser?.history;
  const open = props.anchor !== null;
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  useEffect(() => { if (!open) { setQuery(''); setEntries(null); } else requestAnimationFrame(() => field.current?.focus({ preventScroll: true })); }, [open]);
  useEffect(() => {
    if (!open || !history) return;
    const ask = ++version.current;
    history({ query, limit: 200 }).then((list) => { if (ask === version.current) setEntries(list); }, (error: unknown) => toastError(error, 'Could not read your history'));
  }, [open, query]);

  const clear = async () => {
    props.onClose();
    const yes = await confirm({ title: 'Clear history?', body: 'Every page in your browser history is removed from this PC. Open tabs, sign-ins and downloads stay.', confirmLabel: 'Clear history', danger: true });
    if (!yes || !history) return;
    try { await history({ clear: true }); } catch (error) { toastError(error, 'Could not clear your history'); }
  };

  return (
    <Popover anchor={props.anchor} open={open} onClose={props.onClose} placement="bottom-end" class="browser-history" width={380} label="History">
      <div class="browser-history-head">
        <Icon name="magnifying-glass" size={14} />
        <input ref={field} type="search" class="browser-history-search" aria-label="Search history" placeholder="Search history" value={query}
          onInput={(event) => setQuery(event.currentTarget.value)} />
      </div>
      <div class="browser-history-list" role="list" aria-label="Pages you visited">
        {entries === null ? null : entries.length === 0
          ? <p class="browser-history-empty">{query ? 'No page in your history matches.' : 'Pages you visit show up here.'}</p>
          : entries.map((entry) => (
            <button type="button" role="listitem" class="browser-history-row" key={entry.url} title={entry.url}
              onClick={(event) => { props.onClose(); props.onOpen(entry.url, event.ctrlKey || event.metaKey); }}
              onAuxClick={(event) => { if (event.button === 1) { props.onClose(); props.onOpen(entry.url, true); } }}>
              <Icon name="globe" size={14} />
              <span class="browser-history-text">
                <span class="browser-history-title">{entry.title || hostPath(entry.url)}</span>
                <span class="browser-history-url">{hostPath(entry.url)}</span>
              </span>
              <time class="browser-history-time tabular" dateTime={new Date(entry.at).toISOString()} title={fullDate(entry.at)}>{listTime(entry.at)}</time>
            </button>
          ))}
      </div>
      <div class="browser-history-foot">
        <Button variant="ghost" disabled={!entries?.length || Boolean(query)} onClick={() => void clear()}>Clear history</Button>
      </div>
    </Popover>
  );
}
