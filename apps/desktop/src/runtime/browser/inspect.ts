// browser.find, browser.console, browser.network, browser.eval and browser.wait in an agent's own browser:
// find returns the snapshot lines that match (with their refs) instead of the whole page; console and network read
// devtools.ts buffers; eval runs an expression in the page (result capped at EVAL_MAX); wait is event-driven (a
// MutationObserver in the page, navigation events or Playwright's network-idle signal – never a polling loop of ours)
// and answers with the change list against the agent's last snapshot (service.ts review).
// Owns: these reads and waits. Never: returns header values outside devtools.ts SAFE_HEADERS.

import { WorkforceError } from '../../shared/errors.ts';
import type { BrowserService, Reviewed } from './service.ts';
import type { UseContext } from './takeover.ts';
import { consoleLines, networkLines } from './devtools.ts';
import type { PageLike } from './page.ts';

export const WAIT_MAX_MS = 30_000;
export const EVAL_MAX = 4000;
const FIND_MAX = 40;
const LINE_MAX = 240;

/** Snapshot lines matching every word of `query` (role, name, text or ref), at most FIND_MAX. */
export function findLines(snapshot: string, query: string): { lines: string[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = snapshot.split('\n').map((line) => line.trim().replace(/^- /, '')).filter((line) => line && words.every((word) => line.toLowerCase().includes(word)));
  return { lines: hits.slice(0, FIND_MAX).map((line) => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line)), total: hits.length };
}

export async function find(browser: BrowserService, key: string, input: { tab?: string; query: string; use?: UseContext }) {
  const state = await browser.snapshot(key, { tab: input.tab, use: input.use }); // refs of this look count for the next act
  return { state, ...findLines(state.snapshot, input.query) };
}

export async function consoleOf(browser: BrowserService, key: string, input: { tab?: string; pattern?: string; errorsOnly?: boolean; limit?: number; use?: UseContext }) {
  const { session, page, tab } = await browser.tabOf(key, input.tab, input.use);
  const lines = consoleLines(session.logs.get(page)?.console ?? [], input);
  return { tab, url: page.url(), lines };
}

export async function networkOf(browser: BrowserService, key: string, input: { tab?: string; urlPattern?: string; failedOnly?: boolean; limit?: number; requestId?: string; use?: UseContext }) {
  const { session, page, tab } = await browser.tabOf(key, input.tab, input.use);
  const log = session.logs.get(page);
  if (!input.requestId) return { tab, url: page.url(), lines: networkLines(log?.network ?? [], input) };
  const details = await log?.details(input.requestId);
  if (!details) throw new WorkforceError('not_found', `No request ${input.requestId} in this tab's log. List requests with browser.network.`);
  const { entry, headers, body, bodyCut } = details;
  const lines = [
    `${entry.id} ${entry.method} ${entry.failure ? `failed: ${entry.failure}` : entry.status ?? 'pending'} ${entry.url} (${entry.type})`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '(other headers are not shown)',
    ...(body !== undefined ? ['---', body, ...(bodyCut ? ['… (body cut)'] : [])] : []),
  ];
  return { tab, url: page.url(), lines };
}

export async function evaluate(browser: BrowserService, key: string, input: { tab?: string; expression: string; use?: UseContext }) {
  const { page, tab } = await browser.tabOf(key, input.tab, input.use);
  if (!page.evaluate) throw new WorkforceError('unavailable', 'This browser cannot evaluate scripts.');
  let text: string;
  try {
    const value = await page.evaluate(input.expression);
    text = value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch (error) {
    text = `Error: ${(error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300)}`;
  }
  return { tab, url: page.url(), text: text.slice(0, EVAL_MAX), truncated: text.length > EVAL_MAX };
}

export interface WaitFor { text?: string; url?: string; change?: boolean; idle?: boolean; timeoutMs?: number }

/** In the page: resolves true when `text` shows (or, without text, at the first DOM change), false after `ms`. A MutationObserver, no polling. */
const OBSERVE = `(function (arg) {
  return new Promise(function (resolve) {
    var want = arg.text ? arg.text.toLowerCase() : '';
    var shows = function () { return want && document.body && (document.body.innerText || '').toLowerCase().indexOf(want) >= 0; };
    if (shows()) { resolve(true); return; }
    var done = false;
    var finish = function (value) { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
    var observer = new MutationObserver(function () { if (!want || shows()) finish(true); });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    var timer = setTimeout(function () { finish(false); }, arg.ms);
  });
})`;

const destroyed = (error: unknown) => /Execution context was destroyed|navigat|Target closed|frame was detached/i.test(String(error));

/** Waits for text in the page or its first change; a navigation counts as a change and re-arms a text wait on the new page. */
async function observe(page: PageLike, text: string | undefined, deadline: number): Promise<boolean> {
  if (!page.evaluate) throw new WorkforceError('unavailable', 'This browser cannot wait for page changes.');
  for (;;) {
    const ms = deadline - Date.now();
    if (ms <= 0) return false;
    try {
      return (await page.evaluate(`${OBSERVE}(${JSON.stringify({ text: text ?? '', ms })})`)) === true;
    } catch (error) {
      if (!destroyed(error)) throw error;
      if (!text) return true; // the page navigated: that is a change
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => undefined);
    }
  }
}

/** browser.wait: one condition, event-driven, at most WAIT_MAX_MS; answers whether it came and the change list. */
export async function wait(browser: BrowserService, key: string, input: { tab?: string; for: WaitFor; full?: boolean; use?: UseContext }): Promise<Reviewed & { met: boolean; waitedMs: number }> {
  const conditions = [input.for.text, input.for.url, input.for.change, input.for.idle].filter((value) => value !== undefined && value !== false && value !== '');
  if (conditions.length !== 1) throw new WorkforceError('bad_request', 'Wait for exactly one of text, url, change or idle.');
  const ms = Math.min(Math.max(input.for.timeoutMs ?? 10_000, 100), WAIT_MAX_MS);
  const { session, page } = await browser.tabOf(key, input.tab, input.use);
  const before = browser.mark(session, page);
  const started = Date.now();
  const deadline = started + ms;
  let met: boolean;
  if (input.for.url) {
    const part = input.for.url;
    if (page.url().includes(part)) met = true;
    else if (!page.waitForURL) throw new WorkforceError('unavailable', 'This browser cannot wait for an address.');
    else met = await page.waitForURL((url) => url.href.includes(part), { timeout: ms, waitUntil: 'commit' }).then(() => true, () => false);
  } else if (input.for.idle) {
    met = await page.waitForLoadState('networkidle', { timeout: ms }).then(() => true, () => false);
  } else {
    met = await observe(page, input.for.text, deadline);
  }
  const waitedMs = Date.now() - started;
  return { ...await browser.review(session, page, before, input.full), met, waitedMs };
}
