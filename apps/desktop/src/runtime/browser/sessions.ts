// The agents' own open browsers: one persistent Chrome/Edge context per agent, launched once on first use (a launch in
// progress is shared) from <data>/browser-profiles/<agentId> with the off-screen window of launch.ts, closed after
// 10 min without use (not while the person has the real window on the screen), on request or at shutdown. Tab ids
// (t1, t2 …), the active tab, downloads into <workspace>/downloads/<agentId>, each tab's console and network log
// (devtools.ts), and the agent's last look per tab (the change lists of diff.ts).
// Owns: the sessions map, launching, the idle timer, tab ids and the change listeners of the live view (view.ts).
// Never: acts on a page (service.ts does) or touches the person's own browser profile.

import { mkdirSync } from 'node:fs';
import type { Logger, Paths } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { detectChannel, profileDir, type BrowserChannel } from './channel.ts';
import type { ContextLike, PageLike } from './page.ts';
import { defaultLauncher, launchError, launchOptions, type Launcher } from './launch.ts';
import { saveDownload } from './downloads.ts';
import { PageLog } from './devtools.ts';

export interface Session {
  agentId: string;
  context: ContextLike;
  ids: WeakMap<PageLike, string>;
  nextTab: number;
  active?: PageLike;
  timer?: ReturnType<typeof setTimeout>;
  downloads: string[];
  /** The last snapshot the agent saw of a tab, with its address and title (refs are per page). */
  texts: WeakMap<PageLike, string>;
  looks: WeakMap<PageLike, { url: string; title: string }>;
  logs: WeakMap<PageLike, PageLog>;
  /** The person brought the window onto the screen (Show window): no idle close then. */
  shown?: boolean;
}

/** Why the live view is told (view.ts). */
export type BrowserChange = 'open' | 'close' | 'page';

/** An agent's open browser as the live view sees it (view.ts). */
export interface ViewSession {
  context: ContextLike;
  active: PageLike | undefined;
  tabs: Array<{ page: PageLike; tab: string }>;
  shown: boolean;
  /** The person used `page`: it becomes active, counts as use, and the agent's last look of it is forgotten. */
  steer(page: PageLike): void;
  /** Show window (true) or Hide (false): counts as use; no idle close while shown. */
  onScreen(shown: boolean): void;
}

export function openPages(session: Session): PageLike[] {
  return session.context.pages().filter((page) => !page.isClosed());
}

/** The active tab, else the newest open one. */
export function activePage(session: Session, open = openPages(session)): PageLike | undefined {
  return session.active && !session.active.isClosed() ? session.active : open[open.length - 1];
}

export interface BrowserSessionsDeps {
  paths: Pick<Paths, 'data' | 'workspace'>;
  log: Logger;
  launcher?: Launcher;
  channel?: () => BrowserChannel;
  idleMs?: number; // default 10 min
  actionTimeoutMs?: number; // default 10 s
  /** An agent's browser closed ('closed': idle, on request or by itself; 'shutdown'). */
  closed(agentId: string, reason: 'closed' | 'shutdown'): void;
}

export class BrowserSessions {
  private readonly deps: BrowserSessionsDeps;
  private readonly sessions = new Map<string, Session>();
  private readonly launching = new Map<string, Promise<Session>>();
  private readonly watchers = new Set<(agentId: string, why: BrowserChange) => void>();

  constructor(deps: BrowserSessionsDeps) {
    this.deps = deps;
  }

  /** The agent's open browser, without counting as use. */
  get(agentId: string): Session | undefined {
    return this.sessions.get(agentId);
  }

  /** The agent's browser, launched when none is open; counts as use. */
  async session(agentId: string): Promise<Session> {
    const existing = this.sessions.get(agentId);
    if (existing) { this.touch(existing); return existing; }
    let launching = this.launching.get(agentId);
    if (!launching) {
      launching = this.launch(agentId).finally(() => this.launching.delete(agentId));
      this.launching.set(agentId, launching);
    }
    const session = await launching;
    this.touch(session);
    return session;
  }

  isOpen(agentId?: string): boolean {
    return agentId ? this.sessions.has(agentId) : this.sessions.size > 0;
  }

  agents(): string[] {
    return [...this.sessions.keys()];
  }

  onChange(listener: (agentId: string, why: BrowserChange) => void): () => void {
    this.watchers.add(listener);
    return () => { this.watchers.delete(listener); };
  }

