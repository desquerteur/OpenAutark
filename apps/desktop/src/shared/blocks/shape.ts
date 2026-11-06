// Per-type shaping of ```ui blocks: turns the many ways models write items, options, rows
// and fields into the one shape each renderer expects, and infers missing props where safe
// (chart x/y from data, table columns from row keys, record mode from the alias …).
// Owns: the per-type shapers (SHAPERS) and their aliases. Never: keeps secrets as default
// values or lets ask blocks hide inside tabs.

import { LIMITS } from './catalog.ts';
import type { BlockType, UiBlock } from './catalog.ts';
import { cell, isObj, normalizeAmount, parseDuration, slug, str, toBool, toNumber } from './coerce.ts';
import type { Obj } from './coerce.ts';
import { validateBlock } from './validate.ts';

// ---------------------------------------------------------------- per-type shaping

export type Shaper = (block: UiBlock, source: Obj, warnings: string[]) => string | void;

/** Turns string items into objects with `key`; keeps objects; drops junk. */
function itemsOf(value: unknown, key: string): Obj[] {
  if (!Array.isArray(value)) return [];
  const out: Obj[] = [];
  for (const item of value) {
    if (isObj(item)) out.push(item);
    else if (typeof item === 'string' || typeof item === 'number') out.push({ [key]: String(item) });
  }
  return out;
}

function pick(obj: Obj, keys: string[]): string | undefined {
  for (const key of keys) { const value = str(obj[key]); if (value) return value; }
  return undefined;
}

const STEP_STATUS: Record<string, string> = {
  done: 'done', complete: 'done', completed: 'done', finished: 'done', ok: 'done', success: 'done',
  active: 'active', running: 'active', in_progress: 'active', doing: 'active', current: 'active',
  todo: 'todo', pending: 'todo', open: 'todo', next: 'todo', waiting: 'todo',
  failed: 'failed', error: 'failed', blocked: 'failed',
};

function itemsFallback(source: Obj): unknown {
  return source.items ?? source.steps ?? source.entries ?? source.list ?? source.events;
}

