// The live view of one agent's own browser, used by Team's agent browser view (team/AgentBrowser.tsx) and
// inline in a browser agent's confirm to-do (tasks/BrowserTodo.tsx): the agent's active tab (frames at most
// twice a second, only while this view is shown and the window is not hidden), the tab list, back / forward /
// reload, an address field and – on the PC – Show window / Hide window for the real window. Take over hands the
// browser to the person and makes the picture an input surface (BrowserSurface.tsx); Hand back returns it and
// wakes the agent. With `openAt` a closed browser offers Open browser again, taken over at that address. Phones
// pull frames (browser.pull); on a touch screen a takeover offers Type (BrowserKeys.tsx) and Zoom / Fit. Named
// cursors lie over the picture (PointerLayer.tsx).
// Owns: the shared feed subscription per view, the toolbar, the takeover controls and the view.
// Never: runs a feed of its own (browser-feed.ts), keeps watching while nothing is shown, or
// keeps what the person types.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PULL_DEFAULT_BYTES, PULL_WAIT_MAX_MS, type BrowserSteer, type BrowserViewState } from '../../shared/model/browser.ts';
import { fullDate, time } from '../lib/format.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can, isOwner } from '../lib/session.ts';
import { agentName } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button, Icon, IconButton, Menu, Spinner } from '../lib/ui.tsx';
import { createBrowserFeed } from './browser-feed.ts';
import type { BrowserFeedView } from './browser-feed.ts';
import { BrowserSurface } from './BrowserSurface.tsx';
import { PointerLayer } from './PointerLayer.tsx';
import { addressFocus } from './pages.ts';

const PULL = { maxBytes: PULL_DEFAULT_BYTES, waitMs: PULL_WAIT_MAX_MS };

const feed = createBrowserFeed({
  subscribe: (agentId) => rpc.call('browser.subscribe', { agentId }),
  unsubscribe: (agentId) => rpc.call('browser.unsubscribe', { agentId }),
  onState: (listener) => rpc.on('browser.view', listener),
  onFrame: (listener) => rpc.on('browser.frame', listener),
  onOpen: (listener) => rpc.onOpen(listener),
  errorText,
  pulls: () => !isOwner(),
  pull: (agentId, after) => rpc.call('browser.pull', { agentId, after, ...PULL }),
  pullPart: (agentId, at, index) => rpc.call('browser.pullPart', { agentId, at, index }),
});

/** A touch screen (the takeover then offers Type and Zoom). */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(pointer: coarse)');
    const update = () => setCoarse(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return coarse;
}

/** One agent's browser. */
export interface BrowserTarget { agentId: string }

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/** The shared feed of `target`, subscribed while `watching`; the last frame stays (as paused) while not. */
function useBrowserView(target: BrowserTarget, watching: boolean): BrowserFeedView {
  const [view, setView] = useState<BrowserFeedView>({ state: null, frame: null, error: null });
  const key = target.agentId;
  useEffect(() => { setView({ state: null, frame: null, error: null }); }, [key]);
  useEffect(() => {
    if (!watching) return;
    return feed.subscribe(target.agentId, setView);
  }, [key, watching]);
  return view;
}

export function Address(props: { url: string; disabled: boolean; onGo: (url: string) => void; focusSpace?: string }) {
  const [draft, setDraft] = useState(props.url);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setDraft(props.url); }, [props.url, editing]);
  // Ctrl+L in a remote website tab (pane-shortcuts.ts): this row's field takes the keyboard, its text selected.
  const asked = addressFocus.value;
  const seen = useRef(asked.ask);
  useEffect(() => {
    if (props.focusSpace === undefined || asked.space !== props.focusSpace || asked.ask === seen.current) return;
    seen.current = asked.ask;
    input.current?.focus();
    input.current?.select();
  }, [asked, props.focusSpace]);
  const submit = (event: Event) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    props.onGo(value);
    setEditing(false);
    (event.currentTarget as HTMLFormElement).querySelector('input')?.blur();
  };
  // the field and Go (display: contents – both are cells of the toolbar row)
  return (
    <form class="browser-live-address" onSubmit={submit}>
      <span class="browser-live-field">
        <input ref={input} class="browser-live-input" type="text" aria-label="Address" placeholder={props.disabled ? '' : 'Enter URL'} spellcheck={false} autocomplete="off"
          value={draft} disabled={props.disabled}
          onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}
          onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)} />
      </span>
      <IconButton type="submit" icon="arrow-right" label="Go to website" size="small" disabled={props.disabled} />
    </form>
  );
}

