// The person's browser session rules – one fixed rule, nobody is asked: a page's own site may use the camera, the
// microphone, notifications, fullscreen and writing to the clipboard; every other permission, every device chooser
// and anything a frame of another site asks for are refused. Downloads go to <workspace>/downloads/personal
// (main/workspace-downloads.ts) without a dialog – also those of pages an agent opened; the tab shows its last one
// and 'reveal' shows it in its folder.
// Owns: the session's permission and download handlers and the last download per tab. Never: imports electron's
// values (the browser hands in `reveal`), reads page content or opens a downloaded file.

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DownloadItem, Event, Session, WebContents } from 'electron';
import type { TabDownload } from '../shared/api/workspace-browser.ts';
import { uniqueDownload } from './workspace-downloads.ts';

/** What a page's own site may use. */
const ALLOWED: ReadonlySet<string> = new Set(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write']);

interface Download extends TabDownload { file: string }

/** The site (origin) of an http(s) address; undefined for anything else. */
export function siteOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch { return undefined; }
}

/** The fixed rule: an allowed permission, asked by the site of the page itself. */
export function siteMay(permission: string, requesting: string | undefined, page: string | undefined): boolean {
  const site = siteOf(requesting);
  return ALLOWED.has(permission) && site !== undefined && site === siteOf(page);
}

/** What the session rules need from the browser: which tab a page is, and that a tab changed. */
export interface SessionTabs {
  tabOf(contents: WebContents | null | undefined): string | undefined;
  changed(): void;
}

export class WorkspaceSession {
  private readonly downloads = new Map<string, Download>();
  /** Files being written now (two downloads of one name get two files). */
  private readonly saving = new Set<string>();
  private readonly tabs: SessionTabs;
  private readonly show: (file: string) => void;

  /** `reveal`: shows a file in its folder (electron's shell.showItemInFolder). */
  constructor(session: Session, tabs: SessionTabs, options: { downloadsDir?: string; reveal(file: string): void }) {
    this.tabs = tabs;
    this.show = options.reveal;
    session.setPermissionRequestHandler((contents, permission, callback, details) => callback(siteMay(permission, details.requestingUrl, contents.getURL())));
    session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => siteMay(permission, requestingOrigin, details.embeddingOrigin ?? contents?.getURL()));
    session.setDevicePermissionHandler(() => false);
    session.on('will-download', (event, item, contents) => this.download(event, item, contents, options.downloadsDir));
  }

  /** The tab's last download, for its page entry. */
  extras(id: string): { download?: TabDownload } {
    const download = this.downloads.get(id);
    return download ? { download: { name: download.name, state: download.state } } : {};
  }

  /** A download still being written keeps its tab loaded (workspace-discard.ts). */
  busy(id: string): boolean {
    return this.downloads.get(id)?.state === 'saving';
  }

  /** Shows the tab's last saved download in its folder. */
  reveal(id: string): void {
    const download = this.downloads.get(id);
    if (download?.state === 'saved' && existsSync(download.file)) this.show(download.file);
  }

  closed(id: string): void {
    this.downloads.delete(id);
  }

  private download(event: Event, item: DownloadItem, contents: WebContents, dir: string | undefined): void {
    const id = this.tabs.tabOf(contents);
    if (!id || !dir) { event.preventDefault(); return; }
    let file: string;
    try {
      mkdirSync(dir, { recursive: true });
      file = uniqueDownload(dir, item.getFilename(), (candidate) => this.saving.has(candidate) || existsSync(candidate));
    } catch { event.preventDefault(); return; }
    item.setSavePath(file);
    this.saving.add(file);
    const entry: Download = { name: path.basename(file), state: 'saving', file };
    this.downloads.set(id, entry);
    this.tabs.changed();
    item.once('done', (_event, state) => {
      this.saving.delete(file);
      entry.state = state === 'completed' ? 'saved' : 'failed';
      if (this.downloads.get(id) === entry) this.tabs.changed();
    });
  }
}
