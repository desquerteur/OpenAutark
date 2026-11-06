// Session renewal and catch-up over the real chat store, context service and run journal with
// two recording engines (claude, codex): a seed binding left by an earlier version, the renewal
// retry after an ended session (once per run), the catch-up of a session that missed another
// engine's turns, the dropped binding when too much was missed, and the engine-reported window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { sql as sessionRenewal } from '../../../src/runtime/db/migrations/005-session-renewal.ts';
import type { Engine, EngineCaps, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { EngineId, ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';

type Reply = (input: EngineTurnInput) => Partial<EngineTurnResult> | undefined;

const ENDED: Partial<EngineTurnResult> = { text: '', stop: 'error', error: { code: 'conflict', message: 'The conversation is too long for this session.', details: { rebase: true } } };

/** An engine with native sessions that answers "<id> answer <n>" unless `reply` says otherwise. */
function recordingEngine(id: EngineId) {
  const calls: EngineTurnInput[] = [];
  const state: { reply?: Reply; sessions: number } = { sessions: 0 };
  const caps: EngineCaps = { sessions: true, dynamicTools: false, mcp: false, images: false, rebase: true, structured: false, ownTools: false };
  const engine = {
    id, caps,
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      calls.push(input);
      const session = input.session ?? { ref: `${id}-s${++state.sessions}`, generation: 1 };
      return { text: `${id} answer ${calls.length}`, stop: 'done', session, ...state.reply?.(input) };
    },
  } as unknown as Engine;
  return { engine, calls, state };
}

const textOf = (input: EngineTurnInput | undefined) => (input?.input[0] as { text: string } | undefined)?.text ?? '';

function setup() {
  const f = fixture();
  const s = f.services;
  const agent = f.vid;
  const chat = f.chats.create({ title: 'Launch', agentIds: [agent.id], createdBy: 'human' });
  const claude = recordingEngine('claude');
  const codex = recordingEngine('codex');
  const models = new Map<string, ModelInfo>([
    ['claude:opus', { ...model('claude:opus', 'frontier', 'Claude Opus'), provider: 'claude', engine: 'claude' }],
    ['codex:sol', model('codex:sol', 'frontier', 'GPT Sol')],
  ]);
  const route = (engine: 'claude' | 'codex'): RouteDecision => ({
    modelId: engine === 'claude' ? 'claude:opus' : 'codex:sol', engine, accountId: `acc_${engine}`, effort: 'medium',
    category: 'chat', reason: 'test', by: 'rules', alternatives: [],
  });
  const current = { engine: 'claude' as 'claude' | 'codex' };
  const compacts: string[] = [];
  const compact = f.context.compact.bind(f.context);
  f.context.compact = (input) => { compacts.push(input.conversationId); return compact(input); };
  const accounts = new Map([['acc_claude', account('acc_claude', 'claude')], ['acc_codex', account('acc_codex', 'codex')]]);
  Object.assign(s, {
    router: { route: async () => route(current.engine) },
    engines: { get: (id: string) => (id === 'codex' ? codex.engine : claude.engine) },
    accounts: { get: (id: string) => accounts.get(id), markLimited: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()] },
    subconscious: {},
    tools: { get: () => undefined, specsFor: () => [], call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
  });

  let runs = 0;
  const store = new SessionStore(f.db);
  return {
    ...f, s, agent, chat, claude, codex, compacts, store,
    send: (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' }),
    turn: (engine: 'claude' | 'codex') => {
      current.engine = engine;
      return new TurnExecutor(() => s).execute({
        runId: `run_${++runs}`, agentId: agent.id, conversationId: chat.id, reason: 'message', notes: [],
        signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
      });
    },
    binding: (engine: EngineId) => store.get(agent.id, chat.id, engine),
    cursor: () => f.chats.members(chat.id).find((member) => member.memberId === agent.id)!.readSeq,
    notes: (runId: string) => s.runs.items(runId).filter((item) => item.kind === 'note' && item.name !== 'Answer').map((item) => item.data), // the final answer's item (B-047 D4) is no renewal note
  };
}

test('a seed binding left by an earlier version is removed by migration 5; the next turn sends the full projection', async () => {
  const h = setup();
  h.send('Earlier question');
  await h.turn('claude');
  assert.equal(h.binding('claude')?.ref, 'claude-s1');
  assert.ok(SCHEMA_VERSION >= 5);

  // The database of an earlier version: no context_window yet, and a rebase seed that only
  // lived in that process's memory (lost with the restart).
  h.db.exec('ALTER TABLE engine_sessions DROP COLUMN context_window');
  h.db.run(`UPDATE engine_sessions SET session_ref = 'seed:3f1c', generation = 0 WHERE agent_id = ?`, [h.agent.id]);
  h.db.exec(sessionRenewal);
  assert.equal(h.binding('claude'), undefined, 'the seed binding is gone');

  h.send('New question');
  const outcome = await h.turn('claude');
  assert.equal(outcome.status, 'done');
  const input = h.claude.calls[1];
  assert.equal(input.session, undefined, 'a fresh native session');
  assert.match(textOf(input), /Earlier messages:[\s\S]*Earlier question[\s\S]*New messages:[\s\S]*New question/);
  assert.equal(h.binding('claude')?.ref, 'claude-s2', 'a real session ref is saved');
});

test('an ended session is renewed once in the same run (compaction, dropped binding, full projection); never twice', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.claude.state.reply = (input) => (input.session ? ENDED : undefined);

  h.send('Next step');
  const renewed = await h.turn('claude');
  assert.equal(renewed.status, 'done');
  assert.equal(h.claude.calls.length, 3, 'exactly one retry');
  assert.equal(h.claude.calls[1].session?.ref, 'claude-s1');
  assert.equal(h.claude.calls[2].session, undefined, 'the retry starts a fresh session');
  assert.match(textOf(h.claude.calls[2]), /Earlier messages:[\s\S]*Hello[\s\S]*Next step/);
  assert.ok(!textOf(h.claude.calls[2]).includes('still writing'), 'the run\'s own draft is not part of the projection');
  assert.deepEqual(h.compacts, [h.chat.id]);
  assert.equal(h.binding('claude')?.ref, 'claude-s2');
  assert.deepEqual(h.notes('run_2'), [{ sessionRenewed: 'overflow' }]);
  const lines = h.chats.messages(h.chat.id);
  assert.ok(lines.some((line) => line.kind === 'status' && line.meta.status?.text === 'Continued in a fresh session'), 'a quiet status line');
  assert.equal(lines.filter((line) => line.authorId === h.agent.id && line.kind === 'text').at(-1)?.body, 'claude answer 3');

  // The fresh session ends too: no second retry in this run; the binding is dropped.
  h.claude.state.reply = () => ENDED;
  h.send('Again');
  const failed = await h.turn('claude');
  assert.equal(failed.status, 'failed');
  assert.equal(h.claude.calls.length, 5, 'still one retry per run');
  assert.equal(h.binding('claude'), undefined, 'the next turn starts fresh');

  // Tools already ran: no retry at all, only the binding is dropped.
  h.claude.state.reply = undefined;
  h.send('Fresh start');
  await h.turn('claude');
  assert.ok(h.binding('claude'));
  h.claude.state.reply = (input) => {
    void input.callTool('tasks.list', {}, 'call_1');
    return ENDED;
  };
  h.send('Do it');
  await h.turn('claude');
  assert.equal(h.claude.calls.length, 7, 'no retry after a tool call');
  assert.equal(h.binding('claude'), undefined);
  assert.equal(h.compacts.length, 2, 'no compaction without a retry');
});

test('claude → codex → claude: the returning session catches up on missed lines and its own Codex reply', async () => {
  const h = setup();
  h.send('Plan the launch');
  await h.turn('claude');
  h.send('Ask Codex for numbers');
  await h.turn('codex');
  assert.equal(h.codex.calls[0].session, undefined);
  h.send('Back to you');
  await h.turn('claude');

  const back = h.claude.calls[1];
  assert.equal(back.session?.ref, 'claude-s1', 'the Claude session is resumed');
  const text = textOf(back);
  assert.match(text, /^\(This session missed the lines below; my own replies among them were written in another session\.\)/);
  assert.match(text, /Ask Codex for numbers/);
  assert.match(text, /\] Vic \(me\): \(via GPT Sol\) codex answer 1/);
  assert.ok(!text.includes('claude answer 1'), 'the session wrote that reply itself');
  assert.match(text, /Back to you/);
  assert.equal(h.binding('claude')?.cursorSeq, h.cursor(), 'the session cursor is the new lastSeq');

  // Same engine again without a gap: the unchanged delta.
  h.send('Thanks');
  await h.turn('claude');
  const plain = textOf(h.claude.calls[2]);
  assert.equal(h.claude.calls[2].session?.ref, 'claude-s1');
  assert.ok(!plain.includes('This session missed') && !plain.includes('answer'), plain);
  assert.match(plain, /Thanks/);
});

