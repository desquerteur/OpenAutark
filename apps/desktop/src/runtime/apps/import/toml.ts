// B-052 import (M7): a small TOML reader for Codex's config.toml – enough for `[mcp_servers.<name>]` and
// `[mcp_servers.<name>.env]`: tables and arrays of tables, bare/quoted/dotted keys, basic and literal strings
// (also multi-line), integers, floats, booleans, arrays (multi-line, trailing comma, comments), inline tables and
// comments. Dates stay text. It tolerates everything else: a statement it cannot read is skipped up to the end of
// its line, so one odd setting never hides the person's servers.
// Owns: the parsing. Never: reads a file, evaluates anything, or lets a key reach an object's prototype.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [key: string]: TomlValue }

class Unreadable extends Error {}

const BARE = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' };
const isTable = (value: TomlValue | undefined): value is TomlTable => typeof value === 'object' && value !== null && !Array.isArray(value);

class Reader {
  private readonly s: string;
  private i = 0;
  private readonly root: TomlTable = {};
  private current: TomlTable;

  constructor(text: string) {
    this.s = text.replace(/^﻿/, '');
    this.current = this.root;
  }

  document(): TomlTable {
    while (this.i < this.s.length) {
      const start = this.i;
      try {
        this.statement();
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        this.i = start;
        this.skipLine();
      }
    }
    return this.root;
  }

  private peek(offset = 0): string { return this.s[this.i + offset] ?? ''; }
  private startsWith(text: string): boolean { return this.s.startsWith(text, this.i); }
  private fail(): never { throw new Unreadable(); }

  private skipSpaces(): void { while (this.peek() === ' ' || this.peek() === '\t') this.i += 1; }

  private skipLine(): void {
    const end = this.s.indexOf('\n', this.i);
    this.i = end < 0 ? this.s.length : end + 1;
  }

