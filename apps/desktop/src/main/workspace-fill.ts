// "Fill login" for the person in the integrated browser (B-078 D20; Electron has no password manager): the page menu
// (workspace-page-menu.ts) and Ctrl/Cmd+Shift+L list the catalog's logins – those saved from the page's registrable
// domain first, as a suggestion; every login stays reachable below them (grouped by first letter when there are
// many) – and the chosen one is typed into the page: a small script in an isolated world finds and focuses the
// username field (the focused one, else the last text/email field before the password field) and then the password
// field, and the values arrive through Electron's insertText, so they never sit in a script's source. The values come
// from the runtime's secrets.fillLogin over main's own RPC link (set once by desktop.ts: setFillRpc) – the runtime gives
// them to that link alone (its owner scope marked main, rpc/handlers/security.ts fromMain), not to the window or the CLI.
// Owns: the menu items, the field script and the typing. Never: logs, stores or sends a value anywhere but the page's
// focused field, reads the page beyond its inputs, fills a page that is not http(s), or types into a page whose origin
// changed since the pick (checked before each script and each insertText).

import type { MenuItemConstructorOptions } from 'electron';
import type { LoginChoice, LoginFill } from '../shared/model/login-fill.ts';

/** Main's RPC to the runtime as far as the fill needs it. */
export interface FillRpc {
  call(method: 'secrets.fillChoices', params: { url: string }, timeoutMs?: number): Promise<LoginChoice[]>;
  call(method: 'secrets.fillLogin', params: { id: string; url: string }, timeoutMs?: number): Promise<LoginFill>;
}

/** What the fill needs from a tab's page (Electron's WebContents has it). */
export interface FillContents {
  getURL(): string;
  isDestroyed(): boolean;
  focus(): void;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown>;
  insertText(text: string): Promise<void>;
}

/** The isolated world the field script runs in (its own globals; the page's scripts never see it). */
const FILL_WORLD = 1078;
const CHOICES_MS = 1500;
const FILL_MS = 10_000;
/** More logins than this: the rest is grouped by first letter. */
const FLAT_MAX = 20;

let rpc: FillRpc | undefined;

/** Main's RPC link (desktop.ts, once after the link exists). */
export function setFillRpc(value: FillRpc | undefined): void { rpc = value; }
export function fillRpc(): FillRpc | undefined { return rpc; }

/** The page's address when it can be filled (http/https), else ''. */
export function fillableUrl(url: string | undefined): string {
  return /^https?:\/\//i.test(url ?? '') ? url! : '';
}

/** The origin of `url` ('' when it does not parse). */
function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

/** The catalog's logins for `url` (none when the runtime does not answer soon). */
export async function loginChoices(link: FillRpc | undefined, url: string): Promise<LoginChoice[]> {
  if (!link || !fillableUrl(url)) return [];
  try { return await link.call('secrets.fillChoices', { url }, CHOICES_MS); } catch { return []; }
}

const itemOf = (choice: LoginChoice, pick: (id: string) => void): MenuItemConstructorOptions =>
  ({ label: choice.site && choice.site !== choice.label ? `${choice.label} – ${choice.site}` : choice.label, click: () => pick(choice.id) });

/** The "Fill login" submenu: suggestions first, then every login (by first letter when there are many). */
export function fillItems(choices: readonly LoginChoice[], pick: (id: string) => void): MenuItemConstructorOptions {
  if (!choices.length) return { label: 'Fill login', enabled: false, sublabel: 'No logins in the catalog yet' };
  const suggested = choices.filter((choice) => choice.suggested);
  const rest = choices.filter((choice) => !choice.suggested);
  const all: MenuItemConstructorOptions[] = rest.length <= FLAT_MAX ? rest.map((choice) => itemOf(choice, pick)) : byLetter(rest, pick);
  const submenu: MenuItemConstructorOptions[] = suggested.length
    ? [...suggested.map((choice) => itemOf(choice, pick)), ...(all.length ? [{ type: 'separator' as const }, { label: 'All logins', submenu: all }] : [])]
    : all;
  return { label: 'Fill login', accelerator: 'CmdOrCtrl+Shift+L', submenu };
}

function byLetter(choices: readonly LoginChoice[], pick: (id: string) => void): MenuItemConstructorOptions[] {
  const groups = new Map<string, LoginChoice[]>();
  for (const choice of choices) {
    const first = choice.label.trim().charAt(0).toUpperCase();
    const key = /[A-Z]/.test(first) ? first : '#';
    groups.set(key, [...(groups.get(key) ?? []), choice]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => ({ label: key, submenu: list.map((choice) => itemOf(choice, pick)) }));
}

/** Finds and focuses (and selects) the page's username ('user') or password ('pass') field; true when there is one. */
export const FIELD_SCRIPT = `(function (want) {
  var shown = function (el) { var r = el.getBoundingClientRect(); var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly; };
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input')).filter(shown);
  var isPass = function (el) { return el.type === 'password'; };
  var named = function (el) { return /user|mail|login|account|e-?mail|benutzer/i.test([el.name, el.id, el.autocomplete, el.placeholder].join(' ')); };
  var isUser = function (el) { return ['text', 'email', 'tel', ''].indexOf(el.type) >= 0 || named(el); };
  var active = document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null;
  var pass = active && isPass(active) ? active : inputs.filter(isPass)[0] || null;
  var user = active && !isPass(active) && isUser(active) ? active : null;
  if (!user) {
    var scope = pass && pass.form ? pass.form : null;
    var list = inputs.filter(function (el) { return !isPass(el) && isUser(el) && (!scope || el.form === scope); });
    if (pass) list = list.filter(function (el) { return el.compareDocumentPosition(pass) & 4; });
    user = list.filter(named).pop() || list.pop() || null;
  }
  var el = want === 'user' ? user : pass;
  if (!el) return false;
  el.focus();
  if (typeof el.select === 'function') el.select();
  return true;
})`;

/** Types login `id` into the page (username, then password); the fields it found, or why not. */
export async function fillLogin(link: FillRpc | undefined, contents: FillContents, id: string): Promise<{ filled: Array<'username' | 'password'> } | { error: string }> {
  const url = fillableUrl(contents.getURL());
  if (!link || !url) return { error: 'This page cannot be filled.' };
  let values: LoginFill;
  try { values = await link.call('secrets.fillLogin', { id, url }, FILL_MS); } catch { return { error: 'The login could not be read.' }; }
  const origin = originOf(url);
  /** The tab still shows the site the login was read for (a redirect or a click while we waited ends the fill). */
  const samePage = () => !contents.isDestroyed() && originOf(contents.getURL()) === origin;
  const moved = { error: 'The page changed before the login was filled.' };
  const filled: Array<'username' | 'password'> = [];
  for (const [field, want] of [['username', 'user'], ['password', 'pass']] as const) {
    const value = values[field];
    if (!value || contents.isDestroyed()) continue;
    if (!samePage()) return moved;
    contents.focus();
    let found = false;
    try { found = (await contents.executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code: `${FIELD_SCRIPT}(${JSON.stringify(want)})` }])) === true; } catch { found = false; }
    if (!found) continue;
    if (!samePage()) return moved;
    await contents.insertText(value);
    filled.push(field);
  }
  return filled.length ? { filled } : { error: 'No login field on this page.' };
}
