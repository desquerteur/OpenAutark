// B-049 F4 (TOOLS-CORE) – tools.call and tools.find through the real registry pipeline (validation, run journal):
// - tools.call runs its target under the target's name and the call's id: the same validation message, journal items
//   and result as a direct call; a resend of that id gets the same result without a second run;
// - it runs only what the agent may use in this mode on its engine (audience by the run's live engine), never itself;
// - a non-core target is noted for this agent and chat and joins the offer only at promotion (never mid-session);
// - tools.find ranks by name, keywords and description, shows a full schema for an exact name, marks direct tools
//   and lists the families when nothing fits; name normalisation accepts wire and hub names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup, tool } from './helpers.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { metaTools, callTarget, calledTool, normalizeName, compactArgs, purpose } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { MAX_LEARNED, learnedTools, noteLearned, promoteLearned } from '../../../src/runtime/tools/learned.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

/** A call that hangs must fail the test, never hang the run (B-050 log). */
const BOUNDED = { timeout: 10_000 };
const textOf = (output: ToolOutput) => output.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

function rig(engine?: { ownTools: boolean; dynamicTools: boolean }) {
  const h = setup();
  const services = h.services as RuntimeServices;
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  services.runs = runs as unknown as RuntimeServices['runs'];
  services.modes = new ModeLibrary({ resources: path.resolve('resources'), clock: h.clock }) as unknown as RuntimeServices['modes'];
  services.dispatcher = { activity: () => (engine ? [{ agentId: 'ag_tom', runId: 'run_1', note: '', startedAt: 0, engine: 'eng' }] : []) } as unknown as RuntimeServices['dispatcher'];
  services.engines = { get: () => ({ caps: { ...engine } }) } as unknown as RuntimeServices['engines'];
  const registry = new Registry({ services: () => services });
  services.tools = registry;
  let jots = 0;
  for (const entry of metaTools) registry.register(entry);
  registry.register(tool('notes.jot', 'write_local', {
    description: 'Write a short jot into your notebook. Keeps it for later.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, pinned: { type: 'boolean' } }, required: ['text'], additionalProperties: false },
    describe: (args) => ({ summary: `Jot ${String((args as { text: string }).text)}`, reversible: true, external: false }),
    run: async (args) => { jots++; return { content: [{ type: 'text', text: `jotted ${String((args as { text: string }).text)} #${jots}` }] }; },
  }));
  registry.register(tool('schedules.remind', 'think', {
    description: 'Private reminder: at that time you get a turn with your own note (no chat post).',
    inputSchema: { type: 'object', properties: { at: { type: 'string' }, note: { type: 'string' }, repeat: { type: 'string', enum: ['daily', 'weekly'] } }, required: ['at', 'note'] },
  }));
  // 'think' like the real chat.send (tools/builtin/chat.ts).
  registry.register(tool('chat.send', 'think', { description: 'Post a message into a chat you are a member of.' }));
  registry.register(tool('computer.click', 'device', { description: 'Click at a point on the screen.', requires: 'device' }));
  registry.register(tool('files.write', 'write_local', { description: 'Create or overwrite a text file.', audience: 'http' }));
  runs.start({ id: 'run_1', agentId: 'ag_tom', conversationId: h.chat.id, trigger: 'message' });
  const base: Omit<ToolContext, 'services'> = { agent: h.org.require('ag_tom'), runId: 'run_1', conversationId: h.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {} };
  const items = () => runs.items('run_1').filter((item) => item.kind === 'tool_call' || item.kind === 'tool_result').map((item) => [item.kind, item.name, (item.data as { callId?: string }).callId]);
  return { h, services, registry, base, items, jots: () => jots };
}

test('tools.call runs its target as a direct call would: real name, same validation, same journal, one run per call id', BOUNDED, async () => {
  const { registry, base, items, jots } = rig();
  const direct = await registry.call('notes.jot', { text: 'a' }, base, 'c1');
  const via = await registry.call('tools.call', { name: 'notes.jot', args: { text: 'b' } }, base, 'c2');
  assert.equal(textOf(direct), 'jotted a #1');
  assert.equal(textOf(via), 'jotted b #2');
  assert.deepEqual(items(), [['tool_call', 'notes.jot', 'c1'], ['tool_result', 'notes.jot', 'c1'], ['tool_call', 'notes.jot', 'c2'], ['tool_result', 'notes.jot', 'c2']], 'journaled under the real name, no tools.call step');

  const wrongDirect = await registry.call('notes.jot', { text: '' }, base, 'c3');
  const wrongVia = await registry.call('tools.call', { name: 'notes.jot', args: { text: '' } }, base, 'c4');
  assert.equal(textOf(wrongVia), textOf(wrongDirect), 'identical validation');
  assert.match(textOf(wrongVia), /^Invalid arguments for notes\.jot/);

  const again = await registry.call('tools.call', { name: 'notes.jot', args: { text: 'b' } }, base, 'c2');
  assert.equal(textOf(again), 'jotted b #2', 'a resend of the call id gets its result');
  assert.equal(jots(), 2, 'and runs nothing twice');
});

