// Page-level browser work for agents' own browsers: the structural Playwright surface we use (incl. the CDP session
// the live view screencasts through, view.ts), locating a target (ARIA ref from the last snapshot, role+name, label,
// placeholder, text or CSS), one action with Playwright's actionability checks (a pointer action first moves the
// page's mouse there, motion.ts), the AI-mode ARIA snapshot, reading one field for the vault and the page's password
// field values (masked in every snapshot).
// Owns: target → locator rules, action dispatch, error translation into short sentences, snapshot truncation, titles.
// Never: launches browsers or keeps state (service.ts does), or uses JS clicks instead of real pointer events.

import { WorkforceError } from '../../shared/errors.ts';
import type { MotionStyle } from '../../shared/model/pointer-motion.ts';
import { moveTo, POINTER_ACTIONS, type PointerMove } from './motion.ts';

export interface LocatorLike {
  click(options?: { timeout?: number; button?: 'left' | 'right' | 'middle'; delay?: number }): Promise<void>;
  dblclick(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  pressSequentially(text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  selectOption(values: string[], options?: { timeout?: number }): Promise<unknown>;
  check(options?: { timeout?: number }): Promise<void>;
  uncheck(options?: { timeout?: number }): Promise<void>;
  hover(options?: { timeout?: number }): Promise<void>;
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  setInputFiles(files: string[], options?: { timeout?: number }): Promise<void>;
  innerText(options?: { timeout?: number }): Promise<string>;
  first(): LocatorLike;
  nth(index: number): LocatorLike;
  boundingBox?(options?: { timeout?: number }): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export interface DownloadLike {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
}

export interface PageLike {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'commit'; timeout?: number }): Promise<unknown>;
  goBack(options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  goForward(options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  reload(options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  ariaSnapshot(options?: { mode?: 'ai' | 'default'; timeout?: number }): Promise<string>;
  locator(selector: string): LocatorLike;
  getByRole(role: string, options?: { name?: string; exact?: boolean }): LocatorLike;
  getByText(text: string, options?: { exact?: boolean }): LocatorLike;
  getByLabel(text: string, options?: { exact?: boolean }): LocatorLike;
  getByPlaceholder(text: string, options?: { exact?: boolean }): LocatorLike;
  screenshot(options?: { type?: 'jpeg' | 'png'; quality?: number; fullPage?: boolean; scale?: 'css' | 'device'; timeout?: number }): Promise<Uint8Array>;
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options?: { timeout?: number }): Promise<void>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void>; move?(x: number, y: number): Promise<void> };
  on(event: 'download', listener: (download: DownloadLike) => void): unknown;
  /** browser.eval, browser.wait, password fields: an expression evaluated in the page, awaited when it is a promise. */
  evaluate?(expression: string): Promise<unknown>;
  waitForURL?(url: (url: URL) => boolean, options?: { timeout?: number; waitUntil?: 'commit' }): Promise<void>;
  viewportSize?(): { width: number; height: number } | null;
}

/** A Chrome DevTools Protocol session on one page (Playwright's CDPSession). Events carry plain JSON. */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (payload: never) => void): unknown;
  off(event: string, listener: (payload: never) => void): unknown;
  detach(): Promise<void>;
}

export interface ContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'page', listener: (page: PageLike) => void): unknown;
  setDefaultTimeout(ms: number): void;
  /** Chromium only (every agent browser is Chrome or Edge); absent in fakes without a live view. */
  newCDPSession?(page: PageLike): Promise<CdpSessionLike>;
}

export interface BrowserTarget {
  ref?: string; // from browser.snapshot ("e12")
  role?: string; // ARIA role ("button", "link", "textbox" …) with optional name
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  css?: string;
  exact?: boolean;
  nth?: number; // pick one of several matches (0-based)
}

export type BrowserAction =
  | 'click' | 'double_click' | 'right_click' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'hover'
  | 'scroll_into_view' | 'upload' | 'scroll' | 'back' | 'forward' | 'reload';