export const SHAPERS: Partial<Record<BlockType, Shaper>> = {
  callout(block, source) {
    if (!block.text) block.text = pick(source, ['message', 'body', 'content', 'description']);
    if (!block.tone) block.tone = 'info';
  },
  steps(block, source) {
    block.items = itemsOf(block.items ?? itemsFallback(source), 'title').map(item => {
      const status = STEP_STATUS[(str(item.status) ?? '').toLowerCase().replace(/[\s-]+/g, '_')];
      const out: Obj = { title: pick(item, ['title', 'label', 'name', 'text']) ?? '' };
      const text = item.title !== undefined ? pick(item, ['text', 'detail', 'description']) : undefined;
      if (text) out.text = text;
      if (status) out.status = status;
      else if (item.done === true) out.status = 'done';
      return out;
    }).filter(item => item.title);
  },
  table(block, source, warnings) {
    let rows = Array.isArray(block.rows) ? block.rows : Array.isArray(source.data) ? source.data : [];
    let columns: Obj[] = [];
    const rawColumns = Array.isArray(block.columns) ? block.columns : Array.isArray(source.headers) ? source.headers : undefined;
    if (rawColumns) {
      columns = rawColumns.map((col, i) => isObj(col)
        ? { key: str(col.key) ?? str(col.label) ?? `c${i}`, label: str(col.label) ?? str(col.key) ?? '', ...(str(col.align) ? { align: str(col.align) } : {}) }
        : { key: str(col) ?? `c${i}`, label: str(col) ?? '' });
    } else {
      const first = rows.find(isObj);
      if (first) columns = Object.keys(first).map(key => ({ key, label: key }));
    }
    if (rows.length > LIMITS.tableRows) { warnings.push(`table cut to ${LIMITS.tableRows} rows`); block.truncated = rows.length; rows = rows.slice(0, LIMITS.tableRows); }
    // One shape for renderers: rows as arrays in column order, cells as strings.
    block.rows = rows.map(row => {
      if (Array.isArray(row)) return columns.map((_, i) => cell(row[i]));
      if (isObj(row)) return columns.map((col, i) => cell(row[col.key as string] ?? row[col.label as string] ?? Object.values(row)[i]));
      return [cell(row)];
    });
    if (columns.length === 0 && (block.rows as unknown[][]).length) {
      const width = Math.max(...(block.rows as unknown[][]).map(r => r.length));
      columns = Array.from({ length: width }, (_, i) => ({ key: `c${i}`, label: '' }));
    }
    block.columns = columns;
  },
  stats(block, source) {
    block.items = itemsOf(block.items ?? itemsFallback(source) ?? source.kpis, 'label').map(item => {
      const out: Obj = { label: pick(item, ['label', 'name', 'title']) ?? '', value: pick(item, ['value', 'v', 'amount']) ?? '' };
      const delta = pick(item, ['delta', 'change']);
      if (delta) out.delta = delta;
      const trend = str(item.trend)?.toLowerCase();
      if (trend === 'up' || trend === 'down' || trend === 'flat') out.trend = trend;
      else if (delta) out.trend = delta.startsWith('-') ? 'down' : delta.startsWith('+') ? 'up' : 'flat';
      const hint = pick(item, ['hint', 'note']);
      if (hint) out.hint = hint;
      return out;
    }).filter(item => item.label || item.value);
  },
  chart(block, source, warnings) {
    let data = itemsOf(block.data ?? source.points ?? source.series, 'label');
    if (data.length > LIMITS.chartPoints) { warnings.push(`chart cut to ${LIMITS.chartPoints} points`); data = data.slice(0, LIMITS.chartPoints); }
    if (!block.kind) block.kind = 'bar';
    const keys = data.length ? Object.keys(data[0]) : [];
    if (!block.x) block.x = keys.find(k => typeof data[0][k] === 'string') ?? keys[0];
    let y: string[] = Array.isArray(block.y) ? (block.y as unknown[]).map(v => String(v)) : typeof block.y === 'string' ? [block.y] : [];
    if (y.length === 0) y = keys.filter(k => k !== block.x && data.some(d => toNumber(d[k]) !== undefined));
    if (y.length === 0) return '"y" missing';
    block.y = y.length === 1 ? y[0] : y;
    // Numbers held in strings are parsed once here, renderers trust numbers.
    block.data = data.map(d => {
      const out: Obj = { ...d };
      for (const key of y) { const n = toNumber(d[key]); out[key] = n ?? null; }
      if (block.kind === 'scatter') { const n = toNumber(d[block.x as string]); if (n !== undefined) out[block.x as string] = n; }
      return out;
    });
  },
  timeline(block, source) {
    block.items = itemsOf(block.items ?? itemsFallback(source), 'title').map(item => {
      const out: Obj = { date: pick(item, ['date', 'when', 'time', 'at']) ?? '', title: pick(item, ['title', 'label', 'name', 'event']) ?? '' };
      const text = pick(item, ['text', 'detail', 'description']);
      if (text) out.text = text;
      return out;
    }).filter(item => item.title);
  },
  compare(block, source) {
    block.options = itemsOf(block.options ?? source.items, 'name').map(item => {
      const out: Obj = { name: pick(item, ['name', 'title', 'label']) ?? '' };
      for (const key of ['pros', 'cons']) {
        const value = item[key];
        const list = Array.isArray(value) ? value.map(v => str(v)).filter(Boolean) : str(value) ? [str(value)] : [];
        if (list.length) out[key] = list;
      }
      if (isObj(item.facts)) out.facts = Object.fromEntries(Object.entries(item.facts).map(([k, v]) => [k, cell(v)]));
      if (toBool(item.pick) || toBool(item.recommended)) out.pick = true;
      return out;
    }).filter(item => item.name);
  },
  cards(block, source) {
    block.items = itemsOf(block.items ?? source.cards ?? source.links, 'title').map(item => {
      const out: Obj = { title: pick(item, ['title', 'name', 'label']) ?? str(item.url) ?? '' };
      for (const key of ['text', 'url', 'image', 'meta']) { const value = pick(item, key === 'text' ? ['text', 'description', 'summary'] : key === 'url' ? ['url', 'href', 'link'] : [key]); if (value) out[key] = value; }
      return out;
    }).filter(item => item.title).slice(0, 12);
  },
  media(block, source) {
    if (!block.src) block.src = pick(source, ['url', 'path', 'file']);
    if (Array.isArray(block.items)) block.items = itemsOf(block.items, 'src').filter(item => str(item.src ?? item.url));
    if (!block.src && !(Array.isArray(block.items) && block.items.length)) return '"src" missing';
  },
  file(block, source) {
    if (!block.path) block.path = pick(source, ['file', 'src', 'url']);
  },
  progress(block, source) {
    if (!block.label) block.label = pick(source, ['text', 'title', 'name']);
    if (typeof block.value === 'number') {
      let value = block.value;
      if (value > 1 && value <= 100) value /= 100; // "45" or "45%" means percent
      block.value = Math.min(1, Math.max(0, value));
    }
  },
  tabs(block, source) {
    const tabs = itemsOf(block.tabs ?? source.items, 'label').map(tab => {
      const inner = Array.isArray(tab.blocks) ? tab.blocks : tab.block ? [tab.block] : isObj(tab.content) ? [tab.content] : [];
      const blocks = inner.map(b => validateBlock(b, { nested: true })).map(r => (r.ok ? r.block : { type: 'callout', tone: 'warning', text: `Couldn't display: ${r.error}` }));
      const text = typeof tab.content === 'string' ? tab.content : str(tab.text);
      if (text) blocks.unshift({ type: 'callout', tone: 'info', text });
      return { label: pick(tab, ['label', 'title', 'name']) ?? '', blocks };
    }).filter(tab => tab.label);
    block.tabs = tabs;
  },
  choice(block, source) {
    if (!block.question) block.question = pick(source, ['text', 'prompt', 'label', 'title']);
    let options = block.options ?? source.choices ?? source.buttons;
    if (typeof options === 'string') options = options.split(/\s*[|,\n]\s*/);
    const list = (Array.isArray(options) ? options : []).map(opt => {
      if (isObj(opt)) {
        const label = pick(opt, ['label', 'text', 'title', 'name', 'value']) ?? '';
        const out: Obj = { label, value: str(opt.value) ?? label };
        const hint = pick(opt, ['hint', 'description']);
        if (hint) out.hint = hint;
        return out;
      }
      const label = str(opt) ?? '';
      return { label, value: label };
    }).filter(opt => opt.label);
    block.options = list.slice(0, LIMITS.choiceOptions);
  },
  form(block, source) {
    const fields = itemsOf(block.fields ?? source.inputs, 'label').map(field => {
      const label = pick(field, ['label', 'name', 'title']) ?? '';
      const kind = (str(field.kind ?? field.type) ?? 'text').toLowerCase();
      const out: Obj = { name: str(field.name) ? slug(str(field.name)!) : slug(label), label, kind: FIELD_KINDS.has(kind) ? kind : FIELD_ALIASES[kind] ?? 'text' };
      if (Array.isArray(field.options)) out.options = field.options.map(o => (isObj(o) ? str(o.label ?? o.value) : str(o))).filter(Boolean);
      if (toBool(field.required)) out.required = true;
      const value = field.value ?? field.default;
      if (value !== undefined && out.kind !== 'secret') out.value = value; // never echo secrets
      const placeholder = str(field.placeholder);
      if (placeholder) out.placeholder = placeholder;
      // PM6: the site a secret is for (the runtime binds the stored secret to its registrable domain).
      const domain = out.kind === 'secret' ? str(field.domain ?? field.site)?.trim().slice(0, 300) : undefined;
      if (domain) out.domain = domain;
      return out;
    }).filter(field => field.label);
    block.fields = fields;
  },
  approve(block, source) {
    if (!block.action) block.action = pick(source, ['text', 'question', 'summary', 'title']);
    const amount = normalizeAmount(block.amount ?? source.price ?? source.cost);
    if (amount) block.amount = amount; else delete block.amount;
  },
  checklist(block, source) {
    let items = block.items ?? source.checklist ?? source.tasks;
    if (typeof items === 'string') items = items.split(/\n+/).map(s => s.replace(/^\s*[-*\d.)\]\[x ]+\s*/i, '')).filter(Boolean);
    block.items = itemsOf(items, 'text').map(item => ({ text: pick(item, ['text', 'label', 'title']) ?? '', done: toBool(item.done ?? item.checked) === true })).filter(item => item.text);
  },
  timer(block, source) {
    if (!block.label) block.label = pick(source, ['text', 'title', 'message']);
    if (!block.at) { const at = pick(source, ['time', 'when', 'datetime']); if (at) block.at = at; }
    if (!block.duration) {
      const raw = source.minutes !== undefined ? `${source.minutes}m` : source.seconds !== undefined ? `${source.seconds}s` : undefined;
      if (raw) block.duration = raw;
    }
    if (block.duration && parseDuration(String(block.duration)) === undefined) return '"duration" unreadable';
  },
  record(block, source) {
    if (!block.script) { const script = pick(source, ['text', 'teleprompter']); if (script) block.script = script; }
    if (block.maxSeconds !== undefined && (block.maxSeconds as number) <= 0) delete block.maxSeconds;
  },
  upload(block, source) {
    if (!block.label) block.label = pick(source, ['text', 'title', 'instructions']) ?? 'Files';
  },
  confirm(block, source) {
    if (!block.instructions) block.instructions = pick(source, ['text', 'label', 'title', 'message']);
  },
  review(block, source) {
    if (!block.src) block.src = pick(source, ['url', 'path', 'file']);
  },
};

/** Common model variants of enum values (applied before the enum check). */

const FIELD_KINDS = new Set(['text', 'longtext', 'number', 'date', 'time', 'select', 'toggle', 'email', 'url', 'secret']);
const FIELD_ALIASES: Record<string, string> = {
  textarea: 'longtext', multiline: 'longtext', password: 'secret', token: 'secret', apikey: 'secret', api_key: 'secret',
  checkbox: 'toggle', boolean: 'toggle', bool: 'toggle', dropdown: 'select', choice: 'select', int: 'number', integer: 'number',
  datetime: 'date', link: 'url', mail: 'email', string: 'text',
};