  /** Spaces, newlines and comments (inside arrays and inline tables). */
  private skipBlank(): void {
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (c === '#') { const end = this.s.indexOf('\n', this.i); this.i = end < 0 ? this.s.length : end; } else if (c === '\n' || c === '\r') this.i += 1;
      else return;
    }
  }

  private endOfLine(): void {
    this.skipSpaces();
    if (this.peek() === '#') { this.skipLine(); return; }
    if (this.peek() === '\r') this.i += 1;
    if (this.peek() === '\n') { this.i += 1; return; }
    if (this.i < this.s.length) this.fail();
  }

  private statement(): void {
    this.skipSpaces();
    const c = this.peek();
    if (c === '' || c === '#' || c === '\n' || c === '\r') { this.endOfLine(); return; }
    if (c === '[') { this.header(); return; }
    const keys = this.key();
    this.skipSpaces();
    if (this.peek() !== '=') this.fail();
    this.i += 1;
    this.skipSpaces();
    const value = this.value();
    this.endOfLine();
    this.assign(this.current, keys, value);
  }

  private header(): void {
    const many = this.startsWith('[[');
    this.i += many ? 2 : 1;
    this.skipSpaces();
    const keys = this.key();
    this.skipSpaces();
    if (!this.startsWith(many ? ']]' : ']')) this.fail();
    this.i += many ? 2 : 1;
    this.endOfLine();
    if (!many) { this.current = this.table(this.root, keys); return; }
    const parent = this.table(this.root, keys.slice(0, -1));
    const last = keys[keys.length - 1];
    const list = Object.hasOwn(parent, last) ? parent[last] : (parent[last] = []);
    if (!Array.isArray(list)) this.fail();
    const entry: TomlTable = {};
    list.push(entry);
    this.current = entry;
  }

  /** The table at `keys` below `from` (created; the last entry of an array of tables). */
  private table(from: TomlTable, keys: string[]): TomlTable {
    let at = from;
    for (const key of keys) {
      if (!Object.hasOwn(at, key)) at[key] = {};
      let next = at[key];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!isTable(next)) this.fail();
      at = next;
    }
    return at;
  }

  private assign(into: TomlTable, keys: string[], value: TomlValue): void {
    const table = this.table(into, keys.slice(0, -1));
    const last = keys[keys.length - 1];
    if (Object.hasOwn(table, last)) this.fail(); // a key defined twice: the first one stays
    table[last] = value;
  }

  private key(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      let key = '';
      if (c === '"') key = this.basic();
      else if (c === "'") key = this.literal();
      else { while (BARE.test(this.peek())) key += this.s[this.i++]; if (!key) this.fail(); }
      if (key === '__proto__') this.fail();
      keys.push(key);
      this.skipSpaces();
      if (this.peek() !== '.') return keys;
      this.i += 1;
    }
  }

  private value(): TomlValue {
    const c = this.peek();
    if (c === '"') return this.startsWith('"""') ? this.multiBasic() : this.basic();
    if (c === "'") return this.startsWith("'''") ? this.multiLiteral() : this.literal();
    if (c === '[') return this.array();
    if (c === '{') return this.inline();
    if (this.startsWith('true') && !BARE.test(this.peek(4))) { this.i += 4; return true; }
    if (this.startsWith('false') && !BARE.test(this.peek(5))) { this.i += 5; return false; }
    return this.scalar();
  }

  private escape(): string {
    const c = this.s[this.i++] ?? '';
    if (Object.hasOwn(ESCAPES, c)) return ESCAPES[c];
    const size = c === 'u' ? 4 : c === 'U' ? 8 : c === 'x' ? 2 : 0;
    const hex = this.s.slice(this.i, this.i + size);
    if (!size || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== size) this.fail();
    this.i += size;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail();
    return String.fromCodePoint(code);
  }

  private basic(): string {
    this.i += 1;
    let out = '';
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined || c === '\n') this.fail();
      if (c === '"') return out;
      out += c === '\\' ? this.escape() : c;
    }
  }

  private literal(): string {
    const end = this.s.indexOf("'", this.i + 1);
    const text = end < 0 ? '' : this.s.slice(this.i + 1, end);
    if (end < 0 || text.includes('\n')) this.fail();
    this.i = end + 1;
    return text;
  }

  private multiBasic(): string {
    this.i += 3;
    if (this.peek() === '\r') this.i += 1;
    if (this.peek() === '\n') this.i += 1;
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) this.fail();
      if (this.startsWith('"""')) {
        let quotes = 3;
        while (this.peek(quotes) === '"' && quotes < 5) quotes += 1; // up to two quotes may end the text
        out += '"'.repeat(quotes - 3);
        this.i += quotes;
        return out;
      }
      const c = this.s[this.i++];
      if (c !== '\\') { out += c; continue; }
      if (/[ \t\r\n]/.test(this.peek())) { // a line-ending backslash trims the following blanks
        while (/[ \t\r\n]/.test(this.peek())) this.i += 1;
        continue;
      }
      out += this.escape();
    }
  }

  private multiLiteral(): string {
    this.i += 3;
    if (this.peek() === '\r') this.i += 1;
    if (this.peek() === '\n') this.i += 1;
    const end = this.s.indexOf("'''", this.i);
    if (end < 0) this.fail();
    let stop = end;
    while (this.s[stop + 3] === "'" && stop - end < 2) stop += 1;
    const text = this.s.slice(this.i, stop);
    this.i = stop + 3;
    return text;
  }

  private array(): TomlValue[] {
    this.i += 1;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === ']') { this.i += 1; return out; }
      out.push(this.value());
      this.skipBlank();
      if (this.peek() === ',') { this.i += 1; continue; }
      if (this.peek() === ']') { this.i += 1; return out; }
      this.fail();
    }
  }

  private inline(): TomlTable {
    this.i += 1;
    const out: TomlTable = {};
    this.skipBlank();
    if (this.peek() === '}') { this.i += 1; return out; }
    for (;;) {
      this.skipBlank();
      const keys = this.key();
      this.skipSpaces();
      if (this.peek() !== '=') this.fail();
      this.i += 1;
      this.skipSpaces();
      this.assign(out, keys, this.value());
      this.skipBlank();
      if (this.peek() === ',') { this.i += 1; this.skipBlank(); if (this.peek() === '}') { this.i += 1; return out; } continue; }
      if (this.peek() === '}') { this.i += 1; return out; }
      this.fail();
    }
  }

  /** Numbers; dates and times are kept as their text. */
  private scalar(): TomlValue {
    const match = /^[0-9A-Za-z_+.:-]+(?: \d{2}:\d{2}[0-9A-Za-z_+.:-]*)?/.exec(this.s.slice(this.i, this.i + 64));
    if (!match) this.fail();
    const raw = match[0];
    this.i += raw.length;
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw;
    const plain = raw.replace(/_/g, '');
    if (/^[+-]?(0|[1-9]\d*)$/.test(plain)) return Number(plain);
    if (/^0x[0-9A-Fa-f]+$/.test(plain)) return Number.parseInt(plain.slice(2), 16);
    if (/^0o[0-7]+$/.test(plain)) return Number.parseInt(plain.slice(2), 8);
    if (/^0b[01]+$/.test(plain)) return Number.parseInt(plain.slice(2), 2);
    if (/^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(plain)) return Number(plain);
    if (/^[+-]?inf$/.test(plain)) return plain.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(plain)) return Number.NaN;
    this.fail();
  }
}

/** The document as plain objects (unreadable statements skipped). */
export function parseToml(text: string): TomlTable {
  return new Reader(text).document();
}
