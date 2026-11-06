// B-049 F4 (TOOLS-CORE) – core sets and the engine offer, over the real shipped modes and tool groups:
// - every core name of every shipped mode is a real tool with a reason; each mode's direct offer is small and
//   holds the contract's always-list (where the mode allows it) plus tools.find / tools.call;
// - offerFor keeps specsFor's order, adds the execution core for engines without own tools, learned names only
//   where the mode allows them; shell.exec stays reachable for CLI engines (a linked PC's terminal); the manager keeps
//   its org tools directly;
// - the has_* flags and the environment stay truthful: tools reachable through tools.call count, and one line says so;
// - B-050 K10: chat.read and chat.direct are direct in every mode that allows them, together under 600 tokens of spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { deviceTools } from '../../../src/runtime/devices/tools.ts';
import { BASE_CORE, CALL_TOOL, FIND_TOOL, MODE_CORE, coreNames, coreReason } from '../../../src/runtime/tools/core-sets.ts';
import { rankTools } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { toolFlags, toolsLine, environmentSection } from '../../../src/runtime/context/environment.ts';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { agent } from '../chat/harness.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolSpec } from '../../../src/runtime/tools/types.ts';

/** Names a core set may carry before their tool exists (offered once it does). */
const PENDING = new Set(['skills.find']);
const CODEX = { ownTools: true, via: 'native' as const };
const HUB = { ownTools: true, via: 'mcp' as const };
const HTTP = { ownTools: false, via: 'native' as const };
const ALWAYS = ['model.set', 'tasks.create', 'tasks.update', 'tasks.complete', 'chat.send', 'chat.read', 'chat.direct', 'files.read', 'files.search', 'web.search', 'web.fetch', 'skills.load', 'knowledge.find'];