/** Actions that need an element target (the rest work on the page). */
export const ELEMENT_ACTIONS: ReadonlySet<BrowserAction> = new Set<BrowserAction>([
  'click', 'double_click', 'right_click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover', 'scroll_into_view', 'upload',
]);

const ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code',
  'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document',
  'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup',
  'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
  'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer',
  'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

/** Locator for a target; exactly one way of addressing is used (ref wins). */
export function locate(page: PageLike, target: BrowserTarget): LocatorLike {
  let locator: LocatorLike;
  if (target.ref) {
    if (!/^[a-z0-9]{1,24}$/i.test(target.ref)) throw new WorkforceError('bad_request', `Invalid ref "${target.ref}". Use a ref like e12 from browser.snapshot.`);
    locator = page.locator(`aria-ref=${target.ref}`);
  } else if (target.role) {
    const role = target.role.toLowerCase();
    if (!ROLES.has(role)) throw new WorkforceError('bad_request', `Unknown ARIA role "${target.role}".`);
    locator = page.getByRole(role, target.name ? { name: target.name, exact: target.exact } : undefined);
  } else if (target.label) {
    locator = page.getByLabel(target.label, { exact: target.exact });
  } else if (target.placeholder) {
    locator = page.getByPlaceholder(target.placeholder, { exact: target.exact });
  } else if (target.text) {
    locator = page.getByText(target.text, { exact: target.exact });
  } else if (target.css) {
    locator = page.locator(target.css);
  } else {
    throw new WorkforceError('bad_request', 'Say which element: ref (from browser.snapshot), role+name, label, placeholder, text or css.');
  }
  return target.nth !== undefined ? locator.nth(target.nth) : locator;
}

/** Short description of a target for summaries and errors. */
export function describeTarget(target: BrowserTarget | undefined): string {
  if (!target) return 'the page';
  if (target.ref) return `element ${target.ref}`;
  if (target.role) return `${target.role}${target.name ? ` "${target.name}"` : ''}`;
  if (target.label) return `field "${target.label}"`;
  if (target.placeholder) return `field "${target.placeholder}"`;
  if (target.text) return `"${target.text}"`;
  return target.css ? `css ${target.css}` : 'element';
}

