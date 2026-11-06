// Marks on the person's browser tabs (main/workspace-browser.ts) while the app runs: a tab opened in the background and
// not shown yet, the agent (and chat) that opened a tab, and an agent's preview tab – the `transient` tab its next page
// in that space takes over, until the person uses the page (a click or a key in it, an address of their own), double-
// clicks the tab or keeps it from a menu. Nothing here is saved: after a restart every tab is a tab of its own.
// Owns: these marks. Never: imports electron, opens, loads or closes a tab.

import type { PageOpener, WorkspaceBrowserPage } from '../shared/api/workspace-browser.ts';

export class TabMarks {
  private readonly background = new Set<string>();
  private readonly openers = new Map<string, PageOpener>();
  private readonly previews = new Set<string>();

  /** A new tab: in the background unless `show`, with the agent that opened it – its preview tab with `preview`. */
  opened(id: string, show: boolean, opener?: PageOpener, preview = false): void {
    if (!show) this.background.add(id);
    if (opener) this.openers.set(id, opener);
    if (opener && preview) this.previews.add(id);
  }

  opener(id: string): PageOpener | undefined { return this.openers.get(id); }

  /** The tab was shown: no background tab any more (true when that changed something). */
  shown(id: string): boolean { return this.background.delete(id); }

  /** A tab of its own from now on (true when it was a preview). */
  keep(id: string): boolean { return this.previews.delete(id); }

  /** The preview tab of `agentId` among the tabs `here` takes (one space's), if it has one. */
  previewOf(agentId: string, here: (id: string) => boolean): string | undefined {
    for (const id of this.previews) if (this.openers.get(id)?.agentId === agentId && here(id)) return id;
    return undefined;
  }

  /** What a tab's page entry says of its marks. */
  page(id: string): Pick<WorkspaceBrowserPage, 'background' | 'transient'> {
    return { ...(this.background.has(id) ? { background: true } : {}), ...(this.previews.has(id) ? { transient: true as const } : {}) };
  }

  /** The tab went. */
  closed(id: string): void { this.background.delete(id); this.openers.delete(id); this.previews.delete(id); }
}
