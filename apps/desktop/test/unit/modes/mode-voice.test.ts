// B-075 (owner 04.11.2026, "the AI acts"): the shipped
// mode prompts become the "## Mode" section of the system prompt, so they speak in the agent's own voice – "I", not
// "you", and no rule wording. Covers every shipped mode.
// Owns: these assertions only. Never: writes resources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseMode } from '../../../src/runtime/modes/service.ts';
import { RESOURCES } from '../store/helpers.ts';

const DIR = path.join(RESOURCES, 'modes');
const modes = readdirSync(DIR).filter((name) => name.endsWith('.md') && !name.startsWith('_'))
  .map((name) => parseMode(name.replace(/\.md$/, ''), readFileSync(path.join(DIR, name), 'utf8')));

test('the mode prompts speak as I, not to a "you", outside quoted lines and code', () => {
  assert.ok(modes.length >= 11);
  for (const mode of modes) {
    const prose = mode.instructions
      .replace(/`[^`]*`/g, '') // tool names, paths, placeholders and app strings stay exact
      .replace(/"[^"]*"/g, ''); // quoted lines the person, a page or the app sees
    assert.match(prose, /\bI\b/, mode.key);
    assert.doesNotMatch(prose, /\b(you|your|yours|yourself)\b/i, mode.key);
    assert.doesNotMatch(prose, /\b(must|may|allowed|only if|only when|ask only)\b/i, mode.key);
  }
});
