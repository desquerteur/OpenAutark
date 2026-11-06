// The live view of agents' own browsers as the person sees it: the tabs, the frames of the shown tab, the person's
// input and takeover. Phones never get pushed frames – they pull one at a time (browser.pull, at most one per
// DEVICE_FRAME_GAP_MS), a large frame in parts (browser.pullPart).
// browser.pull / browser.pullPart are merged into Methods by module augmentation.
// Owns: the shapes shared by the runtime (runtime/browser/view.ts, view-pull.ts) and the UI. Never: behaviour.

export interface BrowserTabInfo {
  /** The agent's tab id ('t1' …), the same the agent's browser.* tools use. */
  tab: string;
  url: string;
  title: string;
  /** The agent's active tab (the one the view shows). */
  active: boolean;
}

export interface BrowserViewState {
  agentId: string;
  /** A browser is open for the agent (it opens when the agent starts browsing). */
  open: boolean;
  tabs: BrowserTabInfo[];
  /** The shown tab. */
  tab?: string;
  /** Frames flow (the screencast runs). */
  live: boolean;
  /** The person brought the real window onto the screen (agent browsers start off-screen). */
  shown?: boolean;
  /** Why nothing can be shown. */
  error?: string;
  /** The person has taken the browser over (the agent's browser steps answer that until Hand back). */
  takeover?: BrowserTakeover;
  at: number;
}

export interface BrowserFrame {
  agentId: string;
  tab: string;
  /** JPEG, base64, at most 1280 px on either side. */
  data: string;
  /** The page viewport in CSS pixels (gives the frame's aspect ratio). */
  width: number;
  height: number;
  at: number;
}

/** An open agent browser (browser.list). */
export interface BrowserSessionInfo {
  agentId: string;
  tabs: number;
  url: string;
  title: string;
}

export type BrowserNavigation = 'back' | 'forward' | 'reload';

/** What the person does from the view (browser.navigate): one of tab, url, action or window. */
export interface BrowserSteer {
  /** Switch to this tab (it becomes the agent's active tab). */
  tab?: string;
  /** Open this http(s) URL in the shown tab. */
  url?: string;
  action?: BrowserNavigation;
  /** Bring the off-screen window onto this PC's screen, or put it back. */
  window?: 'show' | 'hide';
}

/** The person uses the agent's browser (Take over, input in the view, Show window) – until Hand back. */
export interface BrowserTakeover {
  since: number;
  /** The agent tried to use its browser meanwhile and waits for the hand back. */
  waiting: boolean;
}

export type BrowserButton = 'left' | 'middle' | 'right';

/**
 * The person's input on the shown frame (browser.input). Pointer positions are on the frame as the person saw it:
 * `x`/`y` within `width` × `height`. Modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. Key and text input goes to the page
 * only – never into logs, the run journal, tool outputs or the agent's context.
 */
export type BrowserInput =
  | { kind: 'mouse'; type: 'down' | 'up' | 'move'; x: number; y: number; width: number; height: number; button?: BrowserButton; buttons?: number; clicks?: number; modifiers?: number }
  | { kind: 'wheel'; x: number; y: number; width: number; height: number; deltaX: number; deltaY: number; modifiers?: number }
  | { kind: 'key'; type: 'down' | 'up'; key: string; code: string; keyCode?: number; modifiers?: number; repeat?: boolean }
  | { kind: 'text'; text: string };

/** Take over (`on`; `url` opens the agent's closed browser there) or hand back (`wake: false`: the agent is not woken – a to-do's answer does that). */
export interface BrowserTakeoverRequest {
  on: boolean;
  url?: string;
  wake?: boolean;
}

// ------------------------------------------------------------------ pulled frames (phones)

/** A device waits at least this long between two frames of one browser (the owner: 500 ms). */
export const DEVICE_FRAME_GAP_MS = 1000;
/** The longest a browser.pull waits for a change (`waitMs`, at least 1000). */
export const PULL_WAIT_MAX_MS = 20_000;
/** Frame characters one reply carries by default (`maxBytes`), and its limits. */
export const PULL_DEFAULT_BYTES = 1024 * 1024;
export const PULL_MIN_BYTES = 16 * 1024;
export const PULL_MAX_BYTES = 4 * 1024 * 1024;

/** browser.pull: the next state or frame after `after` (the `at` of the last ones received). */
export interface BrowserPullRequest {
  agentId: string;
  after?: { state?: number; frame?: number };
  maxBytes?: number;
  waitMs?: number;
}

/** With `parts` > 1, `frame.data` is part 0 – fetch parts 1 … parts-1 with browser.pullPart and join them. */
export interface BrowserPull {
  state: BrowserViewState;
  frame?: BrowserFrame;
  parts?: number;
}

/** browser.pullPart: part `index` of the frame (`at`) the last pull of this caller returned. */
export interface BrowserPartRequest {
  agentId: string;
  at: number;
  index: number;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** One state or frame at a time for a phone. */
    'browser.pull': { params: BrowserPullRequest; result: BrowserPull };
    /** The next part of a frame too large for one reply (browser.pull `parts`). */
    'browser.pullPart': { params: BrowserPartRequest; result: { data: string } };
  }
}
