// What `rpc.methods` tells about each method's params. The types of src/shared vanish at build time and a packaged app has
// no source, so the build reads the Methods contract (every `interface Methods` under src/shared) as plain text and writes
// src/runtime/rpc/method-docs.generated.ts: each method's params as written there, its comment, and the named types those
// params use. No compiler: a small scanner that knows comments, strings and brackets.
//   node scripts/rpc-docs.mjs   writes the file (build.mjs does this too)
// Owns: that scan and that file. Never: which methods exist (the handler table says) or who may call them.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPE_MAX = 1500;
const NOTE_MAX = 240;
const OPEN = '{([<';
const CLOSE = '})]>';

/** The text with comments blanked out (same length, so offsets hold); strings stay, their inside no longer counts as brackets. */
export function blankComments(text) {
  const out = text.split('');
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let end = i + 1;
      while (end < text.length && text[end] !== ch && (ch === '`' || text[end] !== '\n')) end += text[end] === '\\' ? 2 : 1;
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop);
      i = stop - 1;
    }
  }
  return out.join('');
}

/** Where the bracket opened at `open` closes (an arrow's '>' does not count; strings are skipped). */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let end = i + 1;
      while (end < text.length && text[end] !== ch) end += text[end] === '\\' ? 2 : 1;
      i = end;
    } else if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch) && !(ch === '>' && text[i - 1] === '=')) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Where a type starting at `from` ends: the first `;` or `,` outside any bracket, or `stop`. */
function typeEnd(text, from, stop) {
  for (let i = from; i < stop; i++) {
    const ch = text[i];
    if (OPEN.includes(ch)) { const end = closing(text, i); if (end < 0 || end >= stop) return stop; i = end; } else if (ch === "'" || ch === '"' || ch === '`') {
      let end = i + 1;
      while (end < stop && text[end] !== ch) end += text[end] === '\\' ? 2 : 1;
      i = end;
    } else if (ch === ';' || ch === ',') return i;
  }
  return stop;
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/** The comment around one entry, without the build's own labels ("B-041:", "Added by R4 contracts:"). */
function noteOf(raw) {
  const text = oneLine(raw.replace(/^.*-{5,}.*$/gm, '').replace(/\/\*\*?|\*\//g, '').replace(/^\s*\*\s?/gm, '').replace(/^\s*\/\/\s?/gm, ''));
  const plain = text.replace(/^(?:Added [^:]{0,60}|[A-Z]{1,3}-?\d+[^:]{0,40}|\d+\.\d+\.[^:]{0,40}|wave \d[^:]{0,20}):\s*/i, '');
  return plain.length > NOTE_MAX ? `${plain.slice(0, NOTE_MAX - 1).trimEnd()}…` : plain;
}

/** The methods one source file declares: name → { params, note? }. */
export function methodsIn(source) {
  const text = blankComments(source);
  const found = {};
  for (const match of text.matchAll(/\binterface\s+Methods\b[^{]*\{/g)) {
    const open = match.index + match[0].length - 1;
    const close = closing(text, open);
    if (close < 0) continue;
    let at = open + 1;
    while (at < close) {
      const entry = /[\s;,]*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*/y;
      entry.lastIndex = at;
      const head = entry.exec(text);
      if (!head || head.index >= close) { at++; continue; }
      const name = head[1] ?? head[2] ?? head[3];
      const value = at + head[0].length;
      const end = text[value] === '{' ? closing(text, value) : typeEnd(text, value, close);
      const params = text[value] === '{' ? paramsOf(text, value, end) : undefined;
      if (params !== undefined) {
        // The comment lines above the entry (what stands on the line before them ended the entry before), else its own line's.
        const above = source.slice(at, at + head[0].indexOf(name) - 1).replace(/^[^\n]*\n?/, '');
        const beside = /^[ \t;,]*\/\/([^\n]*)/.exec(source.slice(end + 1))?.[1] ?? '';
        const note = noteOf(above.trim() ? above : beside);
        found[name] = { params, ...(note ? { note } : {}) };
      }
      at = end + 1;
    }
  }
  return found;
}

/** The `params` member of `{ params: …; result: … }`. */
function paramsOf(text, open, close) {
  let at = open + 1;
  while (at < close) {
    const member = /\s*(\w+)\??\s*:\s*/y;
    member.lastIndex = at;
    const head = member.exec(text);
    if (!head) return undefined;
    const value = at + head[0].length;
    const end = typeEnd(text, value, close);
    if (head[1] === 'params') return oneLine(text.slice(value, end));
    at = end + 1;
  }
  return undefined;
}

/** Every interface and type of a source file: name → its text (an interface declared twice is both texts). */
export function typesIn(source) {
  const text = blankComments(source);
  const found = {};
  for (const match of text.matchAll(/^[ \t]*(?:export\s+)?(?:interface|type)\s+([A-Z]\w*)[^\n={]*(?:=|\{)/gm)) {
    const start = match.index;
    const opener = start + match[0].length - 1;
    const end = text[opener] === '=' ? typeEnd(text, opener + 1, text.length) : closing(text, opener) + 1;
    if (end <= start) continue;
    const body = oneLine(text.slice(start, end)).replace(/^export\s+/, '');
    found[match[1]] = found[match[1]] ? `${found[match[1]]} & ${body}` : body;
  }
  return found;
}

/** The named types a piece of type text uses that `types` knows. */
export function namesIn(text, types) {
  return [...new Set(text.match(/\b[A-Z]\w*\b/g) ?? [])].filter((name) => Object.hasOwn(types, name));
}

async function sharedFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sharedFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/** The methods and the types their params use, read from `<root>/src/shared`. */
export async function readDocs(root) {
  const methods = {};
  const types = {};
  for (const file of await sharedFiles(path.join(root, 'src/shared'))) {
    const source = await readFile(file, 'utf8');
    Object.assign(methods, methodsIn(source));
    for (const [name, body] of Object.entries(typesIn(source))) types[name] = types[name] ? `${types[name]} & ${body}` : body;
  }
  const used = {};
  const queue = Object.values(methods).flatMap((method) => namesIn(method.params, types));
  while (queue.length) {
    const name = queue.pop();
    if (used[name]) continue;
    used[name] = types[name].length > TYPE_MAX ? `${types[name].slice(0, TYPE_MAX - 1).trimEnd()}…` : types[name];
    queue.push(...namesIn(types[name], types));
  }
  return { methods: sort(methods), types: sort(used) };
}

function sort(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const lines = (record) => Object.entries(record).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join('\n');

/** The generated module's text. */
export function docsModule(docs) {
  return [
    '// GENERATED by scripts/rpc-docs.mjs from the Methods contract in src/shared; every build writes it again, so edits here go.',
    '// Owns: each method\'s params and comment as written there, and the named types they use (read by rpc/handlers/rpc-methods.ts).',
    '// Never: says which methods exist or who may call them (the handler table does).',
    '',
    'export const METHOD_DOCS: Record<string, { params: string; note?: string }> = {',
    lines(docs.methods),
    '};',
    '',
    'export const TYPE_DOCS: Record<string, string> = {',
    lines(docs.types),
    '};',
    '',
  ].join('\n');
}

/** Writes the generated module when its text changed; true when written. */
export async function writeDocs(root) {
  const file = path.join(root, 'src/runtime/rpc/method-docs.generated.ts');
  const text = docsModule(await readDocs(root));
  const before = await readFile(file, 'utf8').catch(() => '');
  if (before === text) return false;
  await writeFile(file, text);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(await writeDocs(root) ? 'method-docs.generated.ts written' : 'method-docs.generated.ts is current');
}
