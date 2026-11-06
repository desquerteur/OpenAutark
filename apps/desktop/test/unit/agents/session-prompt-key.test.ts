// SES2 – session prompt key over the real chat store, context service (real stable prompt) and
// run journal with a recording Codex-like engine (native sessions + dynamic tools): a mode switch
// general → computer renews the session with the computer tools and the "Mode changed" note, a
// changed tool offer in the same mode renews with fresh 'prompt', a row from before SES2
// (migration 8 adds the columns as NULL) is accepted once, and the human mode switch over RPC
// posts one quiet 'mode_switched' line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { agent } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { promptKey } from '../../../src/runtime/agents/session-key.ts';
import { SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { sql as sessionPromptKey } from '../../../src/runtime/db/migrations/008-session-prompt-key.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { Engine, EngineCaps, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ToolSpec } from '../../../src/runtime/tools/types.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Conversation, Message } from '../../../src/shared/model/chat.ts';
import type { ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';

const COMPUTER_MODE: ModeInfo = {
  key: 'computer', name: 'Computer', description: 'Work on the screen of a PC.', skills: [], tools: ['*'], category: 'computer-use',
  workspace: 'computer', instructions: '# Computer mode\n\nLook at the screen before every click.',
};
const MODES = new Map([[GENERAL_MODE.key, GENERAL_MODE], [COMPUTER_MODE.key, COMPUTER_MODE]]);
const spec = (name: string): ToolSpec => ({ name, description: name, inputSchema: { type: 'object' } });

type Reply = (input: EngineTurnInput) => Partial<EngineTurnResult> | undefined;

function setup() {
  const f = fixture();
  const s = f.services;
  const vic = f.vid;
  const chat = f.chats.create({ title: 'Desk', agentIds: [vic.id], createdBy: 'human' });
  const calls: EngineTurnInput[] = [];
  const state: { reply?: Reply; sessions: number; extraTool?: string } = { sessions: 0 };
  const caps: EngineCaps = { sessions: true, dynamicTools: true, mcp: false, images: false, rebase: true, structured: false, ownTools: true };
  const engine = {
    id: 'codex', caps,
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      calls.push(input);
      const session = input.session ?? { ref: `codex-s${++state.sessions}`, generation: 1 };
      return { text: `answer ${calls.length}`, stop: 'done', session, ...state.reply?.(input) };
    },
  } as unknown as Engine;
  const models = new Map<string, ModelInfo>([['codex:sol', model('codex:sol', 'frontier', 'GPT Sol')]]);
  const route: RouteDecision = { modelId: 'codex:sol', engine: 'codex', accountId: 'acc_codex', effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  const compacts: string[] = [];
  const compact = f.context.compact.bind(f.context);
  f.context.compact = (input) => { compacts.push(input.conversationId); return compact(input); };
  const acc = account('acc_codex', 'codex');
  Object.assign(s, {
    modes: { get: (key: string) => { const mode = MODES.get(key); if (!mode) throw new Error(`unknown mode ${key}`); return mode; }, list: () => [...MODES.values()] },
    router: { route: async () => route },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), markLimited: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()] },
    subconscious: {},
    tools: {
      get: () => undefined,
      // Device tools only in the computer workspace (as ToolRegistry.allowed does).
      specsFor: (_agent: unknown, mode: ModeInfo) => [
        spec('tasks.list'), ...(mode.workspace === 'computer' ? [spec('computer.screenshot'), spec('computer.click')] : []),
        ...(state.extraTool ? [spec(state.extraTool)] : []),
      ],
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    },
  });

  let runs = 0;
  const store = new SessionStore(f.db);
  return {
    ...f, vic, chat, calls, state, compacts, store,
    send: (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' }),
    setMode: (mode: string) => f.chats.update(chat.id, { settings: { mode } }, 'human'),
    turn: () => new TurnExecutor(() => s).execute({
      runId: `run_${++runs}`, agentId: vic.id, conversationId: chat.id, reason: 'message', notes: [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    }),
    binding: () => store.get(vic.id, chat.id, 'codex'),
    notes: (runId: string) => s.runs.items(runId).filter((item) => item.kind === 'note' && item.name !== 'Answer').map((item) => item.data), // the final answer's item (B-047 D4) is no renewal note
  };
}

const textOf = (input: EngineTurnInput | undefined) => (input?.input[0] as { text: string } | undefined)?.text ?? '';
const toolsOf = (input: EngineTurnInput | undefined) => (input?.tools ?? []).map((tool) => tool.name).sort();
const keyOf = (input: EngineTurnInput) => promptKey(input.system.stable, input.tools.map((tool) => tool.name));

test('general → computer renews the session: computer prompt and tools, the "Mode changed" note, fresh: mode', async () => {
  const h = setup();
  h.send('Hello');
  assert.equal((await h.turn()).status, 'done');
  assert.equal(h.calls[0].session, undefined);
  assert.deepEqual(toolsOf(h.calls[0]), ['tasks.list'], 'no device tools in general');
  const first = h.binding()!;
  assert.equal(first.ref, 'codex-s1');
  assert.equal(first.mode, 'general');
  assert.equal(first.promptKey, keyOf(h.calls[0]), 'turn-finish saves the key of the offered prompt and tools');
  assert.match(first.promptKey!, /^[0-9a-f]{64}$/);

  h.send('Next');
  await h.turn();
  assert.equal(h.calls[1].session?.ref, 'codex-s1', 'same mode, same key: the session is resumed');
  assert.deepEqual(h.notes('run_2'), []);

  h.setMode('computer');
  h.send('Take a screenshot of the desktop');
  assert.equal((await h.turn()).status, 'done');
  const renewed = h.calls[2];
  assert.equal(renewed.session, undefined, 'a fresh native session');
  assert.deepEqual(toolsOf(renewed), ['computer.click', 'computer.screenshot', 'tasks.list'], 'the new session gets the computer tools');
  assert.match(renewed.system.stable, /Look at the screen before every click/, 'and the computer mode prompt');
  const text = textOf(renewed);
  assert.match(text, /Mode changed from General to Computer\./);
  assert.match(text, /Earlier messages:[\s\S]*Hello[\s\S]*Take a screenshot/, 'the full projection');
  assert.deepEqual(h.notes('run_3'), [{ fresh: 'mode', from: 'general', to: 'computer' }]);
  assert.deepEqual(h.compacts, [h.chat.id], 'renewed the SES1 way (compaction first)');
  const second = h.binding()!;
  assert.equal(second.ref, 'codex-s2');
  assert.equal(second.mode, 'computer');
  assert.equal(second.promptKey, keyOf(renewed));

  h.send('Click OK');
  await h.turn();
  assert.equal(h.calls[3].session?.ref, 'codex-s2', 'the computer session is resumed');
  assert.ok(!textOf(h.calls[3]).includes('Mode changed'), 'the note comes once');
});

test('a changed tool offer in the same mode renews with fresh: prompt and no mode note', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn();
  h.state.extraTool = 'media.image';
  h.send('Draw a logo');
  await h.turn();
  assert.equal(h.calls[1].session, undefined);
  assert.deepEqual(toolsOf(h.calls[1]), ['media.image', 'tasks.list']);
  assert.ok(!textOf(h.calls[1]).includes('Mode changed'));
  assert.deepEqual(h.notes('run_2'), [{ fresh: 'prompt' }]);
  assert.equal(h.binding()?.promptKey, keyOf(h.calls[1]));
});

