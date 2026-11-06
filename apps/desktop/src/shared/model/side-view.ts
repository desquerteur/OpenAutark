// A website tab of the person's side browser watched from another of their PCs or from their phone (B-076, the owner's
// 05.11.2026 wish): the page runs, loads and keeps its logins only on the PC where it was opened; the viewer gets a live
// picture of it (a DevTools screencast, pulled one frame at a time like browser.pull) and sends clicks, wheel turns,
// keys, text and navigation back. main/side-driver/caster.ts casts, runtime/browser/side-view.ts holds the pulls,
// runtime/devices/side-view.ts carries them between linked PCs, ui/workspace/RemoteWebTab.tsx shows them.
// side.* are merged into Methods by module augmentation.
// Owns: these shapes and their limits. Never: behaviour.

import type { BrowserInput, BrowserNavigation } from './browser.ts';

/** A pull waits at most this long for a change by default: each pull keeps the page awake on its PC, so a page the
 *  person there stopped showing paints again within this time. */
export const SIDE_WAIT_MS = 5000;
/** A forwarded frame part stays this small, so one picture never holds up the link's other traffic for long. */
export const SIDE_PART_BYTES = 1024 * 1024;
/** A side-browser tab id (main/workspace-browser.ts makes them: 'web-<uuid>'). */
export const SIDE_TAB_ID = /^web-[a-zA-Z0-9-]{1,80}$/;

/** A dialog the page opened on its PC (alert, confirm, beforeunload …): the page waits until it is answered. */
export interface SideDialog { type: string; message: string }

/** The page as it is on its PC. */
export interface SidePage {
  url: string;
  title: string;
  back: boolean;
  forward: boolean;
  loading: boolean;
  /** Open while the page waits for an answer (side.nav `dialog`). */
  dialog?: SideDialog;
}

export interface SideViewState extends SidePage {
  /** The tab id on the PC where the page runs ('web-…'). */
  tab: string;
  /** The name of that PC ("office-pc"). */
  pc: string;
  /** The tab is open there. */
  open: boolean;
  /** Frames flow. */
  live: boolean;
  /** Why nothing can be shown (the tab closed, its DevTools hold it …). */
  error?: string;
  at: number;
}

export interface SideFrame {
  tab: string;
  /** JPEG, base64, at most 1280 px on either side. */
  data: string;
  /** The page viewport (gives the frame's aspect ratio and the click mapping's units). */
  width: number;
  height: number;
  at: number;
}

/** side.pull: the next state or frame after `after`; `device` – the PC where the tab runs (omitted: this PC). */
export interface SidePullRequest {
  device?: string;
  tab: string;
  after?: { state?: number; frame?: number };
  maxBytes?: number;
  waitMs?: number;
}

/** With `parts` > 1, `frame.data` is part 0 – fetch parts 1 … parts-1 with side.pullPart and join them. */
export interface SidePull {
  state: SideViewState;
  frame?: SideFrame;
  parts?: number;
}

export interface SidePartRequest {
  device?: string;
  tab: string;
  at: number;
  index: number;
}

/** side.nav: exactly one of an http(s) address, back / forward / reload, or the answer to the page's open dialog. */
export interface SideNav {
  device?: string;
  tab: string;
  url?: string;
  action?: BrowserNavigation;
  dialog?: 'accept' | 'dismiss';
}

// ------------------------------------------------------------------ main ↔ runtime (host bridge)

/** One DevTools input command main runs in the tab (only Input.dispatchMouseEvent, dispatchKeyEvent, insertText). */
export interface SideCommand { method: string; params: Record<string, unknown> }

/** The screencast frame's viewport as Chrome reports it, plus the tab's zoom (main → runtime; the runtime maps clicks). */
export interface SideFrameMeta { deviceWidth: number; deviceHeight: number; offsetTop: number; pageScaleFactor: number; zoom: number }

/** What main tells the runtime about a cast tab: the page with every frame and when it navigates; `error` ends the cast. */
export interface SideCastUpdate {
  tab: string;
  page: SidePage;
  live: boolean;
  error?: string;
  frame?: { data: string; meta: SideFrameMeta };
}

declare module '../api/methods.ts' {
  interface Methods {
    /** One state or frame at a time of a side-browser tab, on this PC or (device) a linked PC of the owner. */
    'side.pull': { params: SidePullRequest; result: SidePull };
    /** The next part of a frame too large for one reply (side.pull `parts`). */
    'side.pullPart': { params: SidePartRequest; result: { data: string } };
    /** The person's mouse, wheel, key or text input on that tab – it goes to the page on its PC (typed text is never kept). */
    'side.input': { params: { device?: string; tab: string; input: BrowserInput }; result: { ok: true } };
    /** A new address, back, forward, reload or the answer to the page's dialog in that tab on its PC. */
    'side.nav': { params: SideNav; result: { ok: true } };
  }
}