test('tools.call runs only what this agent may use here, never itself; the engine decides audience tools', BOUNDED, async () => {
  const { registry, base } = rig();
  assert.match(textOf(await registry.call('tools.call', { name: 'computer.click', args: {} }, base, 'r1')), /not available to me in mode "general".*tools\.find/);
  assert.match(textOf(await registry.call('tools.call', { name: 'no.such', args: {} }, base, 'r2')), /^Unknown tool "no\.such"/);
  assert.match(textOf(await registry.call('tools.call', { name: 'tools.call', args: { name: 'notes.jot' } }, base, 'r3')), /not itself/);
  assert.match(textOf(await registry.call('tools.call', { args: {} }, base, 'r4')), /needs the tool's name/);
  assert.match(textOf(await registry.call('tools.call', { name: 'files.write', args: {} }, base, 'r5')), /not available/, 'an engine-only tool needs a known engine');

  const http = rig({ ownTools: false, dynamicTools: true });
  assert.ok(!(await http.registry.call('tools.call', { name: 'files.write', args: {} }, http.base, 'r6')).isError, 'an engine without own tools may write files');
  const codex = rig({ ownTools: true, dynamicTools: true });
  assert.match(textOf(await codex.registry.call('tools.call', { name: 'files.write', args: {} }, codex.base, 'r7')), /not available/, 'Codex brings its own');
});

test('learned from use: a non-core target waits for the next promotion; core targets are not noted; bounded', BOUNDED, async () => {
  const { h, registry, base, services } = rig();
  const chat = h.chat.id;
  await registry.call('tools.call', { name: 'notes.jot', args: { text: 'x' } }, base, 'l1');
  await registry.call('tools.call', { name: 'chat.send', args: {} }, base, 'l2');
  assert.deepEqual(learnedTools(h.db, 'ag_tom', chat), [], 'nothing joins mid-session');
  const offer = () => registry.offerFor(base.agent, services.modes.get('general'), { ownTools: true, via: 'native' }, learnedTools(h.db, 'ag_tom', chat)).map((spec) => spec.name);
  const before = offer();
  assert.ok(!before.includes('notes.jot'));
  assert.equal(promoteLearned(services, 'ag_tom', chat), true);
  assert.deepEqual(learnedTools(h.db, 'ag_tom', chat), ['notes.jot'], 'chat.send is core: not noted');
  assert.deepEqual(offer(), [...before, 'notes.jot'].sort(), 'it joins the offer from the next fresh session on');
  assert.equal(promoteLearned(services, 'ag_tom', chat), false, 'nothing new');
  assert.deepEqual(learnedTools(h.db, 'ag_tom', 'other_chat'), [], 'per chat');

  for (let index = 0; index < MAX_LEARNED + 3; index++) noteLearned(services, 'ag_tom', chat, `x.tool${index}`);
  promoteLearned(services, 'ag_tom', chat);
  const kept = learnedTools(h.db, 'ag_tom', chat);
  assert.equal(kept.length, MAX_LEARNED);
  assert.equal(kept.at(-1), `x.tool${MAX_LEARNED + 2}`, 'the newest kept');
});

test('tools.find: best fit first, direct tools marked, full schema for a name, families when nothing fits; only usable tools', BOUNDED, async () => {
  const { registry, base } = rig();
  const remind = textOf(await registry.call('tools.find', { query: 'remind me tomorrow to call the bank' }, base, 'f1'));
  const lines = remind.split('\n');
  assert.match(lines[1], /^- schedules\.remind: Private reminder: at that time you get a turn with your own note \(no chat post\)\. Args: at\*: string, note\*: string, repeat: daily\|weekly$/);
  assert.ok(!remind.includes('computer.click'));

  const post = textOf(await registry.call('tools.find', { query: 'post a message' }, base, 'f2'));
  assert.match(post, /- chat\.send \(in my list\): Post a message/);

  const exact = textOf(await registry.call('tools.find', { query: 'schedules__remind' }, base, 'f3'));
  assert.match(exact, /^schedules\.remind – Private reminder/);
  assert.match(exact, /Schema: \{"type":"object"/);
  assert.match(exact, /tools\.call \{"name": "schedules\.remind"/);

  const none = textOf(await registry.call('tools.find', { query: 'zzz qqq' }, base, 'f4'));
  assert.match(none, /^Nothing fits "zzz qqq"\. I can use these here: .*notes\.jot/);
  assert.ok(!none.includes('computer'), 'never a tool the mode does not offer');

  // B-049 F8: the one-line purpose is the first sentence – an "e.g." / "i.e." inside it does not cut it short.
  assert.equal(purpose('Hand the task on (e.g. to a writer) or switch modes. Then wait.'), 'Hand the task on (e.g. to a writer) or switch modes.');
  assert.equal(purpose('Change one setting, i.e. a path from settings.get. More.'), 'Change one setting, i.e. a path from settings.get.');
  assert.equal(purpose('Read a file. More.'), 'Read a file.');
});

test('names and arguments: wire and hub names, arguments beside the name, the compact argument line', () => {
  assert.equal(normalizeName('ui__help'), 'ui.help');
  assert.equal(normalizeName('mcp__workforce__browser__save_secret'), 'browser.save_secret');
  assert.deepEqual(callTarget({ name: 'notes.jot', text: 'hi' }), { name: 'notes.jot', args: { text: 'hi' } });
  assert.deepEqual(callTarget({ name: 'notes.jot', args: '{"text":"hi"}' }), { name: 'notes.jot', args: { text: 'hi' } });
  assert.ok('error' in callTarget({ name: 'notes.jot', args: { text: 'a' }, extra: 1 }));
  assert.deepEqual(calledTool('tools.call', { name: 'human.ask', args: { title: 'x' } }), { name: 'human.ask', args: { title: 'x' } });
  assert.deepEqual(calledTool('chat.send', { body: 'x' }), { name: 'chat.send', args: { body: 'x' } });
  assert.equal(compactArgs({ type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, kinds: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }, required: ['query'] }),
    'query*: string, limit: integer 1–20, kinds: (a|b)[]');
});