test('a session row from before SES2 is reused once (stamped on acceptance); then the key decides', async () => {
  const h = setup();
  assert.ok(SCHEMA_VERSION >= 8);
  h.send('Hello');
  await h.turn();

  // The database of an earlier version: migration 8 adds the columns, existing rows keep NULL.
  h.db.exec('ALTER TABLE engine_sessions DROP COLUMN prompt_key; ALTER TABLE engine_sessions DROP COLUMN mode;');
  h.db.exec(sessionPromptKey);
  assert.equal(h.binding()?.promptKey, undefined);
  assert.equal(h.binding()?.mode, undefined);

  // Accepted although its prompt is unknown – and stamped before the engine runs, so a turn that
  // ends without saving the session cannot make it legacy again.
  h.setMode('computer');
  h.state.reply = () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'The engine crashed.' }, session: undefined });
  h.send('Open the settings');
  assert.equal((await h.turn()).status, 'failed');
  assert.equal(h.calls[1].session?.ref, 'codex-s1', 'the legacy row is accepted once');
  assert.deepEqual(h.notes('run_2'), []);
  assert.equal(h.binding()?.promptKey, keyOf(h.calls[1]), 'stamped with the accepting turn\'s key');
  assert.equal(h.binding()?.mode, 'computer');

  // From now on the key decides: back to general renews it.
  h.state.reply = undefined;
  h.setMode('general');
  h.send('Thanks');
  await h.turn();
  assert.equal(h.calls[2].session, undefined, 'not accepted a second time');
  assert.deepEqual(h.notes('run_3'), [{ fresh: 'mode', from: 'computer', to: 'general' }]);
  assert.match(textOf(h.calls[2]), /Mode changed from Computer to General\./);
  assert.equal(h.binding()?.ref, 'codex-s2');
});

test('chats.update: a human mode switch posts one quiet mode_switched line', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  Object.assign(f.services, { modes: { get: (key: string) => { const mode = MODES.get(key); if (!mode) throw new Error('unknown'); return mode; } } });
  f.org.add(agent('ag_ava', 'Ava'));
  const owner = new TestClient(f.server, OWNER);
  const chat = await owner.call<Conversation>('chats.create', { agentIds: ['ag_ava'] });
  const lines = async () => (await owner.call<Message[]>('messages.list', { conversationId: chat.id })).filter((message) => message.meta.status?.type === 'mode_switched');

  await owner.call('chats.update', { id: chat.id, settings: { mode: 'computer' } });
  let switched = await lines();
  assert.equal(switched.length, 1);
  assert.equal(switched[0].body, 'Switched to Computer mode');
  assert.equal(switched[0].kind, 'status');
  assert.equal(switched[0].silent, true, 'quiet: no unread, no notification');
  assert.deepEqual(switched[0].meta.status?.details, { to: 'computer', by: 'human' });

  await owner.call('chats.update', { id: chat.id, settings: { mode: 'computer' } });
  await owner.call('chats.update', { id: chat.id, title: 'Desk work' });
  assert.equal((await lines()).length, 1, 'no line without a change');

  await owner.call('chats.update', { id: chat.id, settings: { mode: null } });
  switched = await lines();
  assert.equal(switched.length, 2);
  assert.equal(switched[1].body, 'Mode reset to the agent default');
  assert.equal(f.wakeRows().filter((wake) => wake.reason === 'message').length, 0, 'status lines wake nobody');
});
