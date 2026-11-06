// Streaming-safe segmenter for agent messages: Markdown text with ```mermaid, ```ui and
// ```app fences (web-genui §7.2/§7.5). Used by every renderer (desktop, PWA, phone) and by
// the runtime (ask blocks → human to-dos, repair notes to the agent).
// Owns: fence detection, the part list, stable block indexes, ui JSON parsing + validation
// (via lenient-json/validate), app info-string attributes (incl. a to-do's reason=, F01) and
// size limits.
// Never: renders anything, touches the DOM, or treats ```html / ```json as live UI; never
// words a human answer (the person's line for it is shared/blocks/answer-text.ts).
//
// Block indexes: every ```ui object (each element of a ```ui array counts separately) and
// every ```app fence gets the next index, in document order, starting at 0. Mermaid and code
// fences do not consume indexes. Because messages only grow while streaming and indexes are
// assigned only to *closed* fences, an index never changes once assigned. The host's block
// key is `b_<messageId>_<index>` (see blockKey).

import { LIMITS, specFor } from './catalog.ts';
import type { UiBlock } from './catalog.ts';
import { LenientJsonError, parseLenientJson } from './lenient-json.ts';
import { validateBlock } from './validate.ts';

export type UiParseResult =
  | { ok: true; block: UiBlock; warnings: string[] }
  | { ok: false; error: string; source: string; type?: string; ask: boolean };

export interface AppAttrs {
  title?: string;
  todo: boolean; // default false: an app is a to-do only when the agent says so
  expand: boolean;
  permissions: string[]; // e.g. ["microphone"]; granted only by the human, once
  /** Why a todo=true app needs the person (F01: the to-do's humanReason, default 'taste'). */
  reason?: AppReason;
}

/**
 * The reasons a mini-app to-do may give. Approvals and credentials are not among them: the
 * host's approval flow and the vault (secret form fields) own those, never an agent's app.
 */
export type AppReason = 'physical' | 'identity' | 'taste' | 'review';
const APP_REASONS: ReadonlySet<string> = new Set<AppReason>(['physical', 'identity', 'taste', 'review']);

export type Part =
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; lang: string; text: string; closed: boolean }
  | { kind: 'mermaid'; source: string; closed: boolean }
  | { kind: 'ui'; index: number; result: UiParseResult }
  /** A ```ui fence that is still streaming; `hint` is the first "type" seen. */
  | { kind: 'ui-pending'; hint?: string }
  | { kind: 'app'; index: number; attrs: AppAttrs; html: string; closed: boolean; error?: string };

export interface ParseOptions {
  /** True while the message is still streaming: an unclosed trailing fence stays pending. */
  streaming?: boolean;
}

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

/** `b_<messageId>_<index>` – the host's stable id for a block (the model never writes it). */
export function blockKey(messageId: string, index: number): string {
  return `b_${messageId}_${index}`;
}

