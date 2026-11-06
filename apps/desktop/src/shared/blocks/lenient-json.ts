// Lenient JSON reader for model-written ```ui fences (JSON5-ish).
// Owns: turning "almost JSON" into values. Accepts comments, trailing commas, single quotes,
// unquoted keys, smart quotes, raw newlines in strings, Python literals (True/False/None),
// and several top-level values in a row (JSONL / objects separated by commas or blank lines).
// Smart quotes (“ ” „ ″) are delimiters only where a string starts or ends: inside a "…" string
// they are text, so an option like "Buch „Vom Modell zum Produkt“ fertig" keeps its German quotes
// (B-076). Only when that reading fails is every smart quote read as " (mixed quotes like "text”).
// Never: evaluates code, follows references or returns partial values – it either returns
// every top-level value or throws a LenientJsonError with a short, model-readable reason.

export class LenientJsonError extends Error {
  readonly at: number;
  constructor(message: string, at: number) {
    super(message);
    this.name = 'LenientJsonError';
    this.at = at;
  }
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$\-]/;
const MAX_DEPTH = 64;

/** Parses one or more top-level values. Throws LenientJsonError on anything it cannot repair. */
export function parseLenientJson(input: string): unknown[] {
  const text = input.replace(/^﻿/, '');
  try {
    return readAll(text);
  } catch (error) {
    // Mixed quotes ("text” or “text") only read with every smart quote as ": the repair of last resort.
    if (!SMART_QUOTE.test(text)) throw error;
    try { return readAll(text.replace(SMART_QUOTES, '"')); } catch { throw error; }
  }
}

function readAll(text: string): unknown[] {
  const reader = new Reader(text);
  const values: unknown[] = [];
  reader.skip();
  while (!reader.done()) {
    values.push(reader.value(0));
    reader.skip();
    // Separators between top-level values: commas or nothing (JSONL / blank lines).
    while (reader.peek() === ',' || reader.peek() === ';') { reader.pos++; reader.skip(); }
  }
  if (values.length === 0) throw new LenientJsonError('empty block', 0);
  return values;
}

/** Curly “smart” quotes come from chat UIs and some models. */
const SMART_QUOTE = /[“”„″]/;
const SMART_QUOTES = /[“”„″]/g;
/** What closes a string by its opening quote: a smart-quoted one by its usual partner (or "). */
const CLOSERS: Record<string, string> = { '"': '"', "'": "'", '`': '`', '“': '”″"', '„': '“”"', '”': '”″"', '″': '″"' };
const OPENERS = new Set(Object.keys(CLOSERS));

class Reader {
  pos = 0;
  readonly text: string;
  constructor(text: string) { this.text = text; }

  done(): boolean { return this.pos >= this.text.length; }
  peek(): string { return this.text[this.pos] ?? ''; }

  fail(message: string): never {
    throw new LenientJsonError(`${message} at position ${this.pos}`, this.pos);
  }

  /** Skips whitespace and comments (// line, /* block *\/, # line). */
  skip(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ') { this.pos++; continue; }
      if (ch === '/' && this.text[this.pos + 1] === '/') { this.skipLine(); continue; }
      if (ch === '#') { this.skipLine(); continue; }
      if (ch === '/' && this.text[this.pos + 1] === '*') {
        const end = this.text.indexOf('*/', this.pos + 2);
        if (end < 0) this.fail('unclosed comment');
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  skipLine(): void {
    const end = this.text.indexOf('\n', this.pos);
    this.pos = end < 0 ? this.text.length : end + 1;
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail('nesting too deep');
    this.skip();
    const ch = this.peek();
    if (ch === '{') return this.object(depth);
    if (ch === '[') return this.array(depth);
    if (OPENERS.has(ch)) return this.string(ch);
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) return this.number();
    if (IDENT_START.test(ch)) return this.literal();
    if (ch === '') this.fail('unexpected end (block cut off?)');
    return this.fail(`unexpected "${ch}"`);
  }

  object(depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.pos++; // {
    for (;;) {
      this.skip();
      const ch = this.peek();
      if (ch === '}') { this.pos++; return out; }
      if (ch === ',') { this.pos++; continue; } // tolerate stray / trailing commas
      if (ch === '') this.fail('missing "}"');
      const key = this.key();
      this.skip();
      if (this.peek() === ':' || this.peek() === '=') this.pos++;
      else this.fail(`missing ":" after "${key}"`);
      const value = this.value(depth + 1);
      // Guard against prototype pollution through crafted keys.
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') out[key] = value;
      this.skip();
      const next = this.peek();
      if (next === ',' ) { this.pos++; continue; }
      if (next === '}') continue;
      // Missing comma between properties: accept when the next token clearly starts a key.
      if (OPENERS.has(next) || IDENT_START.test(next)) continue;
      if (next === '') this.fail('missing "}"');
      this.fail(`expected "," or "}" but found "${next}"`);
    }
  }

  array(depth: number): unknown[] {
    const out: unknown[] = [];
    this.pos++; // [
    for (;;) {
      this.skip();
      const ch = this.peek();
      if (ch === ']') { this.pos++; return out; }
      if (ch === ',') { this.pos++; continue; }
      if (ch === '') this.fail('missing "]"');
      out.push(this.value(depth + 1));
      this.skip();
      const next = this.peek();
      if (next === ',') { this.pos++; continue; }
      if (next === ']') continue;
      if (next === '{' || next === '[' || OPENERS.has(next)) continue; // missing comma
      if (next === '') this.fail('missing "]"');
      this.fail(`expected "," or "]" but found "${next}"`);
    }
  }

  key(): string {
    const ch = this.peek();
    if (OPENERS.has(ch)) return this.string(ch);
    if (!IDENT_START.test(ch) && !(ch >= '0' && ch <= '9')) this.fail(`unexpected "${ch}" where a key was expected`);
    const start = this.pos;
    while (!this.done() && IDENT_PART.test(this.peek())) this.pos++;
    return this.text.slice(start, this.pos);
  }

  string(quote: string): string {
    this.pos++; // opening quote
    const closers = CLOSERS[quote] ?? quote;
    let out = '';
    for (;;) {
      if (this.done()) this.fail('unclosed string');
      const ch = this.text[this.pos++];
      if (closers.includes(ch)) return out; // other quotes inside are text („…“ in "…")
      if (ch === '\\') {
        const esc = this.text[this.pos++];
        switch (esc) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case '0': out += '\0'; break;
          case 'u': {
            const hex = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('bad \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          case '\r': if (this.peek() === '\n') this.pos++; break; // line continuation
          case '\n': break;
          case undefined: this.fail('unclosed string'); break;
          default: out += esc; // \" \' \\ \/ and unknown escapes keep the character
        }
        continue;
      }
      out += ch; // raw newlines are tolerated (models break long strings)
    }
  }

  number(): number {
    const match = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.pos));
    if (!match) this.fail('bad number');
    this.pos += match[0].length;
    const raw = match[0].replace(/_/g, '');
    const value = /^[+-]?0[xX]/.test(raw) ? parseInt(raw, 16) : Number(raw);
    if (!Number.isFinite(value)) this.fail('bad number');
    return value;
  }

  literal(): unknown {
    const start = this.pos;
    while (!this.done() && IDENT_PART.test(this.peek())) this.pos++;
    const word = this.text.slice(start, this.pos);
    switch (word) {
      case 'true': case 'True': return true;
      case 'false': case 'False': return false;
      case 'null': case 'None': case 'undefined': case 'nil': return null;
      default:
        this.pos = start;
        return this.fail(`unquoted text "${word.slice(0, 20)}"`);
    }
  }
}
