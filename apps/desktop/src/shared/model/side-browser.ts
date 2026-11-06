// Agents in the person's browser tabs (the global pane, a chat's area above its messages) – the call the runtime sends to
// main (host op `sideBrowser`, main/side-driver/**) and its answer. Agents reach its tabs through the DevTools protocol,
// with their named cursor drawn in the page and the person's input going first; a tab an agent opens carries the agent
// and the chat. Its tabs live in spaces: 'global' (where the person works), 'chat:<id>' (shared by everyone in that chat)
// and 'agent:<id>' (an agent's own area on its agent page).
// Owns: the call/answer shapes and their limits. Never: behaviour.

import type { MotionStyle } from './pointer-motion.ts';

export const SIDE_TEXT_MAX = 24_000;
export const SIDE_STEPS_MAX = 20;
export const SIDE_WAIT_MAX_MS = 30_000;

export type SideAction = 'tabs' | 'open' | 'close' | 'snapshot' | 'find' | 'act' | 'screenshot' | 'text' | 'console' | 'network' | 'eval' | 'wait';

export type SideStepAction =
  | 'click' | 'double_click' | 'right_click' | 'hover' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck'
  | 'scroll' | 'scroll_into_view' | 'back' | 'forward' | 'reload';

export interface SideActStep {
  action: SideStepAction;
  /** A ref from the tab's last snapshot or find ('s123'). */
  ref?: string;
  /** Viewport CSS px, when there is no ref (click/hover/scroll at a point). */
  x?: number;
  y?: number;
  value?: string;
  values?: string[];
  key?: string;
  dx?: number;
  dy?: number;
}

export interface SideBrowserCall {
  action: SideAction;
  /** A side tab id ('web-…'); default the space's shown tab. */
  tab?: string;
  /** The space a call without a tab means, and where a new tab opens: 'global' (default) or 'chat:<id>'. */
  space?: string;
  /** The agent acting (its named cursor in the page; the opener of a tab it opens). */
  agent: { id: string; name: string };
  /** The chat the agent works for (the opener of a tab it opens). */
  chat?: string;
  url?: string;
  /**
   * open: true – a tab of its own; false – the tab named, else the space's tab; left out – the agent's preview tab in
   * that space (new when it has none), which its next page takes over until the person uses it. `show`: the person's
   * browser shows it at once (browser.show).
   */
  newTab?: boolean;
  show?: boolean;
  query?: string;
  /** act: one step, or several (stops at the first failing one). */
  steps?: SideActStep[];
  /** snapshot: the whole tree instead of the changes since this agent's last look. */
  full?: boolean;
  expression?: string;
  pattern?: string;
  errorsOnly?: boolean;
  limit?: number;
  /** network: the response body of this request. */
  requestId?: string;
  wait?: { text?: string; url?: string; change?: boolean; idle?: boolean; timeoutMs?: number };
  region?: { x: number; y: number; width: number; height: number };
  maxEdge?: number;
  motion?: MotionStyle;
}

export interface SideTabInfo { id: string; url: string; title: string; active: boolean; by?: string }

export interface SideBrowserResult {
  ok: boolean;
  /** Why it failed, as one sentence for the agent. */
  error?: string;
  tab?: string;
  url?: string;
  title?: string;
  /** snapshot / find / text / console / network / eval output (capped at SIDE_TEXT_MAX). */
  text?: string;
  /** act: what changed in the page (added/removed lines, dialogs, address). */
  changes?: string;
  /** How many steps of an act ran (all on success). */
  done?: number;
  image?: { data: string; mime: string; width: number; height: number };
  tabs?: SideTabInfo[];
  /** The page asks for a human check (captcha). */
  humanCheck?: boolean;
  /** Refused because the person used this tab within the last 2 s. */
  personActive?: boolean;
}
