// Minimal YAML front matter parser for SKILL.md (agentskills.io) and mode/agent template files.
// Owns: splitting `---` front matter from the Markdown body and parsing the small YAML subset
// these files use: `key: value`, quoted strings, inline lists `[a, b]`, block lists (`- a`),
// block scalars (`|` / `>`), numbers, booleans and nested maps (`metadata:` → object); double
// quoted values decode JSON escapes (what skills/skill-file.ts writes), and a one-line JSON object or
// list reads as itself (what knowledge/memory-tree.ts writes for a key it does not know).
// Never: executes anything or pulls in a YAML dependency.

export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontMatter(text: string): FrontMatter {
  const source = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!match) return { data: {}, body: source.trim() };
  return { data: parseYamlSubset(match[1]), body: source.slice(match[0].length).trim() };
}

function scalar(raw: string): unknown {
  const value = raw.trim();
  if (value === '') return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    if (value.startsWith("'")) return inner.replace(/''/g, "'");
    // JSON escapes first (skills are written with JSON.stringify, MM8: a description with a
    // backslash or quote round-trips through an agent file); other YAML text stays lenient.
    try { return JSON.parse(value) as string; } catch { return inner.replace(/\\"/g, '"').replace(/\\n/g, '\n'); }
  }
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value) as unknown; } catch { /* YAML's own inline list, or text */ }
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : splitInline(inner).map(part => scalar(part));
  }
  if (value === 'true' || value === 'false') return value === 'true';
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/\s+#.*$/, ''); // trailing comment
}

/** Splits `a, "b, c", d` on top-level commas. */
function splitInline(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote = '';
  for (const char of inner) {
    if (quote) { current += char; if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === ',') { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(part => part !== '');
}

export function parseYamlSubset(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  const data: Record<string, unknown> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const keyMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!keyMatch) continue;
    const [, key, rest] = keyMatch;
    // Collect the indented continuation block (lists, block scalars, nested maps).
    const block: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t') || lines[i + 1].trim() === '')) {
      block.push(lines[++i]);
    }
    while (block.length && block[block.length - 1].trim() === '') block.pop();
    const head = rest.trim();
    if (head === '|' || head === '>' || head === '|-' || head === '>-') {
      const indent = Math.min(...block.filter(row => row.trim()).map(row => row.length - row.trimStart().length));
      const rows = block.map(row => row.slice(Number.isFinite(indent) ? indent : 0));
      data[key] = head.startsWith('|') ? rows.join('\n').trim() : rows.join(' ').replace(/\s+/g, ' ').trim();
    } else if (head === '' && block.length && block.every(row => !row.trim() || row.trim().startsWith('- '))) {
      data[key] = block.filter(row => row.trim()).map(row => scalar(row.trim().slice(2)));
    } else if (head === '' && block.length) {
      // Nested map (e.g. `metadata:\n  modes: [video]`): dedent and parse recursively.
      const indent = Math.min(...block.filter(row => row.trim()).map(row => row.length - row.trimStart().length));
      data[key] = parseYamlSubset(block.map(row => row.slice(indent)).join('\n'));
    } else {
      // Plain multi-line scalar: continuation lines fold into one string.
      const extra = block.map(row => row.trim()).filter(Boolean);
      data[key] = extra.length && typeof scalar(head) === 'string' ? `${scalar(head)} ${extra.join(' ')}`.trim() : scalar(head);
    }
  }
  return data;
}

/** Reads a string list field ("a, b" strings are split too). */
export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined).map(String).map(item => item.trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map(item => item.trim()).filter(Boolean);
  return [];
}
