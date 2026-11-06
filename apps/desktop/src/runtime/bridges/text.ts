// Plain-text rendering of chat messages for messengers that cannot show our Markdown and blocks
// (Telegram sendMessage without parse_mode): Markdown marks removed, links spelled out,
// ```ui / ```app blocks replaced by one short line, and chunking at the messenger's limit.
// Owns: those pure conversions. Never: sends, logs or decides which messages leave the app.

import { parseMessage } from '../../shared/blocks/parse.ts';
import { MESSAGE_LIMIT } from './telegram-api.ts';

export const INTERACTIVE_LINE = '[interactive content – open the app]';
export const DIAGRAM_LINE = '[diagram – open the app]';

/** Message body (Markdown with fences) → readable plain text. */
export function toPlainText(markdown: string): string {
  const out: string[] = [];
  for (const part of parseMessage(markdown)) {
    let piece: string;
    if (part.kind === 'markdown') piece = plainMarkdown(part.text).trim();
    else if (part.kind === 'code') piece = part.text.replace(/^\n+|\s+$/g, '');
    else if (part.kind === 'mermaid') piece = DIAGRAM_LINE;
    else piece = INTERACTIVE_LINE; // ui, ui-pending, app: they only work inside the app
    if (!piece) continue;
    const placeholder = piece === INTERACTIVE_LINE || piece === DIAGRAM_LINE;
    if (placeholder && out[out.length - 1] === piece) continue; // several blocks in a row → one line
    out.push(piece);
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Splits text into messages of at most `limit` UTF-16 units, preferring paragraph/line/word breaks. */
export function chunkText(text: string, limit = MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut--; // never split an emoji
    const head = rest.slice(0, cut).trimEnd();
    if (head) chunks.push(head);
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Markdown text (no fences) → plain text; inline code spans keep their content untouched. */
function plainMarkdown(text: string): string {
  const lines = text.split('\n').map((line) => line
    .replace(/^\s{0,3}#{1,6}\s+/, '') // headings
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/, '') // horizontal rules
    .replace(/^(\s*)[*+-]\s+/, '$1• ')); // bullets
  return lines.join('\n')
    .split(/(`[^`\n]+`)/)
    .map((segment, index) => (index % 2 === 1 ? segment.slice(1, -1) : inline(segment)))
    .join('');
}

function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_all, alt: string) => (alt.trim() ? `[image: ${alt.trim()}]` : '[image]'))
    .replace(/\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_all, label: string, url: string) => (label === url ? url : `${label} (${url})`))
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // bold
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2') // *italic*
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1') // strikethrough
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1'); // escapes
}
