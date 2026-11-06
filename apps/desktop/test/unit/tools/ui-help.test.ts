// F08 – ui.help, the rich-answer guide on demand: registered with the builtins as a plain read tool
// for every engine (MCP hub and function tools, wire name ui__help); a call through the real
// registry and permission service runs without an approval in Standard and returns blockHelp's
// text (the mini-app guide, a block's props and example, the topic list for an unknown topic);
// invalid topics are refused by the schema; the stable prompt names ui__help exactly when the
// agent's mode offers the tool (blockOptions).
// Owns: these assertions only. Never: real engines, network or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from './helpers.ts';
import { fixture, route, VIDEO_MODE } from '../context/fixture.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { builtinTools, registerBuiltinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { UI_HELP_TOOL, uiTools } from '../../../src/runtime/tools/builtin/ui.ts';
import { blockOptions } from '../../../src/runtime/context/prompt-stable.ts';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { toWireName } from '../../../src/runtime/engines/shared.ts';
import { mcpWireName } from '../../../src/runtime/mcp/names.ts';
import { blockHelp } from '../../../src/shared/blocks/prompt.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';

const textOf = (out: ToolOutput) => out.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
const modes = new ModeLibrary({ resources: path.resolve('resources'), clock: new ManualClock() });

function rig() {
  const h = setup(); // Standard mode, nothing granted
  const services = h.services as RuntimeServices;
  services.modes = modes as unknown as RuntimeServices['modes'];
  const registry = new Registry({ services: () => services });
  registerBuiltinTools(registry);
  services.tools = registry;
  const ctx: Omit<ToolContext, 'services'> = { agent: h.tom, runId: 'run_ui', conversationId: h.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {} };
  return { ...h, registry, ctx };
}

test('ui.help is a builtin read tool offered to every engine as ui__help', () => {
  assert.equal(builtinTools().filter((tool) => tool.name === UI_HELP_TOOL).length, 1);
  const [help] = uiTools;
  assert.equal(help.name, 'ui.help');
  assert.equal(help.category, 'read');
  assert.equal(help.audience, undefined);
  assert.equal(help.requires, undefined);
  assert.equal(help.remote, undefined);
  assert.equal(toWireName(UI_HELP_TOOL), 'ui__help');
  assert.equal(mcpWireName(UI_HELP_TOOL), 'ui__help');
  const { registry, tom } = rig();
  const general = modes.get('general');
  for (const engine of [undefined, { ownTools: false, via: 'native' as const }, { ownTools: true, via: 'mcp' as const }, { ownTools: true, via: 'native' as const }]) {
    assert.ok(registry.specsFor(tom, general, engine).some((spec) => spec.name === UI_HELP_TOOL), `offered to ${JSON.stringify(engine)}`);
  }
});

test('a call through the registry needs no approval and returns the guide', async () => {
  const { registry, ctx, runItems } = rig();
  const app = await registry.call('ui.help', { topic: 'app' }, ctx, 'call_1');
  assert.equal(app.isError, undefined);
  assert.equal(textOf(app), blockHelp('app'));
  assert.match(textOf(app), /--wf-accent/);
  assert.match(textOf(app), /wf\.state\.set/);
  const chart = textOf(await registry.call('ui.help', { topic: 'chart' }, ctx, 'call_2'));
  assert.match(chart, /^## chart \(display\)/);
  assert.match(chart, /- x: string/);
  assert.match(chart, /Example:\n```ui\n\{"type":"chart"/);
  const unknown = await registry.call('ui.help', { topic: 'slideshow' }, ctx, 'call_3');
  assert.equal(unknown.isError, undefined);
  assert.match(textOf(unknown), /^Unknown topic "slideshow"\. Topics: blocks, app, mermaid, callout, .*record/);
  assert.equal(runItems.filter((item) => item.kind === 'approval').length, 0, 'never waits for an approval');
});

test('invalid ui.help arguments are refused before running', async () => {
  const { registry, ctx } = rig();
  for (const args of [{}, { topic: '' }, { topic: 'x'.repeat(41) }, { topic: 'app', extra: 1 }, { topic: 7 }]) {
    const out = await registry.call('ui.help', args, ctx, `call_${JSON.stringify(args)}`);
    assert.equal(out.isError, true, JSON.stringify(args));
    assert.match(textOf(out), /^Invalid arguments for ui\.help/);
  }
});

test('the stable prompt names ui__help only when the mode offers it', () => {
  const { registry, tom } = rig();
  const services = { catalog: { get: () => ({ tier: 'frontier' }) }, tools: registry } as unknown as RuntimeServices;
  const general = blockOptions(services, { agent: tom, mode: modes.get('general'), route: route() });
  assert.deepEqual(general, { tier: 'full', app: true, helpTool: 'ui__help' });
  // A specialist mode whose tool patterns leave ui.* out does not offer it, so the prompt keeps quiet.
  const masked: ModeInfo = { ...modes.get('general'), key: 'narrow', tools: ['tasks.*', 'chat.*'] };
  assert.deepEqual(blockOptions(services, { agent: tom, mode: masked, route: route() }), { tier: 'full', app: true });
  // Without a registry (or one that throws) there is no help line either.
  assert.equal(blockOptions({ catalog: services.catalog, tools: { get: () => undefined } } as unknown as RuntimeServices, { agent: tom, mode: masked, route: route() }).helpTool, undefined);

  const f = fixture();
  const fixtureRegistry = new Registry({ services: () => f.services });
  registerBuiltinTools(fixtureRegistry);
  f.services.tools = fixtureRegistry;
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  const prompt = (mode: ModeInfo) => f.context.prompt({ agent: f.vid, conversationId: chat.id, mode, route: route() }).stable;
  assert.ok(prompt(VIDEO_MODE).includes('ui__help "blocks" lists every type with its fields'), 'B-049 F5: the one rich-answer line names the help tool');
  assert.equal(prompt(VIDEO_MODE), prompt(VIDEO_MODE), 'deterministic');
  assert.ok(!prompt({ ...VIDEO_MODE, tools: ['tasks.*', 'files.*'] }).includes('ui__help'));
});
