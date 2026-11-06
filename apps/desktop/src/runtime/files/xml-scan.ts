// A small forward-only scanner for the XML parts of Office documents (office.ts): start/end/empty
// tags with their raw attributes and decoded text runs; processing instructions, comments and
// declarations (DOCTYPE …) are skipped (no entity expansion beyond the five predefined entities and
// character references, so no "billion laughs"). Also the package relationship parts (.rels).
// One indexOf-based pass, linear in the part's length whatever the input: an unclosed comment,
// processing instruction, CDATA section or declaration ends the part; a '<' that starts no tag (or a
// tag that meets another '<' or an unclosed quote before its '>') is skipped as one character – well
// formed XML has no raw '<' inside a tag.
// Owns: tokenising, attribute lookup and entity decoding. Never: builds a tree (memory stays
// proportional to the text it yields), resolves external references, or backtracks.

export type XmlToken =
  | { kind: 'open'; name: string; attrs: string; empty: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string };

const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g;
const ATTRS = new Map<string, RegExp>();
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (_match, code: string) => {
    if (code[0] !== '#') return NAMED[code];
    const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : '';
  });
}

const nameStart = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95; // A-Z a-z _
const nameChar = (code: number) => nameStart(code) || (code >= 48 && code <= 57) || code === 46 || code === 58 || code === 45; // 0-9 . : -

/** The index of the '>' closing a tag whose attributes start at `from` (quotes respected); -1 at a raw '<', an unclosed quote or the end. */
function tagEnd(xml: string, from: number): number {
  let quote = 0;
  for (let index = from; index < xml.length; index++) {
    const code = xml.charCodeAt(index);
    if (code === 60) return -1; // a raw '<' (also inside quotes): no tag – the scan never passes it
    if (quote) { if (code === quote) quote = 0; continue; }
    if (code === 62) return index; // >
    if (code === 34 || code === 39) quote = code; // " '
  }
  return -1;
}

/** Tokens of `xml` in document order (linear time: every character is looked at a bounded number of times). */
export function* xmlTokens(xml: string): Generator<XmlToken> {
  let at = 0;
  while (at < xml.length) {
    const lt = xml.indexOf('<', at);
    if (lt < 0) { yield { kind: 'text', text: decodeEntities(xml.slice(at)) }; return; }
    if (lt > at) yield { kind: 'text', text: decodeEntities(xml.slice(at, lt)) };
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) return;
      at = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) return;
      yield { kind: 'text', text: xml.slice(lt + 9, end) };
      at = end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) return;
      at = end + 2;
    } else if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) return;
      at = end + 1;
    } else {
      const close = xml.charCodeAt(lt + 1) === 47; // </
      const start = lt + (close ? 2 : 1);
      let stop = start;
      if (nameStart(xml.charCodeAt(stop))) while (stop < xml.length && nameChar(xml.charCodeAt(stop))) stop++;
      const end = stop > start ? tagEnd(xml, stop) : -1;
      if (end < 0) { at = lt + 1; continue; } // no tag: the '<' is skipped, what follows reads as text
      const name = xml.slice(start, stop);
      if (close) yield { kind: 'close', name };
      else {
        const empty = xml.charCodeAt(end - 1) === 47 && end - 1 >= stop; // />
        yield { kind: 'open', name, attrs: xml.slice(stop, empty ? end - 1 : end), empty };
      }
      at = end + 1;
    }
  }
}

/** The decoded value of attribute `name` (with its prefix, e.g. 'w:val') in a raw attribute string. */
export function attr(attrs: string, name: string): string | undefined {
  let pattern = ATTRS.get(name);
  if (!pattern) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    if (ATTRS.size < 200) ATTRS.set(name, pattern);
  }
  const match = pattern.exec(attrs);
  return match ? decodeEntities(match[1] ?? match[2] ?? '') : undefined;
}

/** The local name of a tag ('w:p' → 'p'). */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

export interface Relationship { id: string; type: string; target: string }

/** Relationships of a .rels part, targets resolved against the folder of the part they belong to. */
export function relationships(xml: string, partFolder: string): Relationship[] {
  const out: Relationship[] = [];
  for (const token of xmlTokens(xml)) {
    if (token.kind !== 'open' || localName(token.name) !== 'Relationship') continue;
    if (attr(token.attrs, 'TargetMode') === 'External') continue;
    const id = attr(token.attrs, 'Id');
    const type = attr(token.attrs, 'Type');
    const target = attr(token.attrs, 'Target');
    if (id && type && target) out.push({ id, type, target: resolvePart(partFolder, target) });
  }
  return out;
}

/** A package part name: `target` relative to `folder` ('word'), or absolute ('/xl/x.xml'); '..' handled, never above the root. */
export function resolvePart(folder: string, target: string): string {
  const parts = target.startsWith('/') ? [] : folder.split('/').filter(Boolean);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}