function tabLabel(tab: BrowserViewState['tabs'][number]): string {
  if (tab.title) return tab.title;
  try { return new URL(tab.url).hostname || tab.url; } catch { return tab.url || 'New tab'; }
}

function Placeholder(props: { state: BrowserViewState | null; name: string; reopen: boolean }) {
  const { state, name } = props;
  if (state && !state.open) {
    return <div class="browser-live-empty"><Icon name="globe" size={24} /><p>{name}'s browser is not open. {props.reopen ? 'Open it again to use it here.' : `It opens when ${name} starts browsing.`}</p></div>;
  }
  return <Spinner size={18} />;
}

/** The agent's own tabs: a menu cell in the toolbar; choosing one steers the browser to it. */
function AgentTabs(props: { tabs: BrowserViewState['tabs']; onChoose: (tab: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { tabs } = props;
  return (
    <span class="browser-live-tabs">
      <IconButton icon="caret-down" label={tabs.length ? `Tabs, ${tabs.length} open` : 'Tabs'} title="Tabs" size="small" disabled={!tabs.length}
        pressed={anchor !== null} aria-haspopup="menu" aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget as HTMLElement)} />
      {tabs.length > 0 && <span class="browser-live-tabs-count tabular" aria-hidden="true">{tabs.length}</span>}
      <Menu anchor={anchor} open={anchor !== null && tabs.length > 0} onClose={() => setAnchor(null)} placement="bottom-end" label="Tabs"
        sections={[{ items: tabs.map((tab) => ({ label: tabLabel(tab), checked: tab.active, onSelect: () => { if (!tab.active) props.onChoose(tab.tab); } })) }]} />
    </span>
  );
}

/** Take over / Hand back (browser.takeover); the agent is woken on Hand back. */
export async function setTakeover(target: BrowserTarget, on: boolean, extra: { url?: string; wake?: boolean } = {}): Promise<BrowserViewState> {
  return rpc.call('browser.takeover', { agentId: target.agentId, on, ...extra });
}

/** Both labels of a two-state button in one cell (workspace-chrome.css .workspace-swap): the box never changes; only the shown one is named. */
function SwapLabel(props: { on: boolean; off: string; onLabel: string }) {
  return <span class="workspace-swap"><span aria-hidden={props.on ? 'true' : undefined}>{props.off}</span><span aria-hidden={props.on ? undefined : 'true'}>{props.onLabel}</span></span>;
}