/** Translates Playwright errors (strict mode, timeouts with actionability logs) into short sentences. */
export function translateError(error: unknown, target: BrowserTarget | undefined): WorkforceError {
  if (error instanceof WorkforceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const what = describeTarget(target);
  const strict = /strict mode violation: .*? resolved to (\d+) elements/s.exec(message);
  if (strict) return new WorkforceError('conflict', `${strict[1]} elements match ${what}. Use a ref from browser.snapshot, add a name, or pick one with nth.`);
  if (/aria-ref=.*(not found|does not match|stale)/i.test(message) || /Unknown ref/i.test(message)) {
    return new WorkforceError('not_found', `${what} is not on the page any more. Take a new browser.snapshot.`);
  }
  if (/Timeout \d+ms exceeded|TimeoutError/i.test(message)) {
    const reasons = ['not visible', 'not enabled', 'not editable', 'not stable', 'intercepts pointer events', 'detached', 'waiting for locator', 'waiting for navigation']
      .filter((reason) => message.includes(reason));
    const why = reasons.includes('intercepts pointer events') ? 'something else covers it (a dialog or banner?)'
      : reasons.includes('not visible') ? 'it is not visible'
        : reasons.includes('not enabled') ? 'it is disabled'
          : reasons.includes('not editable') ? 'it is not editable'
            : reasons.includes('waiting for locator') ? 'it was not found'
              : 'it did not become ready';
    return new WorkforceError('timeout', `Could not act on ${what}: ${why}. Take a new browser.snapshot and try another target.`);
  }
  if (/Target page, context or browser has been closed|Target closed/i.test(message)) {
    return new WorkforceError('unavailable', 'The browser tab was closed. Open the page again.');
  }
  if (/net::ERR_[A-Z_]+/.test(message)) {
    return new WorkforceError('unavailable', `The page could not be loaded (${/net::ERR_[A-Z_]+/.exec(message)![0]}).`);
  }
  return new WorkforceError('internal', `The browser action failed: ${message.split('\n')[0].slice(0, 240)}`);
}

export interface PerformInput {
  action: BrowserAction;
  target?: BrowserTarget;
  value?: string; // fill / type
  values?: string[]; // select
  key?: string; // press
  files?: string[]; // upload (absolute paths, already checked to be inside the workspace)
  amount?: number; // scroll pixels (positive = down)
  timeoutMs: number;
  /** How the mouse travels to the element of a pointer action first (motion.ts); undefined: no move of ours. */
  motion?: MotionStyle;
}

/** Runs one action with Playwright's waiting and actionability checks; returns the pointer's move (pointer actions with a motion). */
export async function perform(page: PageLike, input: PerformInput): Promise<PointerMove | undefined> {
  const timeout = input.timeoutMs;
  const nav = { waitUntil: 'domcontentloaded' as const, timeout: Math.max(timeout, 15_000) };
  if (ELEMENT_ACTIONS.has(input.action) && !input.target) throw new WorkforceError('bad_request', `${input.action} needs a target element.`);
  const element = () => locate(page, input.target!);
  const moved = input.motion && input.target && POINTER_ACTIONS.has(input.action) ? await moveTo(page, element(), input.motion, Math.min(timeout, 3000)) : undefined;
  await act(page, input, element, timeout, nav, moved?.pressMs ?? 0);
  return moved;
}

async function act(page: PageLike, input: PerformInput, element: () => LocatorLike, timeout: number, nav: { waitUntil: 'domcontentloaded'; timeout: number }, hold: number): Promise<void> {
  const delay = hold > 0 ? { delay: hold } : {};
  switch (input.action) {
    case 'click': return element().click({ timeout, ...delay });
    case 'double_click': return element().dblclick({ timeout });
    case 'right_click': return element().click({ timeout, button: 'right', ...delay });
    case 'fill':
      if (input.value === undefined) throw new WorkforceError('bad_request', 'fill needs a value.');
      return element().fill(input.value, { timeout });
    case 'type':
      // Real key presses (autocomplete fields, editors that ignore programmatic values).
      if (input.value === undefined) throw new WorkforceError('bad_request', 'type needs a value.');
      if (input.value.length > 2000) throw new WorkforceError('bad_request', 'Type at most 2000 characters at once (use fill for long text).');
      return element().pressSequentially(input.value, { delay: 15, timeout: Math.max(timeout, input.value.length * 40) });
    case 'press': {
      const key = input.key?.trim();
      if (!key || !/^[A-Za-z0-9+]{1,40}$/.test(key.replace(/[-_ ]/g, ''))) throw new WorkforceError('bad_request', 'press needs a key like "Enter", "Tab", "Escape" or "Control+A".');
      if (input.target) return element().press(key, { timeout });
      return page.keyboard.press(key);
    }
    case 'select':
      if (!input.values?.length && input.value === undefined) throw new WorkforceError('bad_request', 'select needs values (option labels or values).');
      await element().selectOption(input.values?.length ? input.values : [input.value!], { timeout });
      return;
    case 'check': return element().check({ timeout });
    case 'uncheck': return element().uncheck({ timeout });
    case 'hover': return element().hover({ timeout });
    case 'scroll_into_view': return element().scrollIntoViewIfNeeded({ timeout });
    case 'upload':
      if (!input.files?.length) throw new WorkforceError('bad_request', 'upload needs files.');
      return element().setInputFiles(input.files, { timeout });
    case 'scroll': {
      const amount = input.amount ?? 600;
      if (!Number.isFinite(amount) || Math.abs(amount) > 20_000) throw new WorkforceError('bad_request', 'Scroll by at most 20000 pixels.');
      if (input.target) await element().scrollIntoViewIfNeeded({ timeout });
      return page.mouse.wheel(0, amount);
    }
    case 'back': await page.goBack(nav); return;
    case 'forward': await page.goForward(nav); return;
    case 'reload': await page.reload(nav); return;
    default:
      throw new WorkforceError('bad_request', `Unknown browser action "${String(input.action)}".`);
  }
}

/** AI-mode ARIA snapshot with element refs, truncated for the model. */
export async function snapshotText(page: PageLike, maxChars = 24_000): Promise<{ text: string; truncated: boolean }> {
  const raw = await page.ariaSnapshot({ mode: 'ai', timeout: 15_000 });
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  const cut = raw.lastIndexOf('\n', maxChars);
  return { text: `${raw.slice(0, cut > 0 ? cut : maxChars)}\n… (snapshot truncated: ${raw.length - maxChars} more characters – use browser.extract or act on what is visible, then snapshot again)`, truncated: true };
}

/** Normalises what an agent typed into a navigable http(s) URL. */
export function normaliseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new WorkforceError('bad_request', 'Give a URL.');
  if (raw === 'about:blank') return raw;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { throw new WorkforceError('bad_request', `"${raw}" is not a valid URL.`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new WorkforceError('bad_request', 'Only http and https pages can be opened.');
  return url.href;
}

/** The page title (at most 300 characters; '' when the page cannot answer). Untrusted page text. */
export async function safeTitle(page: PageLike): Promise<string> {
  try { return (await page.title()).slice(0, 300); } catch { return ''; }
}

/** safeTitle waited for at most `ms` ('' after that): a busy page must not hold a live view up. */
export async function titleWithin(page: PageLike, ms = 1500): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), ms); timer.unref?.(); });
  try { return await Promise.race([safeTitle(page), late]); } finally { clearTimeout(timer); }
}

