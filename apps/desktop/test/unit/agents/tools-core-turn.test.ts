// B-049 F4 (TOOLS-CORE) at turn level:
// - learned from use over the real chat store, context service and session rows with a Codex-like engine: a tool run
//   through tools.call joins the offer at the next fresh session (here a context renewal), never in a resumed one –
//   the resumed session keeps its tools and prompt key; a stateless engine takes it at its next turn;
// - a tools.call counts (progress, the human.ask must-see rule) and shows as the tool it runs (turn-attempt).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { setup as turnSetup } from './fixture.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { promptKey } from '../../../src/runtime/agents/session-key.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { runAttempt } from '../../../src/runtime/agents/turn-attempt.ts';
import { effectful } from '../../../src/runtime/agents/turn-types.ts';
import { noteLearned } from '../../../src/runtime/tools/learned.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { Engine, EngineCaps, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ToolSpec } from '../../../src/runtime/tools/types.ts';
import type { ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';

const spec = (name: string): ToolSpec => ({ name, description: name, inputSchema: { type: 'object' } });
const ALL = ['media.image', 'schedules.remind', 'tasks.list', 'tools.call', 'tools.find'];
const CORE = ['tasks.list', 'tools.call', 'tools.find'];

function setup(sessions = true) {
  const f = fixture();
  const s = f.services;
  const vic = f.vid;
  const chat = f.chats.create({ title: 'Desk', agentIds: [vic.id], createdBy: 'human' });
  const calls: EngineTurnInput[] = [];
  const state: { reply?: (input: EngineTurnInput) => Partial<EngineTurnResult> | undefined; sessions: number } = { sessions: 0 };
  const caps: EngineCaps = { sessions, dynamicTools: true, mcp: false, images: false, rebase: true, structured: false, ownTools: true };
  const engine = {
    id: 'codex', caps,
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      calls.push(input);
      const session = sessions ? input.session ?? { ref: `codex-s${++state.sessions}`, generation: 1 } : undefined;
      return { text: `answer ${calls.length}`, stop: 'done', ...(session ? { session } : {}), ...state.reply?.(input) };
    },
  } as unknown as Engine;
  const models = new Map<string, ModelInfo>([['codex:sol', model('codex:sol', 'frontier', 'GPT Sol')]]);
  const route: RouteDecision = { modelId: 'codex:sol', engine: 'codex', accountId: 'acc_codex', effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  const acc = account('acc_codex', 'codex');
  Object.assign(s, {
    modes: { get: (key: string) => { if (key !== GENERAL_MODE.key) throw new Error(`unknown mode ${key}`); return GENERAL_MODE; }, list: () => [GENERAL_MODE] },
    router: { route: async () => route },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), markLimited: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()] },
    subconscious: {},
    tools: {
      get: () => undefined,
      specsFor: () => ALL.map(spec),
      // The registry's rule (registry.ts offerFor): the core set plus the learned names the mode allows, in specsFor order.
      offerFor: (_agent: unknown, _mode: unknown, _engine: unknown, learned: readonly string[] = []) => ALL.filter((name) => CORE.includes(name) || learned.includes(name)).map(spec),
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    },
  });
  let runs = 0;
  const store = new SessionStore(f.db);
  return {
    ...f, vic, chat, calls, state, store,
    send: (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' }),
    turn: () => new TurnExecutor(() => s).execute({
      runId: `run_${++runs}`, agentId: vic.id, conversationId: chat.id, reason: 'message', notes: [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    }),
    binding: () => store.get(vic.id, chat.id, 'codex'),
    learn: (name: string) => noteLearned(s, vic.id, chat.id, name),
  };
}

const toolsOf = (input: EngineTurnInput | undefined) => (input?.tools ?? []).map((tool) => tool.name);
const keyOf = (input: EngineTurnInput) => promptKey(input.system.stable, input.tools.map((tool) => tool.name));

test('a tool run through tools.call joins at the next fresh session, never in the resumed one', async () => {
  const h = setup();
  h.send('Hello');
  assert.equal((await h.turn()).status, 'done');
  assert.deepEqual(toolsOf(h.calls[0]), CORE);
  h.learn('media.image'); // the agent ran media.image through tools.call in this turn

  h.state.reply = () => ({ contextTokens: 170_000 }); // this turn fills the session past the renewal limit
  h.send('Draw a logo');
  await h.turn();
  assert.equal(h.calls[1].session?.ref, 'codex-s1', 'resumed');
  assert.deepEqual(toolsOf(h.calls[1]), CORE, 'the resumed session keeps the tools it started with');
  assert.equal(keyOf(h.calls[1]), h.binding()?.promptKey, 'and its prompt key');

  h.state.reply = undefined;
  h.send('Another one');
  await h.turn();
  const fresh = h.calls[2];
  assert.equal(fresh.session, undefined, 'the context renewal starts a fresh session');
  assert.deepEqual(toolsOf(fresh), ['media.image', ...CORE], 'the learned tool joins there');
  assert.equal(h.binding()?.promptKey, keyOf(fresh), 'the new session is stored with the offer it really got');

  h.send('Thanks');
  await h.turn();
  assert.equal(h.calls[3].session?.ref, 'codex-s2', 'no renewal for the promotion itself');
  assert.deepEqual(toolsOf(h.calls[3]), ['media.image', ...CORE]);
});

test('a stateless engine takes a learned tool at its next turn', async () => {
  const h = setup(false);
  h.send('Hello');
  await h.turn();
  h.learn('schedules.remind');
  h.send('Remind me');
  await h.turn();
  assert.deepEqual(toolsOf(h.calls[1]), ['schedules.remind', ...CORE]);
});

test('a tools.call counts and shows as the tool it runs (progress, asking the person)', async () => {
  const h = turnSetup({ dynamicTools: true });
  const statuses: string[] = [];
  const called: string[] = [];
  Object.assign(h.services, {
    tools: {
      ...h.services.tools,
      get: (name: string) => ({ category: name === 'tools.call' ? 'read' : name === 'human.ask' ? 'think' : 'write_local' }),
      call: async (name: string) => { called.push(name); return { content: [{ type: 'text', text: 'ok' }] }; },
    },
  });
  const request = { ...h.request({ runId: 'run_tc' }), onStatus: (note: string) => statuses.push(note) };
  const plan = (await planTurn(h.services, request))!;
  h.state.script = async (input) => {
    input.onEvent({ type: 'tool_start', callId: 'call_1', name: 'tools.call', args: { name: 'files.write', args: { path: 'notes.md', content: 'x' } }, own: false });
    await input.callTool('tools.call', { name: 'files.write', args: { path: 'notes.md', content: 'x' } }, 'call_1');
    input.onEvent({ type: 'tool_start', callId: 'toolu_2', name: 'tools.call', args: { name: 'human__ask', args: { title: 'Which logo?' } }, own: false });
    input.onEvent({ type: 'tool_end', callId: 'toolu_2', ok: true, summary: 'asked' });
    return { text: 'Asked.', stop: 'done' };
  };
  const attempt = await runAttempt(h.services, plan, h.routed(), request, undefined);
  assert.deepEqual(attempt.tools?.map((use) => [use.name, use.category, use.ok]), [['files.write', 'write_local', true], ['human.ask', 'think', true]]);
  assert.deepEqual(called, ['tools.call'], 'the registry gets the tools.call (it unwraps it)');
  assert.equal(attempt.tools!.some(effectful), true, 'a write through tools.call counts as progress');
  assert.ok(!statuses.some((note) => /tools\.call/.test(note)), `the status names the real step: ${statuses.join(' | ')}`);
});
