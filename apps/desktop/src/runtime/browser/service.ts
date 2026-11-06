// Agents' own browsers: one persistent Chrome/Edge profile per agent (<data>/browser-profiles/<agentId>) driven by
// playwright-core, imported lazily on first use. Logins and cookies stay in the profile. The window is real but
// off-screen (launch.ts); the person watches it live (view.ts), can show the real window and take it over
// (takeover.ts: while that flag is on, every agent step answers that the person has it).
// Owns: through sessions.ts the browsers' lifetime; act-and-verify (steps answer with a change list against the
// agent's last snapshot of the tab, diff.ts), screenshots, page text, tabs, and the runtime-only reads for the vault
// (one field's value, the 2FA setup keys a page shows). Password field values never show in a snapshot.
// Never: touches the person's own browser profile or opens non-http(s) pages.

import type { Logger, Paths } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { MotionStyle } from '../../shared/model/pointer-motion.ts';
import { findSetupKeys, type TotpParams } from '../secrets/totp.ts';
import type { BrowserChannel } from './channel.ts';
import type { Launcher } from './launch.ts';
import { hostOf, locate, maskPasswords, normaliseUrl, passwordValues, readField, safeTitle, snapshotText, translateError, type PageLike } from './page.ts';
import { workspaceFile } from './downloads.ts';
import { activePage, BrowserSessions, openPages, type BrowserChange, type Session, type ViewSession } from './sessions.ts';
import { PERSON_USING, Takeovers, type UseContext } from './takeover.ts';
import { snapshotChanges } from './diff.ts';
import { isHumanCheck } from './human-check.ts';
import { runSteps, type BatchStep } from './batch.ts';
import type { BatchOutcome, Mark, PageState, Reviewed, TabInfo } from './states.ts';

export type { BatchStep } from './batch.ts';
export type { BatchOutcome, Mark, PageState, Reviewed, TabInfo } from './states.ts';
export type { LaunchOptions, Launcher } from './launch.ts';
export type { BrowserChange, ViewSession } from './sessions.ts';

/** The most steps one browser.act / browser.batch call runs. */
export const BATCH_MAX = 20;

export interface BrowserDeps {
  paths: Pick<Paths, 'data' | 'workspace'>;
  log: Logger;
  launcher?: Launcher; // tests inject a fake Playwright
  channel?: () => BrowserChannel;
  idleMs?: number; // default 10 min
  actionTimeoutMs?: number; // default 10 s
  settleMs?: number; // pause after an action before the verifying snapshot (default 400 ms)
}

export class BrowserService {
  private readonly deps: BrowserDeps;
  private readonly pool: BrowserSessions;
  /** The person's takeover flags; every agent step checks them first. */
  readonly takeovers = new Takeovers();

  constructor(deps: BrowserDeps) {
    this.deps = deps;
    this.pool = new BrowserSessions({ ...deps, closed: (agentId, reason) => this.takeovers.forget(agentId, reason) });
  }

  // ------------------------------------------------------------------ the agent's steps

  async open(agentId: string, input: { url: string; newTab?: boolean; tab?: string; use?: UseContext }): Promise<PageState> {
    this.takeovers.guard(agentId, input.use);
    return this.navigate(agentId, input);
  }

  /** The person opens the agent's closed browser at `url` (Take over). */
  async openForPerson(agentId: string, url: string): Promise<void> {
    await this.navigate(agentId, { url });
  }

  private async navigate(agentId: string, input: { url: string; newTab?: boolean; tab?: string }): Promise<PageState> {
    const url = normaliseUrl(input.url);
    const session = await this.pool.session(agentId);
    const page = input.newTab ? await session.context.newPage()
      : input.tab ? this.pool.page(session, input.tab) : activePage(session) ?? await session.context.newPage();
    this.pool.track(session, page);
    session.active = page;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (error) {
      throw translateError(error, undefined);
    } finally {
      this.pool.changed(agentId);
    }
    await this.settle(page);
    return this.state(session, page);
  }

  async snapshot(agentId: string, input: { tab?: string; use?: UseContext } = {}): Promise<PageState> {
    const { session, page } = await this.tabOf(agentId, input.tab, input.use);
    return this.state(session, page);
  }