test('B-047 D4: a chat.send post a run of another chat left here is news for this chat\'s session, even on the same engine (regression)', async () => {
  const h = setup();
  h.send('Plan the launch');
  await h.turn('claude');
  const other = h.chats.create({ title: 'Other', agentIds: [h.agent.id], createdBy: 'human' });
  h.s.runs.start({ id: 'run_other', agentId: h.agent.id, conversationId: other.id, trigger: 'message' });
  h.s.runs.finish('run_other', { status: 'done', engine: 'claude', model: 'claude:opus' });
  h.chats.send({ conversationId: h.chat.id, authorId: h.agent.id, body: 'Posted from the other chat', runId: 'run_other', meta: { sentDuringRun: true } });
  h.send('Ask Codex for numbers');
  await h.turn('codex');
  h.send('Back to you');
  await h.turn('claude');
  const back = h.claude.calls[1];
  assert.equal(back.session?.ref, 'claude-s1', 'the Claude session is resumed and catches up');
  assert.match(textOf(back), /Posted from the other chat/, 'that run ran in another session: this one never saw the post');
  assert.ok(!textOf(back).includes('claude answer 1'), 'its own reply here stays known');
});

test('more than 60 missed lines drop the binding: the returning engine starts fresh with the full projection', async () => {
  const h = setup();
  h.send('Start');
  await h.turn('claude');
  for (let i = 1; i <= 61; i++) h.send(`Line ${i}`);
  await h.turn('codex');
  h.send('Back');
  await h.turn('claude');

  const back = h.claude.calls[1];
  assert.equal(back.session, undefined);
  assert.match(textOf(back), /New messages:[\s\S]*Back/);
  assert.ok(!textOf(back).includes('This session missed'));
  assert.deepEqual(h.notes('run_3'), [{ sessionDropped: 'missed_too_much', fresh: 'cursor' }], "SES2's run note variant for a session that missed too much");
  assert.equal(h.binding('claude')?.ref, 'claude-s2');
});

test('the engine-reported context window is stored and renews the session above 60 % when the catalog has none', async () => {
  const h = setup();
  h.claude.state.reply = () => ({ contextWindow: 1000, contextTokens: 500 });
  h.send('Hello');
  await h.turn('claude');
  assert.equal(h.binding('claude')?.contextWindow, 1000);
  h.send('Still small');
  await h.turn('claude');
  assert.equal(h.claude.calls[1].session?.ref, 'claude-s1', '50 % keeps the session');

  h.claude.state.reply = () => ({ contextTokens: 700 });
  h.send('Grows');
  await h.turn('claude');
  assert.equal(h.binding('claude')?.contextWindow, 1000, 'kept while the model stays the same');
  h.claude.state.reply = undefined;
  h.send('Over the line');
  await h.turn('claude');
  assert.equal(h.claude.calls[3].session, undefined, '70 % of the reported window renews it');
  assert.deepEqual(h.compacts, [h.chat.id]);
  assert.deepEqual(h.notes('run_4'), [{ sessionRenewed: 'context' }]);
  assert.equal(h.binding('claude')?.ref, 'claude-s2');
});
