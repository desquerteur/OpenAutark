// Mode strategy (23.10.2026, modes/strategy.ts + agents.handoff / agents.delegate / modes.list): the
// agent chooses its mode. A switch (handoff to a mode key) is refused only into the mode the run already works in –
// no cap on switches; a colleague who works in the target mode is named as advice; modes.list marks the current mode
// and names such colleagues; the tool descriptions carry the rule; general has no specialists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { MODE_MOVES, checkModeSwitch, specialistsFor } from '../../../src/runtime/modes/strategy.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { modeTools } from '../../../src/runtime/tools/builtin/modes.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { agent } from '../chat/harness.ts';
import { ownershipFixture } from '../tasks/ownership-fixture.ts';

const MODES = [{ key: 'general', name: 'General', description: 'Everyday' }, { key: 'video', name: 'Video', description: 'Cut' }, { key: 'computer', name: 'Computer', description: 'Click' }];

function fixture() {
  const f = ownershipFixture();
  f.org.add(agent('ag_vid', 'Vid', { mode: 'video', managerId: 'ag_mara' }));
  f.org.add(agent('ag_old', 'Old', { mode: 'video', archivedAt: 5 }));
  f.org.add(agent('ag_rest', 'Rest', { mode: 'video', status: 'paused' }));
  (f.services as { modes: unknown }).modes = { list: () => MODES, get: (key: string) => MODES.find((mode) => mode.key === key) };
  const ctx = (mode = 'general', taskId: string | undefined = f.task.id): ToolContext => ({
    agent: f.org.get('ag_tom')!, runId: 'run_modes', conversationId: f.chat.id, taskId, mode,
    services: f.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  });
  return { ...f, ctx };
}

const tool = (list: ToolDef[], name: string) => list.find((entry) => entry.name === name)!;
const text = (result: unknown) => JSON.stringify(result);

test('specialists: active agents whose own mode it is, never the caller, none for general', () => {
  const f = fixture();
  assert.deepEqual(specialistsFor(f.services, 'video', 'ag_tom'), [{ id: 'ag_vid', name: 'Vid' }], 'archived and paused agents are not offered');
  assert.deepEqual(specialistsFor(f.services, 'video', 'ag_vid'), []);
  assert.deepEqual(specialistsFor(f.services, 'general'), []);
});

test('checkModeSwitch: not into the current mode; a colleague is advice, not a refusal', () => {
  const f = fixture();
  assert.match(checkModeSwitch(f.services, { agentId: 'ag_tom', mode: 'video', taskId: f.task.id, to: 'video' }).refuse ?? '', /already work in video mode/);
  const check = checkModeSwitch(f.services, { agentId: 'ag_tom', mode: 'general', taskId: f.task.id, to: 'video' });
  assert.equal(check.refuse, undefined);
  assert.match(check.advice ?? '', /^Vid \(ag_vid\) works in video mode\. For a part that stands on its own, agents\.delegate/);
  assert.deepEqual(checkModeSwitch(f.services, { agentId: 'ag_tom', mode: 'general', taskId: f.task.id, to: 'computer' }), {});
});

test('agents.handoff to a mode: switches with advice; the same mode is refused; there is no cap on switches', async () => {
  const f = fixture();
  const handoff = tool(agentTools, 'agents.handoff');
  const first = await handoff.run({ to: 'video', next: 'Cut the intro' }, f.ctx('general'));
  assert.match(text(first), /"mode":"video"/);
  assert.match(text(first), /advice/);
  assert.equal(f.current().mode, 'video');
  const same = await handoff.run({ to: 'video' }, f.ctx('video'));
  assert.match(text(same), /already work in video mode.*Nothing was changed/);
  const modes = ['computer', 'video', 'computer', 'video'];
  for (const [index, to] of modes.entries()) await handoff.run({ to }, f.ctx(index % 2 === 0 ? 'video' : 'computer'));
  assert.equal(f.current().mode, 'video', 'a fifth switch works like the first');
  const toAgent = await handoff.run({ to: 'ag_vid' }, f.ctx('video'));
  assert.match(text(toAgent), /"to":"ag_vid"/, 'a handoff to an agent is not a mode switch');
});

test('modes.list marks the current mode and names the colleagues of each mode', async () => {
  const f = fixture();
  const list = JSON.parse(String(((await tool(modeTools, 'modes.list').run({}, f.ctx('computer'))) as { content: Array<{ text: string }> }).content[0].text)) as Array<{ key: string; current?: boolean; specialists?: unknown }>;
  assert.deepEqual(list.map((mode) => [mode.key, mode.current ?? false]), [['general', false], ['video', false], ['computer', true]]);
  assert.deepEqual(list.find((mode) => mode.key === 'video')?.specialists, [{ id: 'ag_vid', name: 'Vid' }]);
  assert.equal(list.find((mode) => mode.key === 'general')?.specialists, undefined);
});

test('the rule is in both tool descriptions; the stable rules leave mode moves to them', () => {
  for (const name of ['agents.handoff', 'agents.delegate']) assert.ok(tool(agentTools, name).description.endsWith(MODE_MOVES), name);
  const shipped = readFileSync(path.resolve(import.meta.dirname, '../../../resources/prompts/rules.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(shipped, /## Modes|agents\.handoff|agents\.delegate/, 'the procedure lives in the tool descriptions only');
});