/**
 * What an element holds – a field's value (input, textarea, select; `password` for a password field),
 * else its text – read inside the runtime only for browser.save_secret (BrowserService.fieldValue); never logged.
 */
export async function readField(target: LocatorLike, timeoutMs: number): Promise<{ value: string; password: boolean }> {
  const field = target as LocatorLike & { inputValue?(options?: { timeout?: number }): Promise<string>; getAttribute?(name: string, options?: { timeout?: number }): Promise<string | null> };
  if (typeof field.inputValue === 'function') {
    try {
      const value = await field.inputValue({ timeout: timeoutMs });
      const type = typeof field.getAttribute === 'function' ? await field.getAttribute('type', { timeout: timeoutMs }).catch(() => null) : null;
      return { value, password: type?.toLowerCase() === 'password' };
    } catch (error) {
      if (!/<input>|<textarea>|<select>/i.test(error instanceof Error ? error.message : String(error))) throw translateError(error, undefined);
    }
  }
  try { return { value: (await target.innerText({ timeout: timeoutMs })).trim(), password: false }; } catch (error) { throw translateError(error, undefined); }
}

/** Evaluated in the page (a string: the runtime has no DOM types): the values of its password fields. */
const PASSWORD_VALUES = "Array.from(document.querySelectorAll('input[type=password]'), (input) => input.value).filter(Boolean).slice(0, 20)";
export const PASSWORD_MASK = '•••• (password field)';

/** The page's password field values (main frame, at most 20, read within 1.5 s; [] when the page cannot say). Never logged. */
export async function passwordValues(page: PageLike): Promise<string[]> {
  if (!page.evaluate) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<unknown>((resolve) => { timer = setTimeout(() => resolve([]), 1500); timer.unref?.(); });
  try {
    const values = await Promise.race([page.evaluate(PASSWORD_VALUES), late]);
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** `text` with `values` masked on its field lines (a snapshot shows a text box's value). */
export function maskPasswords(text: string, values: readonly string[]): string {
  if (!values.length) return text;
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return text.split('\n').map((line) => (/^\s*-\s+textbox\b/.test(line) ? sorted.reduce((out, value) => out.split(value).join(PASSWORD_MASK), line) : line)).join('\n');
}

/** Host of a page URL ('' for about:blank or invalid). */
export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}