  /** The agent's open browser for the live view, without counting as use. */
  viewOf(agentId: string): ViewSession | undefined {
    const session = this.sessions.get(agentId);
    if (!session) return undefined;
    const pages = openPages(session);
    return {
      context: session.context, active: activePage(session, pages), tabs: pages.map((page) => ({ page, tab: this.idOf(session, page) })), shown: session.shown === true,
      steer: (page) => {
        session.texts.delete(page);
        session.looks.delete(page);
        session.active = page;
        this.touch(session);
      },
      onScreen: (shown) => { session.shown = shown; this.touch(session); },
    };
  }

  /** Closes one agent's browser, or all (shutdown). */
  async close(agentId?: string): Promise<void> {
    const starting = agentId ? [this.launching.get(agentId)] : [...this.launching.values()];
    await Promise.allSettled(starting.filter((launch): launch is Promise<Session> => launch !== undefined));
    const ids = agentId ? [agentId] : [...this.sessions.keys()];
    await Promise.all(ids.map(async (id) => {
      const session = this.sessions.get(id);
      if (!session) return;
      this.drop(session, agentId ? 'closed' : 'shutdown');
      await session.context.close().catch((error: unknown) => this.deps.log.debug('browser close failed', { agentId: id, error: String(error) }));
    }));
  }

  changed(agentId: string, why: BrowserChange = 'page'): void {
    for (const listener of [...this.watchers]) {
      try { listener(agentId, why); } catch (error) { this.deps.log.debug('browser view listener failed', { error: String(error) }); }
    }
  }

  /** Use: the idle time starts again. */
  touch(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (session.shown) return; // the person uses the real window; Hide starts the idle time again
      this.deps.log.debug('browser idle, closing', { agentId: session.agentId });
      void this.close(session.agentId);
    }, this.deps.idleMs ?? 10 * 60_000);
    (session.timer as { unref?: () => void }).unref?.();
  }

  /** Gives a tab its id, its console/network log and saves its downloads into the workspace (once per tab). */
  track(session: Session, page: PageLike): void {
    if (session.ids.has(page)) return;
    session.ids.set(page, `t${session.nextTab++}`);
    const log = new PageLog();
    log.attach(page);
    session.logs.set(page, log);
    page.on('download', (download) => {
      void saveDownload(this.deps.paths.workspace, session.agentId, download, this.deps.log).then((file) => {
        if (file) session.downloads = [...session.downloads, file].slice(-20);
      });
    });
  }

  idOf(session: Session, page: PageLike): string {
    this.track(session, page);
    return session.ids.get(page)!;
  }

  page(session: Session, tab: string): PageLike {
    const page = session.context.pages().find((candidate) => !candidate.isClosed() && session.ids.get(candidate) === tab);
    if (!page) throw new WorkforceError('not_found', `No open tab ${tab}. List tabs with browser.tabs.`);
    return page;
  }

  /** The given tab, else the active one (which becomes the active tab). */
  current(session: Session, tab: string | undefined): PageLike {
    if (tab) return this.page(session, tab);
    const page = activePage(session);
    if (!page) throw new WorkforceError('not_found', 'No page is open. Open one with browser.open.');
    session.active = page;
    return page;
  }

  private drop(session: Session, reason: 'closed' | 'shutdown'): void {
    if (this.sessions.get(session.agentId) !== session) return;
    this.sessions.delete(session.agentId);
    if (session.timer) clearTimeout(session.timer);
    this.deps.closed(session.agentId, reason);
    this.changed(session.agentId, 'close');
  }

  private async launch(agentId: string): Promise<Session> {
    const dir = profileDir(this.deps.paths.data, agentId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const channel = (this.deps.channel ?? (() => detectChannel()))();
    let context: ContextLike;
    try {
      context = await (this.deps.launcher ?? defaultLauncher)(dir, launchOptions(channel));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.warn('browser launch failed', { agentId, channel, error: message.split('\n')[0] });
      throw launchError(message, channel);
    }
    context.setDefaultTimeout(this.deps.actionTimeoutMs ?? 10_000);
    const session: Session = { agentId, context, ids: new WeakMap(), nextTab: 1, downloads: [], texts: new WeakMap(), looks: new WeakMap(), logs: new WeakMap() };
    context.on('close', () => this.drop(session, 'closed'));
    context.on('page', (page) => { this.track(session, page); this.changed(agentId); });
    for (const page of context.pages()) this.track(session, page);
    this.sessions.set(agentId, session);
    this.deps.log.info('browser started', { agentId, channel });
    this.changed(agentId, 'open');
    return session;
  }
}
