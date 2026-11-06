// B-075 (owner 04.11.2026, "the AI acts"): shipped skills
// speak in the reading AI's own voice. Each description says when I read it ("I read this …"), and no description
// addresses the reader as "you" or hands out a rule ("Use when", "must", "may"). Covers every shipped skill.
// Owns: these assertions only. Never: writes resources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontMatter } from '../../../src/runtime/skills/frontmatter.ts';
import { RESOURCES } from '../store/helpers.ts';

const SKILLS = readdirSync(path.join(RESOURCES, 'skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

const read = (name: string) => parseFrontMatter(readFileSync(path.join(RESOURCES, 'skills', name, 'SKILL.md'), 'utf8'));

test('each description says when I read the skill, in my own voice', () => {
  for (const name of SKILLS) {
    const { data } = read(name);
    assert.equal(data.name, name, `${name}: the name stays`);
    const description = String(data.description);
    assert.match(description, /^I read this /, `${name}: starts with "I read this"`);
    assert.doesNotMatch(description, /\b(you|your|yourself|Use when|Use it when|must|may|allowed|never|only if|ask only)\b/i, `${name}: ${description}`);
  }
});

test('the bodies speak as I, not to a "you", outside quoted examples for the person', () => {
  for (const name of SKILLS) {
    const prose = read(name).body
      .replace(/```[\s\S]*?```/g, '') // ui blocks and code: texts for the person or the machine
      .replace(/`[^`]*`/g, '') // paths, placeholders and app strings stay exact
      .replace(/"[^"]*"/g, ''); // quoted lines the person or the app sees
    assert.doesNotMatch(prose, /\b(you|your|yours|yourself)\b/i, name);
    assert.doesNotMatch(prose, /\b(must|allowed|only if|ask only)\b/i, name);
  }
});

test('lines the app and other tests rely on stay in the skills', () => {
  const body = (name: string) => read(name).body;
  assert.match(body('ai-providers'), /accounts\.update '\{"id":"<account>","rotation":true\}'/);
  assert.match(body('browser-accounts'), /`•••• \(2FA setup key – save it with browser\.save_totp\)`/);
  assert.match(body('browser-accounts'), /"The person has taken over my browser"/);
  assert.match(body('computer-use-windows'), /"Stopped by the person"/);
  assert.match(body('import-agent-system'), /part from "## My role" on \(older files: "## Your role"\) is its own/);
  assert.match(body('money'), /`spend\.note` books what was bought/);
  assert.match(body('phone-access'), /tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:47811/);
  assert.match(body('phone-access'), /tailscale serve --https=8443 off/);
  // Owner 04.11. (Nachricht 3): no "ask back only when two candidates remain" rule. Like rules.md, I list, then I do it,
  // and one line names what reaches further than the person likely sees.
  assert.doesNotMatch(body('app-guide'), /two real candidates|goes past the request/);
  assert.match(body('app-guide'), /by listing them, then I do it; when what I find reaches further than the person likely sees/);
});
