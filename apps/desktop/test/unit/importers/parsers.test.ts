// The small text helpers the team patterns still use (runtime/importers/yaml-lite.ts, scrub.ts, modes.ts):
// the YAML subset, the secret scrub and the mode guesses. The importers themselves are gone – the AI
// reads an existing agent system (skill import-agent-system) and hires with agents.create.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, frontMatter } from '../../../src/runtime/importers/yaml-lite.ts';
import { scrubSecrets } from '../../../src/runtime/importers/scrub.ts';
import { guessMode, importedMode } from '../../../src/runtime/importers/modes.ts';

test('the YAML subset reads nested maps, block scalars, flow and block lists and comments', () => {
  const { value, skipped } = parseYaml('a: 1 # note\nb: >\n  folded\n  text\nc: |\n  line 1\n  line 2\nd: [x, "y, z"]\ne:\n  - one\n  - two\nf:\n  g: "q\\"uote"\n');
  assert.equal(skipped, 0);
  assert.deepEqual(value, { a: '1', b: 'folded text', c: 'line 1\nline 2', d: ['x', 'y, z'], e: ['one', 'two'], f: { g: 'q"uote' } });
  assert.equal(frontMatter('no front matter'), undefined);
  assert.equal(frontMatter('---\nname: x\n---\nbody')?.body, 'body');
});

test('scrubSecrets keeps placeholders and counts removals', () => {
  assert.deepEqual(scrubSecrets('api_key: {API_KEY} and token=<token>'), { text: 'api_key: {API_KEY} and token=<token>', count: 0 });
  const out = scrubSecrets('Authorization: Bearer abcdefghijklmnop123 and AKIAABCDEFGHIJKLMNOP');
  assert.equal(out.count, 2);
  assert.ok(!out.text.includes('AKIAABCDEFGHIJKLMNOP'));
});

test('scrubSecrets leaves prose after "secret:" or "password:" alone but removes credential-like values', () => {
  const prose = 'Use the secret: rule of thumb. The password: at least 8 characters. token: $GITHUB_TOKEN, apikey=${API_KEY}, Secret: Required.';
  assert.deepEqual(scrubSecrets(prose), { text: prose, count: 0 });
  const out = scrubSecrets('password: hunter2 and token="my phrase" and secret: Tr0ub4dor&3 and token=abcdefghijklmnopqrstu');
  assert.equal(out.count, 4);
  assert.equal(out.text, 'password: [removed secret] and token=[removed secret] and secret: [removed secret] and token=[removed secret]');
});

test('importedMode never preselects a power mode from an imported source', () => {
  const tiers = new Map<string, string | undefined>([['general', undefined], ['manager', undefined], ['harness', 'frontier'], ['studio', 'frontier'], ['video', 'strong']]);
  const dropped: string[] = [];
  assert.equal(importedMode('Boss', 'manager', tiers, dropped), 'general');
  assert.equal(importedMode('Builder', 'studio', tiers, dropped), 'general');
  assert.equal(importedMode('Vic', 'video', tiers, dropped), 'video');
  assert.equal(dropped.length, 2);
  assert.match(dropped[0], /Boss: mode "manager" is not preselected from an imported source/);
});

test('guessMode takes a named mode, then role words, never manager by guess', () => {
  const modes = new Set(['general', 'manager', 'research', 'writing', 'video', 'web']);
  assert.equal(guessMode('research lead', modes), 'research');
  assert.equal(guessMode('Senior data researcher', modes), 'research');
  assert.equal(guessMode('Video producer', modes), 'video');
  assert.equal(guessMode('Team lead and coordinator', modes), 'general');
  assert.equal(guessMode('Frontend engineer', modes), 'web');
});
