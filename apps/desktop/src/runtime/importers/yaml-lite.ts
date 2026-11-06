// A small YAML subset reader (team pattern front matter, patterns/format.ts). Supports nested mappings by indentation, block scalars
// (| and > with - / + chomping), plain, single- and double-quoted scalars, flow sequences [a, b],
// block sequences ("- item", items scalar or mapping), and # comments outside quotes.
// Anchors, aliases, tags and multi-documents are not interpreted (their text stays plain).
// Owns: this parser (pure, bounded by its input). Never: evaluates anything, follows references or
// throws on odd input – an unreadable line is skipped and counted in `skipped`.

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

interface Line { indent: number; text: string; raw: string }

const MAX_DEPTH = 16;

function stripComment(text: string): string {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = undefined; continue; }
    if (ch === '"' || ch === "'") { if (i === 0 || /[\s:[,{-]/.test(text[i - 1])) quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function lines(source: string): Line[] {
  return source.replace(/^\uFEFF/, '').split(/\r?\n/).map((raw) => {
    const indent = raw.length - raw.trimStart().length;
    return { indent, text: stripComment(raw.trim()), raw };
  });
}

/** A scalar as written: quotes removed (double quotes with \n, \t, \" and \\ escapes), plain text trimmed. */
export function scalar(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\nt])/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

function flow(value: string): YamlValue {
  const text = value.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return scalar(text);
  const inner = text.slice(1, -1);
  const out: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const ch of inner) {
    if (quote) { current += ch; if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { out.push(scalar(current)); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(scalar(current));
  return out.filter((item) => item !== '');
}

class Reader {
  private readonly rows: Line[];
  private index = 0;
  skipped = 0;

  constructor(source: string) { this.rows = lines(source); }

  private next(): Line | undefined {
    while (this.index < this.rows.length && !this.rows[this.index].text) this.index++;
    return this.rows[this.index];
  }

  /** Block scalar lines deeper than `parent` (raw, so inner '#' and blank lines stay). */
  private block(parent: number, style: string): string {
    const taken: string[] = [];
    let indent: number | undefined;
    while (this.index < this.rows.length) {
      const row = this.rows[this.index];
      if (row.raw.trim() && row.indent <= parent) break;
      if (row.raw.trim()) indent ??= row.indent;
      taken.push(row.raw.trim() ? row.raw.slice(indent ?? 0) : '');
      this.index++;
    }
    while (taken.length && !taken[taken.length - 1]) taken.pop();
    const folded = style.startsWith('>')
      ? taken.join('\n').replace(/([^\n])\n(?=[^\n\s])/g, '$1 ')
      : taken.join('\n');
    return style.includes('+') ? `${folded}\n` : folded;
  }

  private value(rest: string, parent: number, depth: number): YamlValue {
    if (/^[|>][-+]?\d?$/.test(rest)) return this.block(parent, rest);
    if (rest) return flow(rest);
    const row = this.next();
    if (!row || row.indent <= parent) {
      // A sequence may sit at the same indent as its key ("key:\n- a").
      if (row && row.indent === parent && row.text.startsWith('- ')) return this.sequence(row.indent, depth + 1);
      return '';
    }
    return row.text.startsWith('- ') || row.text === '-' ? this.sequence(row.indent, depth + 1) : this.mapping(row.indent, depth + 1);
  }

  sequence(indent: number, depth: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (depth <= MAX_DEPTH) {
      const row = this.next();
      if (!row || row.indent !== indent || !(row.text.startsWith('- ') || row.text === '-')) break;
      this.index++;
      const item = row.text.slice(1).trim();
      const pair = /^([^\s"'][^:]*?):(?:\s+(.*))?$/.exec(item);
      if (pair && !item.startsWith('[')) {
        // "- key: value" starts a mapping whose other keys sit at the item's text indent.
        const map: YamlMap = { [pair[1].trim()]: this.value(pair[2]?.trim() ?? '', indent + 1, depth) };
        const more = this.next();
        if (more && more.indent > indent && !more.text.startsWith('- ')) Object.assign(map, this.mapping(more.indent, depth + 1));
        out.push(map);
      } else {
        out.push(item ? flow(item) : this.value('', indent, depth));
      }
    }
    return out;
  }

  mapping(indent: number, depth: number): YamlMap {
    const out: YamlMap = {};
    while (depth <= MAX_DEPTH) {
      const row = this.next();
      if (!row || row.indent < indent) break;
      if (row.indent > indent) { this.index++; this.skipped++; continue; }
      const pair = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(row.text);
      if (!pair) { this.index++; this.skipped++; continue; }
      this.index++;
      out[scalar(pair[1])] = this.value(pair[2]?.trim() ?? '', indent, depth);
    }
    return out;
  }
}

/** Parses a YAML mapping document; `skipped` counts lines it could not read. */
export function parseYaml(source: string): { value: YamlMap; skipped: number } {
  const reader = new Reader(source);
  const value = reader.mapping(0, 0);
  return { value, skipped: reader.skipped };
}

/** Splits `---` front matter from a Markdown body; undefined when the file has none. */
export function frontMatter(source: string): { data: YamlMap; body: string; skipped: number } | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(source);
  if (!match) return undefined;
  const parsed = parseYaml(match[1]);
  return { data: parsed.value, body: (match[2] ?? '').trim(), skipped: parsed.skipped };
}

/** A value as text (lists joined with ", "); undefined for mappings and empties. */
export function asText(value: YamlValue | undefined): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    return items.length ? items.join(', ') : undefined;
  }
  return undefined;
}

/** A value as a list of strings ("a, b" splits at commas). */
export function asList(value: YamlValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}
