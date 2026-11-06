// A small CSS walk for the stylesheet lint (stable-states.test.ts): the style rules of a stylesheet with their
// declarations and lines – comments skipped, strings kept, nested rules flattened with their
// parent's selector, @media/@supports/@layer/@container/@scope looked into, @keyframes, @font-face,
// @function and other blocks skipped – plus splitting selector lists and complex selectors and
// resolving CSS escapes (`\64 isplay`, `n\one`) the way the browser reads them.
// Owns: parsing for checks. Never: validates, throws, or touches the DOM or files.

export interface CssDeclaration { property: string; value: string; line: number }
export interface CssStyleRule { selector: string; line: number; declarations: CssDeclaration[] }

/** Resolves CSS escapes: `\64 ` and `\000064` are "d", `\o` is "o" (as the browser reads names and values). */
export function unescapeCss(text: string): string {
  return text
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_all, hex: string) => { try { return String.fromCodePoint(Number.parseInt(hex, 16)); } catch { return ''; } })
    .replace(/\\(.)/g, '$1');
}

/** At-rules whose blocks hold style rules; every other block (@keyframes, @font-face …) is skipped. */
const GROUPING = new Set(['media', 'supports', 'layer', 'container', 'scope', 'document', '-moz-document', 'starting-style']);

/** Splits at top-level commas (outside (), [] and strings). */
export function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** Nested CSS: `&` stands for the parent; without `&` the child is a descendant of it. */
function nest(parent: string, child: string): string {
  return splitList(child).map((part) => (part.includes('&') ? part.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${part}`)).join(', ');
}

/**
 * The style rules of a stylesheet with their declarations (comments skipped, strings kept, nested
 * rules flattened with their parent's selector). Never throws; unbalanced input ends the walk.
 */
export function styleRules(css: string): CssStyleRule[] {
  const rules: CssStyleRule[] = [];
  const stack: Array<CssStyleRule | 'group' | 'skip'> = [];
  let buffer = '';
  let bufferLine = 1;
  let started = false; // the buffer holds more than whitespace
  let line = 1;
  const top = () => stack[stack.length - 1];
  const parentRule = (): CssStyleRule | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) { const entry = stack[i]; if (typeof entry === 'object') return entry; }
    return undefined;
  };
  const flush = () => {
    // Declarations directly in a nested @media/@supports belong to the rule around it.
    const rule = top() === 'group' ? parentRule() : top();
    const text = buffer.trim();
    buffer = '';
    started = false;
    if (typeof rule !== 'object' || !text) return;
    const colon = text.indexOf(':');
    if (colon > 0) rule.declarations.push({ property: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim(), line: bufferLine });
  };
  const append = (text: string) => { if (!started && text.trim()) { bufferLine = line; started = true; } buffer += text; };
  for (let i = 0; i < css.length; i++) {
    const char = css[i];
    if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      for (let k = i; k < stop; k++) if (css.charCodeAt(k) === 10) line++;
      buffer += ' ';
      i = stop - 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== char && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      append(css.slice(i, Math.min(j + 1, css.length)));
      if (css[j] === '\n') line++;
      i = j;
      continue;
    }
    if (char === '{') {
      const prelude = buffer.trim();
      const preludeLine = bufferLine;
      buffer = '';
      started = false;
      if (top() === 'skip') { stack.push('skip'); continue; }
      if (prelude.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
        stack.push(GROUPING.has(name) ? 'group' : 'skip');
        continue;
      }
      const parent = parentRule();
      const rule: CssStyleRule = { selector: parent ? nest(parent.selector, prelude) : prelude, line: preludeLine, declarations: [] };
      rules.push(rule);
      stack.push(rule);
      continue;
    }
    if (char === ';') { flush(); continue; }
    if (char === '}') { flush(); if (!stack.length) break; stack.pop(); continue; }
    if (char === '\n') line++;
    append(char);
  }
  return rules;
}

/** Splits a complex selector into its compounds (at descendant, >, + and ~ outside () and []). */
export function compounds(complex: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < complex.length; i++) {
    const char = complex[i];
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && (/\s/.test(char) || char === '>' || char === '+' || char === '~')) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