function rig() {
  const stub = new Proxy({}, { get: () => () => undefined }) as never;
  const services = { org: { list: () => [], get: () => undefined }, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as RuntimeServices;
  const registry = new Registry({ services: () => services });
  for (const tool of [...builtinTools(), ...deviceTools({ computer: stub, browser: stub, phone: stub })]) registry.register(tool);
  const modes = new ModeLibrary({ resources: path.resolve('resources'), clock: new ManualClock() });
  const agentIn = (mode: string) => agent(`ag_${mode}`, 'X', { mode });
  return { registry, modes, agentIn, services };
}

const names = (specs: ToolSpec[]) => specs.map((spec) => spec.name);
const chars = (specs: ToolSpec[]) => specs.reduce((sum, spec) => sum + JSON.stringify(spec).length, 0);

test('every core name is a real tool with a reason; each mode offers a small core with the meta tools', () => {
  const { registry, modes, agentIn } = rig();
  const keys = modes.list().map((mode) => mode.key);
  assert.ok(keys.length >= 11, 'the shipped modes');
  for (const key of keys) {
    const mode = modes.get(key);
    for (const name of coreNames(mode, HTTP)) {
      if (!PENDING.has(name)) assert.ok(registry.get(name), `${key}: core tool ${name} exists`);
      assert.ok(coreReason(mode, name), `${key}: ${name} says why it is direct`);
    }
    const all = registry.specsFor(agentIn(key), mode, CODEX);
    const offer = registry.offerFor(agentIn(key), mode, CODEX);
    // 24 before skills.find (F5) joined the base – social had 25 since – and B-050 K10 added chat.read and chat.direct;
    // B-057's agents.split is no core tool (owner 30.10.2026: the agent does not need it all the time – tools.find reaches it).
    assert.ok(offer.length <= 27, `${key}: ${offer.length} direct tools`);
    assert.ok(chars(offer) < chars(all) / 2, `${key}: the direct offer is far smaller than everything the mode allows`);
    assert.ok(names(offer).includes(FIND_TOOL) && names(offer).includes(CALL_TOOL), `${key}: tools.find and tools.call`);
    const allowed = new Set(names(all));
    for (const name of ALWAYS) if (allowed.has(name)) assert.ok(names(offer).includes(name), `${key}: ${name} is always direct`);
    assert.deepEqual(names(offer), names(all).filter((name) => names(offer).includes(name)), `${key}: specsFor order (prompt caching)`);
  }
  for (const name of ALWAYS) assert.ok(Object.hasOwn(BASE_CORE, name), `${name} is in the base`);
});

test('offerFor: the engine decides the execution core and the hub-only tools; learned names join where the mode allows them', () => {
  const { registry, modes, agentIn } = rig();
  const general = modes.get('general');
  const tom = agentIn('general');
  const codex = names(registry.offerFor(tom, general, CODEX));
  const hub = names(registry.offerFor(tom, general, HUB));
  const http = names(registry.offerFor(tom, general, HTTP));
  assert.ok(!codex.includes('files.write') && !codex.includes('shell.exec'), 'Codex brings its own shell and file tools');
  assert.ok(!hub.includes('files.write'), 'the hub engine brings its own tools too');
  assert.ok(http.includes('files.write') && http.includes('shell.exec') && http.includes('files.list'), 'an engine without own tools gets ours');
  // 04.11.2026: a linked PC's terminal for every engine – reachable through tools.find / tools.call, never direct for a CLI engine.
  for (const engine of [CODEX, HUB]) {
    const reachable = registry.specsFor(tom, general, engine);
    assert.ok(names(reachable).includes('shell.exec') && !names(reachable).includes('files.write'), 'shell.exec reachable, files.write stays theirs');
    assert.equal(rankTools(reachable, 'run a command in the terminal of my linked pc', 1)[0]?.name, 'shell.exec', 'tools.find finds it');
  }
  assert.ok(!codex.includes('schedules.remind') && names(registry.specsFor(tom, general, CODEX)).includes('schedules.remind'), 'schedules stay reachable, not direct');

  const learned = names(registry.offerFor(tom, general, CODEX, ['schedules.remind', 'computer.click', 'no.such']));
  assert.ok(learned.includes('schedules.remind'), 'a learned tool joins');
  assert.ok(!learned.includes('computer.click') && !learned.includes('no.such'), 'never one the mode does not allow');

  const writing = names(registry.offerFor(agentIn('writing'), modes.get('writing'), CODEX));
  assert.ok(!writing.includes('ui.help') && !writing.includes('agents.handoff'), 'writing has no general essentials');
});

test('the manager keeps hiring, work groups and its core directly; a custom mode gets its families\' essentials', () => {
  const { registry, modes, agentIn } = rig();
  const manager = names(registry.offerFor(agentIn('manager'), modes.get('manager'), CODEX));
  for (const name of ['agents.create', 'agents.templates', 'agents.update', 'tasks.assign', 'chat.create', 'human.ask', 'ui.help', 'agents.delegate']) assert.ok(manager.includes(name), `manager: ${name}`);
  // B-059 #43: no approval wakes a manager for review since B-053 N1 – approvals.review is reached through tools.find
  assert.ok(!manager.includes('approvals.review'), 'approvals.review is no longer direct');
  assert.ok(!manager.includes('schedules.routine') && !manager.includes('decide'), 'the rest via tools.find');
  const custom = coreNames({ key: 'shop-helper', tools: ['browser.*', 'tasks.*', 'chat.*'] });
  assert.ok(custom.has('browser.act') && custom.has('browser.snapshot') && !custom.has('computer.act'));
  const star = coreNames({ key: 'my-own', tools: ['*'] });
  assert.ok(star.has('agents.handoff') && star.has('ui.help'), 'a "*" custom mode gets general\'s essentials');
  assert.equal(Object.keys(MODE_CORE).length, 11);
});

test('has_* flags count tools reachable through tools.call; the environment says so in one line', () => {
  const { registry, modes, agentIn, services } = rig();
  Object.assign(services, { tools: registry, paths: { workspace: 'C:/ws' }, permissions: { settings: () => ({ quarantine: 'never' }) } });
  const tom = agentIn('general');
  const general = modes.get('general');
  const offered = new Set(names(registry.specsFor(tom, general)));
  const flags = toolFlags(offered);
  assert.equal(flags.has_schedules, 'yes', 'schedules.* is reachable (not direct)');
  assert.equal(flags.has_todos, 'yes');
  assert.equal(flags.has_decide, 'yes');
  assert.ok(!names(registry.offerFor(tom, general, CODEX)).includes('decide'), 'decide runs through tools.call');
  const line = toolsLine(offered);
  assert.match(line, /^Tools: .*tools\.find .*tools\.call/);
  assert.equal(toolsLine(new Set(['chat.send'])), '', 'no line without tools.find');
  const section = environmentSection(services, { agent: tom, mode: general, route: { engine: 'codex' } as never }, offered, { platform: 'linux', version: '', release: '6.8', hostname: 'pc' });
  assert.equal(section.split('\n').filter((entry) => entry.startsWith('Tools:')).length, 1, 'one fact line');
  assert.ok(!/\d+ tools/.test(section), 'no counts in the stable part');
});

test('B-050 K10: chat.read and chat.direct join the base core for less than 600 tokens of spec (chars / 4)', () => {
  const { registry } = rig();
  const specs = ['chat.read', 'chat.direct'].map((name) => registry.get(name)!).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  for (const name of ['chat.read', 'chat.direct']) assert.ok(Object.hasOwn(BASE_CORE, name), name);
  assert.ok(chars(specs) / 4 < 600, `${chars(specs)} characters`);
});
