// Shipped modes and skills agree on the browser (PM6 follow-up): a mode that lists the
// browser-accounts skill – and every mode the skill names in metadata.modes – offers browser.act
// through the registry's own rule (device tools need a browser or computer workspace or an
// explicit pattern), so no agent loads sign-in instructions it cannot follow (the secretary
// delegates website work to Browser mode instead). The finance mode lists no pattern that matches
// no tool. Owns: these assertions only. Never: writes resources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMode } from '../../../src/runtime/modes/service.ts';
import { parseFrontMatter } from '../../../src/runtime/skills/frontmatter.ts';
import { Registry, matchesPatterns } from '../../../src/runtime/tools/registry.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const RESOURCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources');
const modes = readdirSync(path.join(RESOURCES, 'modes')).filter((name) => name.endsWith('.md') && !name.startsWith('_'))
  .map((name) => parseMode(name.replace(/\.md$/, ''), readFileSync(path.join(RESOURCES, 'modes', name), 'utf8')));
const agent = { id: 'ag_x', mode: 'general', permissions: {} } as unknown as Agent;
/** browser.act as registered by browser/tools.ts: a remote device tool. */
const browserAct = { name: 'browser.act', description: 'act', category: 'device', remote: true, requires: 'device', inputSchema: { type: 'object' } } as unknown as ToolDef;

test('every mode that lists or is named by browser-accounts offers browser.act', () => {
  const registry = new Registry({ services: () => ({}) as RuntimeServices });
  const offers = (key: string) => registry.allowed(browserAct, agent, modes.find((mode) => mode.key === key)!);
  const listing = modes.filter((mode) => mode.skills.includes('browser-accounts')).map((mode) => mode.key).sort();
  assert.deepEqual(listing.filter((key) => !offers(key)), [], `modes listing browser-accounts: ${listing.join(', ')}`);
  const skill = parseFrontMatter(readFileSync(path.join(RESOURCES, 'skills', 'browser-accounts', 'SKILL.md'), 'utf8')).data as { metadata?: { modes?: string[] } };
  const named = skill.metadata?.modes ?? [];
  assert.ok(named.length > 0);
  assert.deepEqual(named.filter((key) => !offers(key)), [], `metadata.modes of browser-accounts: ${named.join(', ')}`);
  assert.equal(offers('secretary'), false, 'the secretary has no browser tools (she delegates website work)');
});

test('the finance mode lists only tool patterns that match a built-in tool', () => {
  const finance = modes.find((mode) => mode.key === 'finance')!;
  const names = [...builtinTools().map((tool) => tool.name), 'browser.act', 'browser.open'];
  const dead = (finance.tools ?? []).filter((pattern) => !pattern.startsWith('!') && !names.some((name) => matchesPatterns(name, [pattern])));
  assert.deepEqual(dead, []);
});