/** Splits a message body into renderable parts. Pure and cheap; memoize by body in the UI. */
export function parseMessage(body: string, opts: ParseOptions = {}): Part[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const parts: Part[] = [];
  let text: string[] = [];
  let nextIndex = 0;

  const flushText = (): void => {
    const joined = text.join('\n');
    if (joined.trim()) parts.push({ kind: 'markdown', text: joined });
    text = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) { text.push(lines[i]); continue; }
    const marker = open[1];
    const info = open[2].trim();
    const lang = (info.split(/\s+/)[0] ?? '').toLowerCase();
    // Find the closing fence: same char, at least as long, nothing else on the line.
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (candidate.length >= marker.length && candidate[0] === marker[0] && /^(`+|~+)$/.test(candidate)) { close = j; break; }
    }
    const closed = close >= 0;
    const inner = lines.slice(i + 1, closed ? close : lines.length).join('\n');
    flushText();
    const kind = fenceKind(lang);

    if (kind === 'ui') {
      if (!closed && opts.streaming) parts.push({ kind: 'ui-pending', hint: typeHint(inner) });
      else for (const result of parseUiFence(inner, closed)) parts.push({ kind: 'ui', index: nextIndex++, result });
    } else if (kind === 'mermaid') {
      parts.push({ kind: 'mermaid', source: inner, closed });
    } else if (kind === 'app') {
      const attrs = parseAppInfo(info.slice(lang.length));
      const tooBig = byteLength(inner) > LIMITS.appHtmlBytes;
      if (closed || !opts.streaming) {
        parts.push({ kind: 'app', index: nextIndex++, attrs, html: tooBig ? '' : inner, closed, ...(tooBig ? { error: 'app too large' } : closed ? {} : { error: 'app fence not closed' }) });
      } else {
        parts.push({ kind: 'app', index: -1, attrs, html: '', closed: false }); // skeleton while streaming
      }
    } else {
      parts.push({ kind: 'code', lang: info.split(/\s+/)[0] ?? '', text: inner, closed });
    }
    i = closed ? close : lines.length;
  }
  flushText();
  return mergeMarkdown(parts);
}

/** True for the fence languages we render live. ```html/```json stay code on purpose. */
function fenceKind(lang: string): 'ui' | 'mermaid' | 'app' | 'code' {
  if (lang === 'ui' || lang === 'wf-ui' || lang === 'ui-json' || lang === 'a2ui') return 'ui';
  if (lang === 'mermaid' || lang === 'mmd') return 'mermaid';
  if (lang === 'app' || lang === 'wf-app') return 'app';
  return 'code';
}

function mergeMarkdown(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (part.kind === 'markdown' && last?.kind === 'markdown') last.text += `\n\n${part.text}`;
    else out.push(part);
  }
  return out;
}

function byteLength(text: string): number {
  // UTF-8 length without TextEncoder (shared code has no DOM/Node typings).
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; } // surrogate pair
    else bytes += 3;
  }
  return bytes;
}

/** First "type" value in a partial ```ui fence, for the "Preparing chart…" skeleton. */
function typeHint(partial: string): string | undefined {
  const match = /["']?(?:type|component|widget)["']?\s*[:=]\s*["']([A-Za-z_\- ]{2,30})["']/.exec(partial);
  return match?.[1].trim().toLowerCase();
}

/** Parses one ```ui fence into one result per block (arrays and JSONL become several). */
export function parseUiFence(source: string, closed = true): UiParseResult[] {
  const fail = (error: string, type?: string, ask = false): UiParseResult[] => [{ ok: false, error, source, type, ask }];
  if (byteLength(source) > LIMITS.uiJsonBytes) return fail(`block larger than ${LIMITS.uiJsonBytes / 1024} KB`);
  let values: unknown[];
  try {
    values = parseLenientJson(stripLanguageLine(source));
  } catch (error) {
    const hint = typeHint(source);
    // A final message whose fence never closed is usually cut off; say so instead of a JSON error.
    const message = !closed ? 'block cut off (fence not closed)' : error instanceof LenientJsonError ? `invalid JSON: ${error.message}` : 'invalid JSON';
    return fail(message, hint, Boolean(hint && specFor(hint)?.kind === 'ask'));
  }
  const blocks = values.flatMap(value => (Array.isArray(value) ? value : [value]));
  if (blocks.length === 0) return fail('empty block');
  return blocks.map((value): UiParseResult => {
    const result = validateBlock(value);
    if (result.ok) return result;
    return { ok: false, error: result.error, source: blocks.length > 1 ? safeStringify(value) : source, type: result.type, ask: result.ask };
  });
}

/** Models sometimes repeat the language ("json") on the first line inside the fence. */
function stripLanguageLine(source: string): string {
  return source.replace(/^\s*(json5?|jsonc|ui)\s*\n/i, '');
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return ''; }
}

/** Info string after ```app: title="Voice take" todo=true reason=physical expand permissions="microphone". */
export function parseAppInfo(info: string): AppAttrs {
  const attrs: AppAttrs = { todo: false, expand: false, permissions: [] };
  const re = /([A-Za-z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
  for (let match = re.exec(info); match; match = re.exec(info)) {
    const key = match[1].toLowerCase();
    const raw = match[2] ?? match[3] ?? match[4];
    const flag = raw === undefined ? true : !/^(false|no|0|off)$/i.test(raw);
    if (key === 'title') { if (raw?.trim()) attrs.title = raw.trim().slice(0, 120); } // a blank title is none
    else if (key === 'todo') attrs.todo = flag;
    else if (key === 'expand') attrs.expand = flag;
    else if (key === 'reason' && raw && APP_REASONS.has(raw.toLowerCase())) attrs.reason = raw.toLowerCase() as AppReason;
    else if (key === 'permissions' || key === 'permission') {
      attrs.permissions = (raw ?? '').split(/[\s,]+/).map(p => p.toLowerCase()).filter(p => APP_PERMISSIONS.has(p));
    }
  }
  return attrs;
}

/** What an app may ask the person for (anything else in permissions= is dropped). */
export const APP_PERMISSIONS: ReadonlySet<string> = new Set(['microphone', 'camera', 'clipboard-write']);

// ---------------------------------------------------------------- helpers for consumers

export interface IndexedBlock {
  index: number;
  block: UiBlock;
}

/** Valid ```ui blocks of a final message with their stable indexes. */
export function uiBlocksOf(body: string): IndexedBlock[] {
  const out: IndexedBlock[] = [];
  for (const part of parseMessage(body)) if (part.kind === 'ui' && part.result.ok) out.push({ index: part.index, block: part.result.block });
  return out;
}

/** ```app fences marked todo=true (agent-programmed custom to-do items). */
export function appTodosOf(body: string): Array<{ index: number; attrs: AppAttrs }> {
  const out: Array<{ index: number; attrs: AppAttrs }> = [];
  for (const part of parseMessage(body)) if (part.kind === 'app' && part.closed && !part.error && part.attrs.todo) out.push({ index: part.index, attrs: part.attrs });
  return out;
}

/** The HTML of ```app fence number `index` (for the sandbox loader). */
export function appHtmlOf(body: string, index: number): string | undefined {
  for (const part of parseMessage(body)) if (part.kind === 'app' && part.index === index && part.closed && !part.error) return part.html;
  return undefined;
}

/**
 * Repair notes for invalid ask blocks (web-genui §7.5): a human task would otherwise be lost,
 * so the host appends e.g. `[ui-error block "thumb" (2nd block): "options" missing in choice] I send that block again, fixed.`
 * to the agent's next turn. B-076: the block is named by its "id" (else its question or title) and counted from 1
 * – a bare 0-based index made an agent resend the wrong block. Display-block errors produce no note.
 */
export function repairNotesOf(body: string): string[] {
  const notes: string[] = [];
  for (const part of parseMessage(body)) {
    if (part.kind === 'ui' && !part.result.ok && part.result.ask) {
      const name = blockName(part.result.source);
      notes.push(`[ui-error block ${name ? `${name} ` : ''}(${ordinal(part.index + 1)} block${name ? '' : `, ${part.result.type ?? 'ask'}`}): ${part.result.error}] I send that block again, fixed.`);
    }
  }
  return notes;
}

/** A failed block's "id" (else its question or title) from its source, quoted – also when its JSON does not parse. */
function blockName(source: string): string | undefined {
  for (const key of ['id', 'question', 'title']) {
    const match = new RegExp(`(?<![\\w-])["'“„]?${key}["'”“]?\\s*[:=]\\s*(?:"([^"\\n]{1,80})|'([^'\\n]{1,80})|[“„”]([^”“\\n]{1,80}))`).exec(source);
    const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
    if (value) return `"${value.length > 60 ? `${value.slice(0, 59)}…` : value}"`;
  }
  return undefined;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/**
 * Closes dangling inline Markdown at the streaming tail (Streamdown-style) so half-written
 * **bold** or `code` does not flash raw markers. Only touches the last paragraph.
 */
export function repairStreamingTail(text: string): string {
  const cut = text.lastIndexOf('\n\n');
  const tail = text.slice(cut + 1);
  let fix = '';
  if ((tail.match(/`/g)?.length ?? 0) % 2 === 1) fix += '`';
  const withoutCode = tail.replace(/`[^`]*`/g, '');
  if ((withoutCode.match(/\*\*/g)?.length ?? 0) % 2 === 1) fix += '**';
  if ((withoutCode.match(/~~/g)?.length ?? 0) % 2 === 1) fix += '~~';
  // A trailing unfinished link "[label](http…" is hidden until it closes.
  const link = /\[[^\]\n]*\]\([^)\s]*$/.exec(tail);
  if (link && !fix.includes('`')) return text.slice(0, cut + 1 + link.index) + fix;
  return text + fix;
}
