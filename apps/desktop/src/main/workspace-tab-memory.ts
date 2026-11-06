// Two small memories of the person's browser, as in Chrome: the recently closed tabs (Ctrl+Shift+T opens the last one of
// a space again – at most CLOSED_KEPT, this app session only, in memory) and the zoom per site (Ctrl+= / Ctrl+- / Ctrl+0 –
// Chrome's zoom steps; a site at 100 % has no entry; at most MAX_ZOOM_SITES in <data>/workspace-zoom.json, the newest kept).
// Owns: both lists and the zoom file. Never: imports electron or reads pages.

import { NODE_FILES, type TabFiles } from './workspace-tabs.ts';

export const CLOSED_KEPT = 30;
export interface ClosedTab { url: string; space: string }

/** The recently closed tabs, newest last (only http(s) pages; a blank tab is no page to reopen). */
export class ClosedTabs {
  private readonly list: ClosedTab[] = [];

  push(tab: ClosedTab): void {
    if (!/^https?:\/\//i.test(tab.url)) return;
    this.list.push(tab);
    if (this.list.length > CLOSED_KEPT) this.list.shift();
  }

  /** The tab closed last in `space`. */
  pop(space: string): ClosedTab | undefined {
    const at = this.list.findLastIndex((tab) => tab.space === space);
    return at < 0 ? undefined : this.list.splice(at, 1)[0];
  }
}

/** Chrome's zoom steps in percent. */
export const ZOOM_STEPS: readonly number[] = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
export const MAX_ZOOM_SITES = 200;

/** The next zoom from `current` (percent): one step in or out, or back to 100. */
export function zoomStep(current: number, step: 1 | -1 | 0): number {
  if (step === 0) return 100;
  if (step > 0) return ZOOM_STEPS.find((value) => value > current + 0.5) ?? ZOOM_STEPS.at(-1)!;
  return [...ZOOM_STEPS].reverse().find((value) => value < current - 0.5) ?? ZOOM_STEPS[0]!;
}

/** The site a zoom is kept for: the page's host name (as Chrome keeps it), or undefined for anything but http(s). */
export function zoomSite(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : undefined;
  } catch { return undefined; }
}

export class SiteZoom {
  private readonly sites = new Map<string, number>();
  private readonly file: string | undefined;
  private readonly files: TabFiles;

  constructor(options: { file?: string; files?: TabFiles } = {}) {
    this.file = options.file;
    this.files = options.files ?? NODE_FILES;
    let value: unknown;
    try { value = JSON.parse(this.file ? this.files.read(this.file) ?? '' : ''); } catch { value = undefined; }
    const sites = (value as { sites?: unknown })?.sites;
    if (sites && typeof sites === 'object' && !Array.isArray(sites)) {
      for (const [site, percent] of Object.entries(sites as Record<string, unknown>)) {
        if (typeof percent === 'number' && ZOOM_STEPS.includes(percent) && percent !== 100 && /^[\w.:[\]-]{1,253}$/.test(site)) this.sites.set(site, percent);
        if (this.sites.size >= MAX_ZOOM_SITES) break;
      }
    }
  }

  /** The kept zoom of the page's site in percent (100 when none). */
  percent(url: string): number {
    const site = zoomSite(url);
    return (site && this.sites.get(site)) || 100;
  }

  /** Keeps `percent` for the page's site (100 forgets it) and saves the file. */
  set(url: string, percent: number): void {
    const site = zoomSite(url);
    if (!site || !ZOOM_STEPS.includes(percent)) return;
    this.sites.delete(site);
    if (percent !== 100) this.sites.set(site, percent);
    while (this.sites.size > MAX_ZOOM_SITES) this.sites.delete(this.sites.keys().next().value!);
    if (!this.file) return;
    try { this.files.write(this.file, `${JSON.stringify({ version: 1, sites: Object.fromEntries(this.sites) }, null, 1)}\n`); }
    catch { /* read-only profile: the zoom holds until the app closes */ }
  }
}
