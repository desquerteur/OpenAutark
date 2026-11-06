// Visual pass settings-2, rounds 3–4: one punctuation rule for every settings hint – row hints, group hints, dialog
// intros, the muted note in a dialog's footer, empty states and status lines: a hint of one sentence has no final
// period ("Every agent may read it; the files stay where they are"), a hint of two or more sentences ends every
// sentence with one ("Answer them there. Approvals given there count as yours."). Confirmation dialogs, toasts and
// error messages are messages, not hints, and keep their sentences.
// Checked over the source text of every settings page (src/ui/settings): hint="…" / intro="…" attributes, hint: '…'
// fields, *_HINT / *_NOTE / NO_* constants, the text of the hint-like elements (.set-row-hint, .dialog-text,
// .set-note, .memory-history) and the plain string returns of the *Hint / *Line / *Summary text functions.
// Owns: this static check of the source text. Never: renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/settings');
const FILES = readdirSync(DIR).filter((name) => /\.tsx?$/.test(name)).sort();
const QUOTED = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"`;
const PATTERNS: RegExp[] = [
  /\b(?:hint|intro)="([^"]+)"/g,
  /\b(?:hint|intro)=\{'([^']+)'\}/g,
  /\bhint:\s*'([^']+)'/g,
  new RegExp(String.raw`\b(?:[A-Z_]+_(?:HINT|NOTE)|NO_[A-Z_]+)\s*=\s*(?:${QUOTED})`, 'g'),
  /class="[^"]*\b(?:set-row-hint|set-group-hint|dialog-text|set-note|memory-history)\b[^"]*">([^<{]+)</g,
];

/** Text functions named like hints whose words are a message (providers.ts signInHint: the toast once a sign-in started). */
const MESSAGES = new Set(['signInHint']);

/** The sentences of a hint: a sentence ends with . ! or ? before a space and a capital letter. */
function sentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?])\s+(?=[A-Z“"])/).filter(Boolean);
}

/** Why a hint breaks the rule, or '' when it keeps it. */
function punctuationError(text: string): string {
  const parts = sentences(text);
  if (parts.length === 1) return /\.$/.test(parts[0]) && !/\.\.\.$|…$/.test(parts[0]) ? 'one sentence: no final period' : '';
  return /[.!?]$/.test(text.trim()) ? '' : 'several sentences: every one ends with a period';
}

/** The source without its comments (a whole comment line, a block comment, a trailing "// …"); strings keep their "://". */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !/^\s*\/\//.test(line)).map((line) => line.replace(/\s\/\/\s.*$/, '')).join('\n');
}

/** Every hint text of one source file. */
function hints(source: string): string[] {
  const body = code(source);
  const found: string[] = [];
  for (const pattern of PATTERNS) {
    for (const match of body.matchAll(pattern)) found.push((match.slice(1).find((part) => part !== undefined) ?? '').replace(/\\'/g, "'"));
  }
  for (const fn of body.matchAll(/function (\w+(?:Hint|Line|Summary))\b[^{]*\{([\s\S]*?)\n\}/g)) {
    if (MESSAGES.has(fn[1])) continue;
    for (const match of fn[2].matchAll(/'([A-Z][^'\n]*)'/g)) found.push(match[1]);
  }
  return found.map((text) => text.trim()).filter((text) => /[a-z]/.test(text));
}

test('the rule itself', () => {
  assert.equal(punctuationError('Every agent may read it; the files stay where they are'), '');
  assert.equal(punctuationError('Every agent may read it; the files stay where they are.'), 'one sentence: no final period');
  assert.equal(punctuationError('Answer them there. Approvals given there count as yours.'), '');
  assert.equal(punctuationError('Answer them there. Approvals given there count as yours'), 'several sentences: every one ends with a period');
  assert.equal(punctuationError('Loading…'), '');
});

test('the scan finds every kind of hint', () => {
  const sample = [
    '<Row label="A" hint="Row hint." />',
    "export const X_HINT = 'Constant hint.';",
    'export const NO_THING = "It\'s a status line.";',
    '<p class="dialog-text">Dialog intro.</p>',
    "export function demoHint(v) {\n  if (v) return 'Returned hint.';\n  return 'Fine';\n}",
    "// hint=\"In a comment.\"",
  ].join('\n');
  assert.deepEqual(hints(sample), ['Row hint.', 'Constant hint.', "It's a status line.", 'Dialog intro.', 'Returned hint.', 'Fine']);
});

test('settings hints: one sentence without a final period, several sentences with one each', () => {
  assert.ok(FILES.length > 10, `found ${FILES.join(', ')}`); // the one Settings page and its parts
  const wrong: string[] = [];
  for (const file of FILES) {
    for (const text of hints(readFileSync(path.join(DIR, file), 'utf8'))) {
      const why = punctuationError(text);
      if (why) wrong.push(`${file}: "${text}" – ${why}`);
    }
  }
  assert.deepEqual(wrong, []);
});
