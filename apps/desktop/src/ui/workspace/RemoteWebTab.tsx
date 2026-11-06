// A website tab that runs on another of the person's PCs – or, on the phone, on its PC (B-076, the owner's 05.11.2026
// wish). The page stays where it was opened: it loads, sends and keeps its logins there; this view shows its live
// picture (side.pull, at most 2 frames a second on a PC and 1 on a phone, only while the window is shown) and sends
// every click, drag, wheel turn, key and paste there (side.input through BrowserSurface – always usable, no takeover
// step; the keyboard comes to the picture only with a click on it, and the pane's tab shortcuts stay the app's), plus
// back / forward / reload and a new address (side.nav). On a touch screen a tap clicks, a finger scrolls, Type opens the
// keyboard and Zoom shows the page at twice the size (browser-touch.ts, BrowserKeys.tsx). A blue glow lies inside the
// view's edge. The toolbar keeps the address row's cells where every other tab has them – Back, Forward and Reload
// first, the pane's menu cell last (`trail`) – with the PC's mark ("on office-pc"; in a narrow pane its icon) as a
// fixed cell before the address. A dialog the page opens there (alert, confirm …) lies over the picture in one fixed
// place with its answers. While that PC cannot be reached one calm line takes the picture's place and the pulls try
// again every RETRY_MS; while this window has no connection the offline line stands there and input is dropped, never
// sent later. Nothing moves: the cells are fixed, buttons only change their color, the touch buttons float.
// Owns: the feed of remote side tabs, this view and its PC-name lookup (helpers: remote-web.ts). Never: loads the page here, runs a feed per
// view (browser-feed.ts shares one per tab), or keeps what the person types.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PULL_DEFAULT_BYTES, type BrowserInput } from '../../shared/model/browser.ts';
import { SIDE_WAIT_MS, type SideDialog, type SideFrame, type SideNav, type SideViewState } from '../../shared/model/side-view.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';
import { Button, Icon, IconButton, Spinner } from '../lib/ui.tsx';
import { createBrowserFeed, type FeedView } from './browser-feed.ts';
import { Address, useCoarsePointer, useDocumentVisible } from './BrowserLive.tsx';
import { BrowserSurface } from './BrowserSurface.tsx';
import { OFFLINE, remoteKey, remoteTarget, sayOnce, whileOpen } from './remote-web.ts';
import { useSpace } from './space.ts';

/** After a failed pull (the PC is offline), the next try while the view stays. */
export const RETRY_MS = 5000;
/** The same input failure is said once in this time. */
const SAY_AGAIN_MS = 5000;

export interface RemoteWebTabProps { device: string; tab: string; url: string; title?: string; trail?: ComponentChildren }

const feed = createBrowserFeed<SideViewState, SideFrame>({
  subscribe: () => Promise.reject(new Error('Side tabs are pulled.')), // pull mode only (pulls below)
  unsubscribe: async () => undefined,
  onState: () => () => {},
  onFrame: () => () => {},
  onOpen: (listener) => rpc.onOpen(listener),
  errorText,
  pulls: () => true,
  pull: (key, after) => rpc.call('side.pull', { ...remoteTarget(key), after, maxBytes: PULL_DEFAULT_BYTES, waitMs: SIDE_WAIT_MS }),
  pullPart: (key, at, index) => rpc.call('side.pullPart', { ...remoteTarget(key), at, index }),
  retryMs: RETRY_MS,
});

/** PC names this window learned (from the pulls, or the owner's device list while a PC is offline). */
const pcNames = new Map<string, string>();
let listing: Promise<void> | null = null;

function usePcName(device: string, state: SideViewState | null): string {
  const [, redraw] = useState(0);
  if (state?.pc) pcNames.set(device, state.pc);
  useEffect(() => {
    if (pcNames.has(device) || !can('devices.list')) return;
    listing ??= rpc.call('devices.list').then((list) => { for (const pc of list) pcNames.set(pc.id, pc.name); }, () => { listing = null; });
    let live = true;
    void listing?.then(() => { if (live) redraw((n) => n + 1); });
    return () => { live = false; };
  }, [device]);
  return pcNames.get(device) ?? 'another PC';
}

function useRemoteView(key: string, watching: boolean): FeedView<SideViewState, SideFrame> {
  const [view, setView] = useState<FeedView<SideViewState, SideFrame>>({ state: null, frame: null, error: null });
  useEffect(() => { setView({ state: null, frame: null, error: null }); }, [key]);
  useEffect(() => (watching ? feed.subscribe(key, setView) : undefined), [key, watching]);
  return view;
}