  /**
   * Up to BATCH_MAX steps on one tab (browser.act is one step), stopping at the first failing one or when the person
   * takes the browser over; answers with one change list (the whole snapshot for a new tab or `full`).
   */
  async batch(agentId: string, input: {
    tab?: string; steps: BatchStep[]; motion?: MotionStyle; full?: boolean; use?: UseContext;
    /** A stored secret's value for the page's host (steps with `secretId`). */
    secret?: (id: string, host: string) => Promise<string>;
  }): Promise<BatchOutcome> {
    if (!input.steps.length || input.steps.length > BATCH_MAX) throw new WorkforceError('bad_request', `A batch has 1 to ${BATCH_MAX} steps.`);
    const { session, page, tab } = await this.tabOf(agentId, input.tab, input.use);
    const before = this.mark(session, page);
    const run = await runSteps(page, input.steps, {
      tab, motion: input.motion ?? 'instant', timeoutMs: this.timeout(), file: (file) => workspaceFile(this.deps.paths.workspace, file), secret: input.secret,
      stop: () => (this.takeovers.active(agentId) ? PERSON_USING : undefined),
    });
    return { ...await this.review(session, page, before, input.full), ...run, total: input.steps.length };
  }

  /** What the agent last saw of `page` – before steps; review() compares against it. */
  mark(session: Session, page: PageLike): Mark {
    return { url: page.url(), text: session.texts.get(page), look: session.looks.get(page), pages: new Set(session.context.pages()) };
  }

  /** After steps: settles, follows a tab the steps opened (or the one left when it closed), snapshots and lists the changes. */
  async review(session: Session, page: PageLike, before: Mark, full?: boolean): Promise<Reviewed> {
    await this.settle(page);
    const open = openPages(session);
    const opened = open.filter((candidate) => !before.pages.has(candidate));
    const next = opened[opened.length - 1] ?? (page.isClosed() ? open[open.length - 1] : page);
    if (!next || next.isClosed()) { this.pool.changed(session.agentId); throw new WorkforceError('not_found', 'The tab closed after the action. Open a page again with browser.open.'); }
    this.pool.track(session, next);
    session.active = next;
    this.pool.changed(session.agentId);
    if (next !== page) await this.settle(next);
    const state = await this.state(session, next);
    const same = next === page;
    const changes = snapshotChanges({
      before: same ? before.text : undefined, after: state.snapshot, urlBefore: before.look?.url ?? before.url, url: state.url, titleBefore: before.look?.title, title: state.title, full,
    });
    return { ...state, changed: !same || state.url !== before.url || state.snapshot !== before.text, urlChanged: state.url !== before.url, changes, ...(same ? {} : { newTab: true as const }) };
  }

  /** The session and tab of an agent's call (refused while the person has the browser; counts as use). */
  async tabOf(agentId: string, tab?: string, use?: UseContext): Promise<{ session: Session; page: PageLike; tab: string }> {
    this.takeovers.guard(agentId, use);
    const session = await this.pool.session(agentId);
    const page = this.pool.current(session, tab);
    return { session, page, tab: this.pool.idOf(session, page) };
  }

