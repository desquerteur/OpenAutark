// The page as an agent reads it – the side tab's accessibility tree (DevTools protocol
// Accessibility.getFullAXTree) as indented text lines in the style agents know from Playwright
// ("- button "Sign in" [ref=s123]"), refs = "s" + the node's backendDOMNodeId. Generic wrappers and
// text-box noise are left out, states follow the role, links carry their address (secret query values
// hidden), password and other secret field values never appear. Also: find (matching lines) and the
// change list between two looks (added/removed lines, address, title, a dialog).
// Owns: the text format, the masking and the diff. Never: talks to a page (pure; driver.ts feeds it).

import { SIDE_TEXT_MAX } from '../../shared/model/side-browser.ts';

export interface AXValue { type?: string; value?: unknown }
export interface AXProperty { name: string; value: AXValue }
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** What a ref points at (for the agent's pointer line and the person's view of it). */
export interface RefInfo { role: string; name: string }

export interface Snapshot { lines: string[]; refs: Map<string, RefInfo>; cut: boolean }

/** Roles that only wrap or style text: their children take their place. */
const NOISE = new Set(['generic', 'none', 'presentation', 'inlinetextbox', 'linebreak', 'listmarker', 'labeltext', 'strong', 'emphasis', 'mark',
  'superscript', 'subscript', 'abbr', 'time', 'ruby', 'rubyannotation', 'rowgroup', 'layouttable', 'layouttablerow', 'layouttablecell', 'separator', 'div',
  'webarea', 'rootwebarea', 'svgroot', 'graphics-document', 'code', 'deletion', 'insertion', 'pre']);
/** Containers shown only when they have a name. */
const NAMED_ONLY = new Set(['group', 'section', 'region', 'img', 'image', 'figure', 'article', 'blockquote', 'caption', 'legend']);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'progressbar', 'meter']);
/** Chrome's own role names → the ARIA ones agents know (a <select>'s popup only wraps its options). */
const ROLE_ALIAS: Record<string, string> = { menulistoption: 'option', menulistpopup: 'none', image: 'img', textfield: 'textbox' };
/** Fields whose inner text is their value: never shown as text lines (the value line says it, masked when secret). */
const NO_CHILDREN = new Set(['textbox', 'searchbox', 'spinbutton', 'slider']);
/** A field whose value is a secret by its name (passwords, PINs, one-time codes, card codes). */
const SECRET_NAME = /pass(?:word|wort|code|phrase)?\b|\bpin\b|secret|one[- ]?time|\botp\b|\bcvc\b|\bcvv\b|security code|verification code|\btan\b/i;
/** Query/fragment keys whose values are secrets (as in shared/api/workspace-browser.ts keptAddress). */
const SECRET_PARAM = /token|secret|password|passwd|pwd|session|sid|auth|api_?key|^key$|code|sig|signature|credential|otp|state|nonce/i;
const TEXT_LINE_MAX = 400;
const NAME_MAX = 200;

function str(value: AXValue | undefined): string {
  const raw = value?.value;
  return typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : '';
}