const fresh = sayOnce(SAY_AGAIN_MS);
/** An input the page did not take: said in the status line, the same text at most once per SAY_AGAIN_MS. */
function inputFailed(error: unknown): void {
  if (fresh(errorText(error))) toastError(error, 'The page did not take that');
}

/** The page's dialog on its PC: the page waits for this answer (an alert has only OK). */
function PageDialog(props: { dialog: SideDialog; pc: string; onAnswer: (answer: 'accept' | 'dismiss') => void }) {
  const { dialog } = props;
  const text = dialog.message || (dialog.type === 'beforeunload' ? 'Leave this page?' : 'The page asks for an answer.');
  return (
    <div class="remote-web-dialog" role="alertdialog" aria-label={`The page on ${props.pc} asks`}>
      <p class="remote-web-dialog-text">{text}</p>
      <div class="remote-web-dialog-actions">
        {dialog.type !== 'alert' && <Button variant="secondary" onClick={() => props.onAnswer('dismiss')}>Cancel</Button>}
        <Button variant="primary" onClick={() => props.onAnswer('accept')}>OK</Button>
      </div>
    </div>
  );
}

export function RemoteWebTab(props: RemoteWebTabProps) {
  const { device, tab } = props;
  const key = remoteKey(device, tab);
  const space = useSpace(); // Ctrl+L in this space focuses the address row (pane-shortcuts.ts)
  const visible = useDocumentVisible();
  const { state, frame, error } = useRemoteView(key, visible);
  const pc = usePcName(device, state);
  const touch = useCoarsePointer();
  const [zoom, setZoom] = useState<1 | 2>(1);
  const keys = useRef<HTMLInputElement>(null);
  const problem = rpc.status.value !== 'open' ? OFFLINE : error ?? state?.error ?? null;
  const shown = problem ? null : frame;
  const usable = can('side.input');
  const ready = Boolean(state && !problem && can('side.nav'));
  const title = state?.title || props.title || '';
  const go = (nav: Omit<SideNav, 'device' | 'tab'>) => {
    rpc.call('side.nav', { ...remoteTarget(key), ...nav }).catch((failure) => toastError(failure, 'The page could not do that'));
  };
  const send = whileOpen(() => rpc.status.peek() === 'open', (frameTab: string, input: BrowserInput) => rpc.call('side.input', { ...remoteTarget(remoteKey(device, frameTab)), input }));

  return (
    <div class="workspace-screen remote-web">
      <div class="browser-live-toolbar">
        <IconButton icon="caret-left" label="Back" size="small" disabled={!ready || !state?.back} onClick={() => go({ action: 'back' })} />
        <IconButton icon="caret-right" label="Forward" size="small" disabled={!ready || !state?.forward} onClick={() => go({ action: 'forward' })} />
        <IconButton icon="arrow-clockwise" label="Reload" size="small" disabled={!ready} onClick={() => go({ action: 'reload' })} />
        <span class="remote-web-mark" role="note" title={`This page runs on ${pc} – clicks and keys go there`}>
          <Icon name="monitor" size={14} /><span class="remote-web-pc">on {pc}</span>
        </span>
        <Address url={state?.url || props.url} disabled={!ready} onGo={(url) => go({ url })} focusSpace={space} />
        {props.trail && <span class="browser-live-trail">{props.trail}</span>}
      </div>
      <div class="workspace-screen-view remote-web-view">
        {shown
          ? <BrowserSurface frame={shown} alt={`Page on ${pc}${title ? `: ${title}` : ''}`} takeover={usable} autoFocus={false} appKeys ring="var(--remote)" zoom={touch ? zoom : 1}
              keys={touch ? keys : undefined} send={send} onError={inputFailed} />
          : problem
            ? <div class="browser-live-empty"><Icon name="monitor" size={24} /><p>{problem}</p></div>
            : <Spinner size={18} />}
        {shown && touch && usable && (
          <div class="remote-web-touch">
            <Button variant="ghost" onClick={() => keys.current?.focus({ preventScroll: true })} title="Open the keyboard and type into the page">Type</Button>
            <IconButton icon={zoom === 2 ? 'arrows-in-simple' : 'arrows-out-simple'} label={zoom === 2 ? 'Fit the page into the view' : 'Show the page at twice the size'}
              pressed={zoom === 2} onClick={() => setZoom(zoom === 2 ? 1 : 2)} />
          </div>
        )}
        {ready && state?.dialog && <PageDialog dialog={state.dialog} pc={pc} onAnswer={(answer) => go({ dialog: answer })} />}
      </div>
    </div>
  );
}
