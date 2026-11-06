// Where a page an agent uses lives while the person does not look at it. A page nobody sees draws nothing: a click hangs
// and a picture fails, whether it is a hidden child of the app window, on a hidden window or on none (measured 02.11.2026
// with the real side driver). The host is a window with no renderer of its own, shown without focus outside every screen
// and fully transparent, and its pages run unthrottled; there they take real input and answer pictures, with the app
// window open or closed. It exists only while it holds a page. A page goes back when it is shown (workspace-browser.ts)
// or after AGENT_IDLE_MS without an agent, as an agent's own browser idles out; a page only the person watched from
// another PC or a phone (B-076) goes back when that watch ends – watching is no agent's use.
// Owns: the host window, who is on it and the agents' last use. Never: decides which tab an agent means or closes a page.

import { BaseWindow, type WebContentsView } from 'electron';

const AGENT_IDLE_MS = 10 * 60_000;
/** The size of a page on the host. */
const PAGE = { x: 0, y: 0, width: 1280, height: 800 };

/** The time a page stays without an agent: a test profile (WORKFORCE_TEST_DATA) may shorten it with WORKFORCE_TAB_IDLE_MS (≥ 100), a real profile never. */
export function agentIdle(env: Record<string, string | undefined> = process.env): number {
  const test = Number(env.WORKFORCE_TAB_IDLE_MS);
  return env.WORKFORCE_TEST_DATA && test >= 100 ? test : AGENT_IDLE_MS;
}

export class PageHost {
  private window: BaseWindow | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pages = new Set<string>();
  private readonly usedAt = new Map<string, number>();
  private readonly idle = agentIdle();
  private readonly leave: (id: string) => void;

  /** `leave`: an idle page has to go (the browser calls release). */
  constructor(leave: (id: string) => void) {
    this.leave = leave;
  }

  has(id: string): boolean { return this.pages.has(id); }

  /** An agent uses this page now. */
  touch(id: string): void { this.usedAt.set(id, Date.now()); }

  /** An agent used this page within the idle time. */
  usedLately(id: string): boolean { return Date.now() - (this.usedAt.get(id) ?? 0) < this.idle; }

  /** On the host, or used by an agent lately. */
  working(id: string): boolean { return this.pages.has(id) || this.usedLately(id); }

  /** The page moves here (and out of its window) and draws. */
  take(id: string, view: WebContentsView): void {
    if (this.pages.has(id)) return;
    if (!this.window) {
      this.window = new BaseWindow({ show: false, x: -32000, y: -32000, width: PAGE.width, height: PAGE.height, frame: false, skipTaskbar: true, focusable: false, hasShadow: false, type: 'toolbar' });
      this.window.setOpacity(0); this.window.setIgnoreMouseEvents(true); this.window.showInactive();
    }
    this.window.contentView.addChildView(view);
    view.setBounds(PAGE); view.setVisible(true);
    view.webContents.setBackgroundThrottling(false);
    this.pages.add(id);
    this.timer ??= setTimeout(() => this.sweep(), this.idle);
  }

  /** The page moves into `into` (hidden), or to no window at all, where it waits for a next use or the memory saver. */
  release(id: string, view: WebContentsView, into: BaseWindow | null): void {
    if (!this.pages.delete(id)) return;
    if (!view.webContents.isDestroyed()) view.webContents.setBackgroundThrottling(true);
    if (into) into.contentView.addChildView(view); else this.window?.contentView.removeChildView(view);
    view.setVisible(false);
    this.end();
  }

  /** The tab is gone. */
  forget(id: string, view: WebContentsView): void {
    this.usedAt.delete(id);
    if (!this.pages.delete(id)) return;
    this.window?.contentView.removeChildView(view);
    this.end();
  }

  private end(): void {
    if (this.pages.size || !this.window) return;
    this.window.destroy(); this.window = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private sweep(): void {
    this.timer = null;
    const now = Date.now();
    for (const id of [...this.pages]) if (now - (this.usedAt.get(id) ?? 0) >= this.idle) this.leave(id);
    if (this.pages.size) this.timer = setTimeout(() => this.sweep(), Math.min(this.idle, 60_000));
  }
}
