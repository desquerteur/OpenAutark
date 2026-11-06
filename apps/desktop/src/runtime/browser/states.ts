// The shapes BrowserService answers with: a tab's state as the agent reads it, the state after steps with its change
// list (diff.ts), act and batch outcomes, the mark taken before steps and tab infos.
// Owns: these shapes. Never: behaviour.

import type { BrowserAction, PageLike } from './page.ts';
import type { PointerMove } from './motion.ts';
import type { SnapshotChanges } from './diff.ts';
import type { StepRun } from './batch.ts';

export interface PageState {
  tab: string;
  url: string;
  title: string;
  snapshot: string;
  truncated: boolean;
  /** The page shows a human check (captcha) – reported as a fact (human-check.ts). */
  humanCheck?: true;
}

/** A page state after steps: whether and how it changed against the agent's last snapshot of the tab. */
export interface Reviewed extends PageState {
  changed: boolean;
  urlChanged: boolean;
  changes: SnapshotChanges;
  /** The steps opened this tab (or closed theirs): the state is of another tab than the one acted on. */
  newTab?: true;
}

export interface ActOutcome extends Reviewed {
  action: BrowserAction;
  /** Where the page's mouse went for a pointer action, on tab `tab`. */
  point?: PointerMove & { tab: string };
}

export interface BatchOutcome extends Reviewed, StepRun { total: number }

/** What the agent last saw of a tab before steps (mark → review). */
export interface Mark { url: string; text?: string; look?: { url: string; title: string }; pages: Set<PageLike> }

export interface TabInfo { tab: string; url: string; title: string; active: boolean }
