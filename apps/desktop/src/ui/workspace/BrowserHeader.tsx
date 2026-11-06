// A surface's address row (40 px, under the tab strip, directly above the page): Back, Forward, Reload, the
// address slot and the menu cell (PaneMenu.tsx). Every cell is always there at one place – Back, Forward and
// Reload are only faint on a blank or app tab – so nothing shifts on a click. At rest the slot shows the
// address alone (the page's title lives on its tab) and it becomes the editable field on a click (or
// Ctrl+L, or a new tab; Omnibox.tsx, with its suggestions – the open tabs of this space and, where the frame has a global
// pane, of global); Enter opens an address or a search, Escape puts the page's address back. On Ctrl+F
// the same slot is the find field (FindField.tsx); on an app tab (My day, Work, Notes …) it names the kind, on a
// file or folder tab it is the path (PathField.tsx).
// Loading is a thin line on the row's edge. An agent's browser brings its own toolbar in this place
// (BrowserLive.tsx).
// Owns: the row and the address field. Never: opens pages itself (pages.ts) or touches page content.

import { useEffect, useRef, useState } from 'preact/hooks';
import { GLOBAL_SPACE, type WorkspaceBrowserPage } from '../../shared/api/workspace-browser.ts';
import { isMobile } from '../lib/platform.ts';
import { IconButton } from '../lib/ui.tsx';
import { APP_KIND_LABEL, displayAddress, isAppTab } from './browser-model.ts';
import { FindField } from './FindField.tsx';
import { Omnibox } from './Omnibox.tsx';
import { addressFocus, browserPages, command, findOpen, goTo, switchToTab, tabsOf } from './pages.ts';
import { PaneMenu } from './PaneMenu.tsx';
import { PathField } from './PathField.tsx';
import { useSpace } from './space.ts';

/** The last address-focus request this window acted on (a request made while its surface was closed still counts once). */
let handledFocus = 0;

function Address(props: { id: string | undefined; page: WorkspaceBrowserPage | undefined; blank: boolean }) {
  const { id, page, blank } = props;
  const space = useSpace();
  const url = page?.url ?? '';
  const field = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [focusAsk, setFocusAsk] = useState(0);
  const [draft, setDraft] = useState(url);
  const asked = addressFocus.value;
  const editable = blank || editing;
  useEffect(() => { if (!editing) setDraft(url); }, [url, id, editing]);
  useEffect(() => {
    if (asked.space !== space || asked.ask === handledFocus) return;
    handledFocus = asked.ask;
    setEditing(true);
    setFocusAsk((n) => n + 1);
  }, [asked]);
  useEffect(() => {
    if (!focusAsk) return;
    field.current?.focus({ preventScroll: true });
    field.current?.select();
  }, [focusAsk]);

  const submit = (event: Event) => {
    event.preventDefault();
    if (!id || !draft.trim()) return;
    void goTo(id, draft, space);
    setEditing(false);
    field.current?.blur();
  };
  const leave = () => { setEditing(false); field.current?.blur(); };
  return (
    <form class="browser-address-form" onSubmit={submit}>
      {editable
        ? <Omnibox field={field} id={id} draft={draft} onDraft={setDraft}
            tabs={() => browserPages.peek().filter((item) => item.space === space || (item.space === GLOBAL_SPACE && !isMobile.peek())).map((item) => ({ id: item.id, url: item.url, title: item.title }))}
            onOpen={(address) => { if (id) void goTo(id, address, space); leave(); }}
            onSwitch={(tab) => { leave(); switchToTab(tab); }}
            onEscape={() => { setDraft(url); leave(); }}
            onBlur={() => { if (!blank) setEditing(false); }} />
        : <button type="button" class="browser-address browser-address-view" aria-label="Website address" title={url}
            onClick={() => { setEditing(true); setFocusAsk((n) => n + 1); }}>
            <span class="browser-url">{displayAddress(url)}</span>
          </button>}
    </form>
  );
}

export function BrowserHeader(props: { id: string | undefined }) {
  const { id } = props;
  const space = useSpace();
  const entry = tabsOf(space).find((item) => item.id === id);
  const page = browserPages.value.find((item) => item.id === id);
  const app = isAppTab(entry) ? entry : undefined;
  const blank = !entry || entry.kind === 'new';
  const live = Boolean(id && page) && !blank && !app;
  const go = (action: 'back' | 'forward' | 'reload') => { if (id) void command({ action, id }); };
  const finding = live && id !== undefined && findOpen.value?.id === id;
  return (
    <div class="browser-bar" role="toolbar" aria-label="Browser">
      <IconButton icon="caret-left" label="Back" size="small" disabled={!live || !page?.back} onClick={() => go('back')} />
      <IconButton icon="caret-right" label="Forward" size="small" disabled={!live || !page?.forward} onClick={() => go('forward')} />
      <IconButton icon="arrow-clockwise" label="Reload" size="small" disabled={!live} onClick={() => go('reload')} />
      {app?.kind === 'file' || app?.kind === 'folder' ? <PathField key={app.id} id={app.id} path={app.path} device={app.device} />
        : app
        ? <div class="browser-address-form"><div class="browser-address browser-address-view is-static"><span class="browser-url">{APP_KIND_LABEL[app.kind]}</span></div></div>
        : finding ? <FindField id={id!} page={page} /> : <Address id={id} page={page} blank={blank} />}
      <PaneMenu id={id} />
      {live && page?.loading && <span class="browser-loading" aria-hidden="true" />}
    </div>
  );
}