/** `children` come first; `openAt`: a closed browser offers Open browser (taken over) at it; `trail`: a cell at the toolbar's end (the side pane's menu). */
export function BrowserLive(props: { target: BrowserTarget; openAt?: string; children?: ComponentChildren; trail?: ComponentChildren }) {
  const { target } = props;
  const visible = useDocumentVisible();
  const { state, frame, error } = useBrowserView(target, visible);
  const [inputError, setInputError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<1 | 2>(1);
  const keys = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const touch = useCoarsePointer();
  const takeover = state?.takeover;
  useEffect(() => { setInputError(null); }, [Boolean(takeover), frame?.tab]);
  useEffect(() => { if (!takeover) setZoom(1); }, [Boolean(takeover)]);

  const name = agentName(target.agentId);
  const browser = `${name}'s browser`;
  const open = state?.open === true;
  const steer = (input: BrowserSteer) => {
    rpc.call('browser.navigate', { agentId: target.agentId, ...input }).catch((failure) => toastError(failure, 'The browser could not do that'));
  };
  const takeOver = async (on: boolean, url?: string) => {
    setBusy(true);
    try {
      await setTakeover(target, on, url ? { url } : {});
    } catch (failure) {
      toastError(failure, !on ? 'Could not hand the browser back' : url ? 'Could not open the browser' : 'Could not take the browser over');
    } finally { setBusy(false); }
  };
  const reopen = props.openAt !== undefined && state?.open === false && can('browser.takeover');
  const active = state?.tabs.find((tab) => tab.active);
  const shown = frame;
  const problem = error ?? state?.error ?? inputError;
  const usable = Boolean(takeover) && can('browser.input');
  const status = !takeover ? ''
    : touch && usable && shown
      ? `You are using ${browser}: tap to click, drag to scroll. ${name} waits until you hand it back.`
      : `You are using ${browser}${usable && shown ? ': clicks and keys go to the page (Esc returns the keyboard to the app)' : ''}. ${takeover.waiting ? `${name} is waiting for you to hand it back.` : `${name} does not use it until you hand it back.`}`;

  const live = visible ? 'Live' : 'Paused';
  const line = problem ?? (status || (shown ? `${live} · ${time(shown.at)}` : ''));

  return (
    <div class="workspace-screen">
      {props.children}
      <div class="browser-live-toolbar" data-inert={open ? undefined : ''}>
        <IconButton icon="caret-left" label="Back" size="small" disabled={!open} onClick={() => steer({ action: 'back' })} />
        <IconButton icon="caret-right" label="Forward" size="small" disabled={!open} onClick={() => steer({ action: 'forward' })} />
        <IconButton icon="arrow-clockwise" label="Reload" size="small" disabled={!open} onClick={() => steer({ action: 'reload' })} />
        <Address url={active?.url ?? ''} disabled={!open} onGo={(url) => steer({ url })} />
        <AgentTabs tabs={open ? state?.tabs ?? [] : []} onChoose={(tab) => steer({ tab })} />
        {props.trail && <span class="browser-live-trail">{props.trail}</span>}
      </div>
      {/* the controls row: reserved while the view exists, so the picture below never moves when buttons come */}
      <div class="browser-live-bar">
        {reopen && (
          <Button icon="app-window" busy={busy} onClick={() => void takeOver(true, props.openAt)} title={`Open ${browser} here – ${name} waits until you hand it back`}>Open browser</Button>
        )}
        {open && can('browser.takeover') && (
          <Button variant={takeover ? 'primary' : 'secondary'} icon={takeover ? 'check' : 'user'} busy={busy} onClick={() => void takeOver(!takeover)}
            title={takeover ? `Give the browser back to ${name} and let it continue` : `Use ${browser} yourself – ${name} waits meanwhile`}>
            <SwapLabel on={Boolean(takeover)} off="Take over" onLabel="Hand back" />
          </Button>
        )}
        {/* in its place on every agent tab; disabled where the window is not on this screen (a phone) */}
        {open && (
          <Button icon="app-window" disabled={!isOwner()} onClick={() => steer({ window: state?.shown ? 'hide' : 'show' })}
            title={!isOwner() ? 'The window is on the PC'
              : state?.shown ? 'Put the window back off-screen' : `Bring the window of ${browser} onto your screen to use it yourself`}>
            <SwapLabel on={Boolean(state?.shown)} off="Show window" onLabel="Hide window" />
          </Button>
        )}
        {open && touch && usable && shown && (
          <>
            <Button variant="ghost" onClick={() => keys.current?.focus({ preventScroll: true })} title="Open the keyboard and type into the page">Type</Button>
            <Button variant="ghost" aria-pressed={zoom === 2} onClick={() => setZoom(zoom === 2 ? 1 : 2)}
              title={zoom === 2 ? 'Fit the page into the view' : 'Show the page at twice the size – drag to move around'}>
              <SwapLabel on={zoom === 2} off="Zoom" onLabel="Fit" />
            </Button>
          </>
        )}
        <p class="workspace-screen-meta tabular" role="status" title={line || undefined}>
          {shown && !problem && !status ? <time dateTime={new Date(shown.at).toISOString()} title={fullDate(shown.at)}>{line}</time> : line}
        </p>
      </div>
      <div class="workspace-screen-view" ref={viewRef}>
        {shown
          ? <BrowserSurface frame={shown} alt={`Browser of ${name}${active?.title ? `: ${active.title}` : ''}`} takeover={usable} zoom={touch ? zoom : 1} keys={touch ? keys : undefined}
              send={(tab, input) => rpc.call('browser.input', { agentId: target.agentId, tab, input })} onError={(failure) => setInputError(errorText(failure))} />
          : <Placeholder state={state} name={name} reopen={reopen} />}
        {shown && <PointerLayer agentId={target.agentId} frame={shown} view={viewRef} />}
      </div>
    </div>
  );
}