  async screenshot(agentId: string, input: { tab?: string; fullPage?: boolean; use?: UseContext } = {}): Promise<{ data: Uint8Array; mime: string; tab: string; url: string; title: string }> {
    const { page, tab } = await this.tabOf(agentId, input.tab, input.use);
    try {
      const data = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: input.fullPage ?? false, scale: 'css', timeout: 20_000 });
      if (data.byteLength > 8 * 1024 * 1024) throw new WorkforceError('conflict', 'The page screenshot is too large; take a viewport screenshot instead of fullPage.');
      return { data: new Uint8Array(data), mime: 'image/jpeg', tab, url: page.url(), title: await safeTitle(page) };
    } catch (error) {
      throw translateError(error, undefined);
    }
  }

  async extract(agentId: string, input: { tab?: string; css?: string; maxChars?: number; use?: UseContext } = {}): Promise<{ text: string; truncated: boolean; tab: string; url: string; title: string }> {
    const { page, tab } = await this.tabOf(agentId, input.tab, input.use);
    const max = Math.max(500, Math.min(input.maxChars ?? 30_000, 100_000));
    let raw: string;
    try {
      raw = await page.locator(input.css ?? 'body').first().innerText({ timeout: this.timeout() });
    } catch (error) {
      throw translateError(error, input.css ? { css: input.css } : undefined);
    }
    const text = raw.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text.slice(0, max), truncated: text.length > max, tab, url: page.url(), title: await safeTitle(page) };
  }

  async tabs(agentId: string, input: { close?: string; activate?: string; use?: UseContext } = {}): Promise<{ tabs: TabInfo[]; downloads: string[] }> {
    this.takeovers.guard(agentId, input.use);
    const session = await this.pool.session(agentId);
    if (input.close) {
      const page = this.pool.page(session, input.close);
      await page.close().catch(() => undefined);
      if (session.active === page) session.active = undefined;
    }
    if (input.activate) {
      const page = this.pool.page(session, input.activate);
      session.active = page;
      await page.bringToFront().catch(() => undefined);
    }
    if (input.close || input.activate) this.pool.changed(agentId);
    const pages = openPages(session);
    const active = activePage(session, pages);
    const tabs = await Promise.all(pages.map(async (page) => ({ tab: this.pool.idOf(session, page), url: page.url(), title: await safeTitle(page), active: page === active })));
    return { tabs, downloads: [...session.downloads] };
  }

  // ------------------------------------------------------------------ runtime-only reads for the vault (never logged)

  /** The value of the element `ref` (a field's value, else its text) and the page's host – for browser.save_secret. */
  async fieldValue(agentId: string, input: { tab?: string; ref: string; use?: UseContext }): Promise<{ host: string; value: string; password: boolean }> {
    const { page } = await this.tabOf(agentId, input.tab, input.use);
    const read = await readField(locate(page, { ref: input.ref }), this.timeout());
    return { host: hostOf(page.url()), ...read };
  }

  /** The 2FA setup keys the page shows (otpauth links first) – for browser.save_totp. */
  async setupKeys(agentId: string, input: { tab?: string; use?: UseContext } = {}): Promise<{ host: string; keys: TotpParams[] }> {
    const { page } = await this.tabOf(agentId, input.tab, input.use);
    const links = page.evaluate ? await page.evaluate(OTPAUTH).catch(() => []) : [];
    const [snapshot, body] = await Promise.all([
      page.ariaSnapshot({ mode: 'ai', timeout: 5000 }).catch(() => ''),
      page.locator('body').first().innerText({ timeout: 5000 }).catch(() => ''),
    ]);
    const found = Array.isArray(links) ? links.filter((value): value is string => typeof value === 'string' && value.length <= 4096) : [];
    return { host: hostOf(page.url()), keys: findSetupKeys([snapshot, body, ...found].join('\n')) };
  }

  // ------------------------------------------------------------------ the live view's port (view.ts)

  isOpen(agentId?: string): boolean { return this.pool.isOpen(agentId); }
  agents(): string[] { return this.pool.agents(); }
  onChange(listener: (agentId: string, why: BrowserChange) => void): () => void { return this.pool.onChange(listener); }
  viewOf(agentId: string): ViewSession | undefined { return this.pool.viewOf(agentId); }
  close(agentId?: string): Promise<void> { return this.pool.close(agentId); }

  // ------------------------------------------------------------------ page state

  private async state(session: Session, page: PageLike): Promise<PageState> {
    let snapshot: { text: string; truncated: boolean };
    try { snapshot = await snapshotText(page); } catch (error) { throw translateError(error, undefined); }
    const text = maskPasswords(snapshot.text, await passwordValues(page));
    const url = page.url();
    const title = await safeTitle(page);
    session.texts.set(page, text);
    session.looks.set(page, { url, title });
    const state: PageState = { tab: this.pool.idOf(session, page), url, title, snapshot: text, truncated: snapshot.truncated };
    if (isHumanCheck(state)) state.humanCheck = true;
    return state;
  }

  private timeout(): number { return this.deps.actionTimeoutMs ?? 10_000; }

  /** Waits for the page to settle after an action (navigation or DOM update), bounded. */
  private async settle(page: PageLike): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    const ms = this.deps.settleMs ?? 400;
    if (ms > 0) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.(); });
  }
}

/** Evaluated in the page (a string: the runtime has no DOM types): otpauth: links and values. */
const OTPAUTH = "Array.from(document.querySelectorAll('a[href],input,textarea,[data-otpauth],img[alt]'), (el) => [el.getAttribute('href'), el.value, el.getAttribute('data-otpauth'), el.getAttribute('alt')]).flat().filter((value) => typeof value === 'string' && /^otpauth:/i.test(value.trim())).slice(0, 20)";