function one(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const quote = (text: string) => `"${one(text, NAME_MAX).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** An address without secret query or fragment values and without user info; same site → path only. */
export function maskUrl(raw: string, origin?: string, max = 200): string {
  if (/^data:/i.test(raw)) return `data:… (${raw.length} characters)`;
  if (/^javascript:/i.test(raw)) return 'javascript:…';
  let url: URL;
  try { url = new URL(raw); } catch { return one(raw, max); }
  url.username = ''; url.password = '';
  for (const key of [...url.searchParams.keys()]) if (SECRET_PARAM.test(key)) url.searchParams.set(key, 'hidden');
  if (url.hash && /[=&]/.test(url.hash) && SECRET_PARAM.test(url.hash)) url.hash = 'hidden';
  const text = origin && url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
  return one(text, max);
}

interface Item { text?: string; role?: string; name?: string; extra?: string; ref?: string; children?: Item[] }

function props(node: AXNode): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const prop of node.properties ?? []) out.set(prop.name, prop.value?.value);
  return out;
}

function states(p: Map<string, unknown>): string {
  const out: string[] = [];
  const checked = p.get('checked');
  if (checked === 'true' || checked === true) out.push('[checked]'); else if (checked === 'mixed') out.push('[checked=mixed]');
  const pressed = p.get('pressed');
  if (pressed === 'true' || pressed === true) out.push('[pressed]'); else if (pressed === 'mixed') out.push('[pressed=mixed]');
  if (p.get('selected') === true) out.push('[selected]');
  if (p.has('expanded')) out.push(p.get('expanded') === true ? '[expanded]' : '[expanded=false]');
  if (typeof p.get('level') === 'number') out.push(`[level=${p.get('level')}]`);
  if (p.get('disabled') === true) out.push('[disabled]');
  if (p.get('required') === true) out.push('[required]');
  if (p.get('readonly') === true) out.push('[readonly]');
  const invalid = p.get('invalid');
  if (invalid !== undefined && invalid !== 'false' && invalid !== false) out.push('[invalid]');
  if (p.get('focused') === true) out.push('[focused]');
  if (p.get('modal') === true) out.push('[modal]');
  return out.join(' ');
}

/**
 * The tree as lines. `secret`: backend node ids of password inputs (their values are hidden like
 * every field named like a secret); `origin`: the page's own (its links show as paths).
 */
export function snapshotLines(nodes: readonly AXNode[], options: { origin?: string; secret?: ReadonlySet<number>; max?: number } = {}): Snapshot {
  const byId = new Map<string, AXNode>();
  for (const node of nodes) byId.set(node.nodeId, node);
  const root = nodes.find((node) => !node.parentId || !byId.has(node.parentId));
  const refs = new Map<string, RefInfo>();
  const seen = new Set<string>();

  const simplify = (id: string, depth: number): Item[] => {
    const node = byId.get(id);
    if (!node || seen.has(id) || depth > 200) return [];
    seen.add(id);
    const kids = () => (node.childIds ?? []).flatMap((child) => simplify(child, depth + 1));
    const raw = str(node.role).toLowerCase();
    const role = ROLE_ALIAS[raw] ?? raw;
    if (node.ignored) return kids();
    const ref = typeof node.backendDOMNodeId === 'number' ? `s${node.backendDOMNodeId}` : undefined;
    if (role === 'statictext') {
      const text = one(str(node.name), TEXT_LINE_MAX);
      return text ? [{ text, ...(ref ? { ref } : {}) }] : [];
    }
    const name = one(str(node.name), NAME_MAX);
    if (NOISE.has(role) || !role || (NAMED_ONLY.has(role) && !name)) return kids();
    const p = props(node);
    const parts = [states(p)];
    const url = p.get('url');
    if (role === 'link' && typeof url === 'string' && url) parts.push(`[url=${maskUrl(url, options.origin)}]`);
    let value = VALUE_ROLES.has(role) ? one(str(node.value), NAME_MAX) : '';
    if (!value && (role === 'slider' || role === 'progressbar') && typeof p.get('valuetext') === 'string') value = one(String(p.get('valuetext')), 80);
    if (value && ((node.backendDOMNodeId !== undefined && options.secret?.has(node.backendDOMNodeId)) || SECRET_NAME.test(name) || /^[•●*]+$/.test(value))) value = '[hidden]';
    if (ref) refs.set(ref, { role, name });
    const item: Item = { role, name, extra: parts.filter(Boolean).join(' '), ...(ref ? { ref } : {}), children: NO_CHILDREN.has(role) ? [] : kids() };
    if (value) item.text = value;
    return [item];
  };

  /** Adjacent text pieces become one line; a name already says the text it wraps. */
  const tidy = (items: Item[], name = ''): Item[] => {
    const out: Item[] = [];
    for (const item of items) {
      const prev = out[out.length - 1];
      if (!item.role && prev && !prev.role) prev.text = one(`${prev.text} ${item.text}`, TEXT_LINE_MAX);
      else out.push(item.role ? { ...item, children: tidy(item.children ?? [], item.name) } : { ...item });
    }
    const low = name.toLowerCase();
    // A label's text next to the field it names ("Email" before textbox "Email") says nothing new.
    const named = (item: Item | undefined) => (item?.role && item.name ? item.name.toLowerCase() : undefined);
    return out.filter((item, n) => {
      if (item.role) return true;
      const text = (item.text ?? '').toLowerCase();
      return !(low && low.includes(text)) && text !== named(out[n - 1]) && text !== named(out[n + 1]);
    });
  };

  const lines: string[] = [];
  let size = 0;
  let cut = false;
  const max = options.max ?? SIDE_TEXT_MAX;
  const emit = (items: Item[], indent: string) => {
    for (const item of items) {
      if (cut) return;
      if (!item.role) { push(`${indent}- text${item.ref ? ` [ref=${item.ref}]` : ''}: ${item.text}`); continue; }
      const children = item.children ?? [];
      // An unnamed element that only holds text says it inline ("- paragraph [ref=s7]: Hello").
      const inline = !item.name && item.text === undefined && children.length === 1 && !children[0]!.role ? children[0]!.text : undefined;
      const head = [`${indent}- ${item.role}`, item.name ? quote(item.name) : '', item.extra ?? '', item.ref ? `[ref=${item.ref}]` : ''].filter(Boolean).join(' ');
      push(item.text !== undefined ? `${head}: ${item.text}` : inline !== undefined ? `${head}: ${inline}` : head);
      if (inline === undefined && children.length) emit(children, `${indent}  `);
    }
  };
  const push = (line: string) => {
    if (cut) return;
    if (size + line.length + 1 > max - 120) { cut = true; lines.push(`… (the page is longer – cut at ${max} characters; use find to look for an element)`); return; }
    lines.push(line);
    size += line.length + 1;
  };
  if (root) emit(tidy(simplify(root.nodeId, 0)), '');
  return { lines, refs, cut };
}

/** The ref of a line ('s123'), if it has one. */
export function refOf(line: string): string | undefined {
  return /\[ref=(s\d+)\]/.exec(line)?.[1];
}

/** Lines matching every word of the query (case-insensitive over role, name and value; refs ignored). */
export function findLines(lines: readonly string[], query: string, max = 40): { lines: string[]; more: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = lines.filter((line) => {
    if (line.startsWith('…')) return false;
    const text = line.replace(/\[ref=s\d+\]/g, '').toLowerCase();
    return words.every((word) => text.includes(word));
  }).map((line) => line.trimStart());
  return { lines: hits.slice(0, max), more: Math.max(0, hits.length - max) };
}

/** Added and removed lines (as a multiset, indentation ignored). */
export function diffLines(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const line of before) { const key = line.trim(); count.set(key, (count.get(key) ?? 0) + 1); }
  const added: string[] = [];
  for (const line of after) {
    const key = line.trim();
    const left = count.get(key) ?? 0;
    if (left > 0) count.set(key, left - 1); else added.push(key);
  }
  const removed: string[] = [];
  for (const line of before) {
    const key = line.trim();
    const left = count.get(key) ?? 0;
    if (left > 0) { removed.push(key); count.set(key, left - 1); }
  }
  return { added, removed };
}

export interface Look { lines: string[]; url: string; title: string; doc: number }

const CHANGE_LINES = 80;

/**
 * What changed between an agent's last look and now. `full` when there was no earlier look on this
 * document or almost everything changed (the caller then hands over the whole snapshot).
 */
export function changeList(before: Look | undefined, after: Look, dialog?: string): { text: string; full: boolean } {
  const head: string[] = [];
  if (dialog) head.push(`Dialog: ${dialog} – press Enter to accept or Escape to dismiss it.`);
  if (!before || before.doc !== after.doc) {
    if (before && before.url !== after.url) head.unshift(`Address: ${maskUrl(after.url)} (was ${maskUrl(before.url)})`);
    return { text: head.join('\n'), full: true };
  }
  if (before.url !== after.url) head.push(`Address: ${maskUrl(after.url)} (was ${maskUrl(before.url)})`);
  if (before.title !== after.title) head.push(`Title: ${quote(after.title)}`);
  const { added, removed } = diffLines(before.lines, after.lines);
  const changed = added.length + removed.length;
  if (changed > 40 && changed > 0.6 * Math.max(before.lines.length, after.lines.length)) return { text: head.join('\n'), full: true };
  const body: string[] = [];
  let room = CHANGE_LINES;
  const list = (label: string, items: string[]) => {
    if (!items.length) return;
    body.push(`${label}:`);
    for (const item of items.slice(0, room)) body.push(item);
    if (items.length > room) body.push(`… ${items.length - room} more (take a full snapshot)`);
    room = Math.max(0, room - items.length);
  };
  list('Added', added);
  list('Removed', removed);
  if (!head.length && !body.length) return { text: 'No visible changes.', full: false };
  return { text: [...head, ...body].join('\n'), full: false };
}
