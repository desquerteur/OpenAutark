// CTX7 compaction policy over the real chat store, context service (extractive compaction),
// knowledge store and run journal with one recording engine: the renewal limit (60 % of the
// window, at most the working set of 64k tokens) on a 1M-window model and on an engine
// without caps.rebase, the engine-reported window before the catalog's, the compaction
// run note of a renewal, and a session-less engine's compaction after a done turn once more than
// KEEP_RECENT + 40 seen messages lie past the observation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { WORKING_SET_TOKENS, nearLimit, needsRenewal, renewalLimit, statelessDue } from '../../../src/runtime/agents/compaction-policy.ts';
import { KEEP_RECENT } from '../../../src/runtime/context/compact.ts';
import { ownCoveredSeq } from '../../../src/runtime/context/observations.ts';
import type { Engine, EngineCaps, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';

type Reply = (input: EngineTurnInput) => Partial<EngineTurnResult> | undefined;

const textOf = (input: EngineTurnInput | undefined) => (input?.input[0] as { text: string } | undefined)?.text ?? '';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(options: { caps?: Partial<EngineCaps>; catalogWindow?: number } = {}) {
  const f = fixture();
  const s = f.services;
  const agent = f.vid;
  const chat = f.chats.create({ title: 'Launch', agentIds: [agent.id], createdBy: 'human' });
  const calls: EngineTurnInput[] = [];
  const state: { reply?: Reply; sessions: number } = { sessions: 0 };
  const caps: EngineCaps = { sessions: true, dynamicTools: false, mcp: false, images: false, rebase: true, structured: false, ownTools: false, ...options.caps };
  const engine = {
    id: 'claude', caps,
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      calls.push(input);
      const session = caps.sessions ? (input.session ?? { ref: `s${++state.sessions}`, generation: 1 }) : undefined;
      return { text: `answer ${calls.length}`, stop: 'done', ...(session ? { session } : {}), ...state.reply?.(input) };
    },
  } as unknown as Engine;
  const opus: ModelInfo = {
    ...model('claude:opus', 'frontier', 'Claude Opus'), provider: 'claude', engine: 'claude',
    caps: options.catalogWindow ? { contextTokens: options.catalogWindow } : {},
  };
  const route: RouteDecision = { modelId: opus.id, engine: 'claude', accountId: 'acc_claude', effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  const acc = account('acc_claude', 'claude');
  const compacts: Array<Promise<string>> = [];
  const compact = f.context.compact.bind(f.context);
  f.context.compact = (input) => { const job = compact(input); compacts.push(job); return job; };
  Object.assign(s, {
    router: { route: async () => route },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), markLimited: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => (id === opus.id ? opus : undefined), list: () => [opus] },
    subconscious: {},
    tools: { get: () => undefined, specsFor: () => [], call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
  });

  let runs = 0;
  const store = new SessionStore(f.db);
  return {
    ...f, s, agent, chat, calls, state, compacts,
    send: (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' }),
    turn: () => new TurnExecutor(() => s).execute({
      runId: `run_${++runs}`, agentId: agent.id, conversationId: chat.id, reason: 'message', notes: [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    }),
    /** The low-priority work after a turn: the scheduled check, the compaction, its note update. */
    settled: async () => { await tick(); await Promise.all(compacts); await tick(); },
    binding: () => store.get(agent.id, chat.id, 'claude'),
    cursor: () => f.chats.members(chat.id).find((member) => member.memberId === agent.id)!.readSeq,
    notes: (runId: string) => s.runs.items(runId).filter((item) => item.kind === 'note' && item.name !== 'Answer').map((item) => item.data), // the final answer's item (B-047 D4) is no renewal note
  };
}

test('the renewal limit is 60 % of the window, at most the working set of 64k tokens', () => {
  assert.equal(WORKING_SET_TOKENS, 64_000);
  assert.equal(renewalLimit(1_000_000), WORKING_SET_TOKENS, 'a 1M window renews at 64k, not at 600k');
  assert.equal(renewalLimit(200_000), WORKING_SET_TOKENS);
  assert.equal(renewalLimit(32_000), 19_200, 'a small window renews at 60 %');
  assert.equal(renewalLimit(undefined), WORKING_SET_TOKENS, 'an unknown window still has the working set');
  assert.equal(needsRenewal(200_000, 1_000_000), true);
  assert.equal(needsRenewal(60_000, 1_000_000), false);
  assert.equal(needsRenewal(undefined, 1000), false);
});

test('a 1M-window session: 50k context tokens keep it, 200k renew it (compaction, fresh session)', async () => {
  const h = setup({ catalogWindow: 1_000_000 });
  h.state.reply = () => ({ contextTokens: 50_000 });
  h.send('Hello');
  await h.turn();
  h.send('Next step');
  await h.turn();
  assert.equal(h.calls[1].session?.ref, 's1', '50k of a 1M window keeps the session');
  assert.equal(h.compacts.length, 0);

  h.state.reply = () => ({ contextTokens: 200_000 });
  h.send('More context');
  await h.turn();
  assert.equal(h.calls[2].session?.ref, 's1');
  assert.equal(h.binding()?.contextTokens, 200_000);
  h.state.reply = undefined;
  h.send('Over the working set');
  await h.turn();
  assert.equal(h.calls[3].session, undefined, '200k renews although it is only 20 % of the window');
  assert.match(textOf(h.calls[3]), /Earlier messages:[\s\S]*Hello[\s\S]*New messages:[\s\S]*Over the working set/, 'the full projection');
  assert.equal(h.compacts.length, 1);
  assert.deepEqual(h.notes('run_4'), [{ sessionRenewed: 'context' }], 'a short chat: nothing old enough to summarize, no compaction note');
  assert.equal(h.binding()?.ref, 's2');
});

test('an engine with sessions but without caps.rebase and a known window renews above the working set', async () => {
  const h = setup({ caps: { rebase: false } });
  h.state.reply = () => ({ contextTokens: 50_000 });
  h.send('Hello');
  await h.turn();
  h.state.reply = () => ({ contextTokens: 70_000 });
  h.send('Next step');
  await h.turn();
  assert.equal(h.calls[1].session?.ref, 's1', '50k stays below the working set');
  h.state.reply = undefined;
  h.send('Again');
  await h.turn();
  assert.equal(h.calls[2].session, undefined, '70k renews it');
  assert.deepEqual(h.notes('run_3'), [{ sessionRenewed: 'context' }]);
});

test('the window the engine reported for the model comes before the catalog window', async () => {
  const h = setup({ catalogWindow: 1_000_000 });
  h.state.reply = () => ({ contextWindow: 100_000, contextTokens: 62_000 });
  h.send('Hello');
  await h.turn();
  assert.equal(h.binding()?.contextWindow, 100_000);
  h.state.reply = undefined;
  h.send('Next step');
  await h.turn();
  assert.equal(h.calls[1].session, undefined, '62k is above 60 % of the reported 100k window (the catalog says 1M: 62k would stay)');
});

test('a renewal whose compaction summarized older messages notes {compacted, coveredSeq}', async () => {
  const h = setup({ catalogWindow: 1_000_000 });
  for (let i = 1; i <= 40; i++) h.send(`Line ${i}`);
  h.state.reply = () => ({ contextTokens: 200_000 });
  await h.turn();
  const seen = h.cursor();
  assert.equal(seen, 40);
  h.state.reply = undefined;
  h.send('Over the working set');
  await h.turn();
  assert.equal(h.calls[1].session, undefined);
  const covered = ownCoveredSeq(h.s, h.chat.id, h.agent.id);
  assert.equal(covered, seen - KEEP_RECENT, 'everything but the last 30 seen messages');
  assert.deepEqual(h.notes('run_2'), [{ compacted: 'context', coveredSeq: covered }, { sessionRenewed: 'context' }]);
  assert.match(textOf(h.calls[1]), /^Summary of older messages in this chat[\s\S]*Line 1\b[\s\S]*Earlier messages:[\s\S]*Line 40/);
});

test('a session-less engine compacts after a done turn on a 120-message chat; the next turn starts with the summary', async () => {
  const h = setup({ caps: { sessions: false, rebase: false } });
  for (let i = 1; i <= 120; i++) h.send(`Line ${i}: budget ${i * 10} EUR`);
  const outcome = await h.turn();
  assert.equal(outcome.status, 'done');
  assert.equal(h.cursor(), 120);
  assert.equal(h.compacts.length, 0, 'never inside the turn');
  await h.settled();
  assert.equal(h.compacts.length, 1, 'one compaction at low priority after the turn');
  const covered = ownCoveredSeq(h.s, h.chat.id, h.agent.id);
  assert.equal(covered, 120 - KEEP_RECENT);
  assert.deepEqual(h.notes('run_1'), [{ compacted: 'stateless', coveredSeq: covered }]);

  h.send('Where are we?');
  await h.turn();
  await h.settled();
  const text = textOf(h.calls[1]);
  assert.match(text, /^Summary of older messages in this chat/);
  assert.match(text, /Line 1: budget 10 EUR[\s\S]*Line 90: budget 900 EUR[\s\S]*Earlier messages:[\s\S]*Line 91:[\s\S]*New messages:[\s\S]*Where are we\?/);
  assert.equal(h.compacts.length, 1, 'a few messages past the observation do not compact again');
  assert.deepEqual(h.notes('run_2'), []);
});

test('the session-less trigger: more than KEEP_RECENT + 40 seen messages past the own observation', async () => {
  const h = setup({ caps: { sessions: false, rebase: false } });
  for (let i = 1; i <= 80; i++) h.send(`Line ${i}`);
  h.chats.markRead(h.chat.id, h.agent.id, KEEP_RECENT + 40);
  assert.equal(statelessDue(h.s, h.agent.id, h.chat.id), false, 'exactly 70 seen');
  h.chats.markRead(h.chat.id, h.agent.id, KEEP_RECENT + 41);
  assert.equal(statelessDue(h.s, h.agent.id, h.chat.id), true, '71 seen; unseen messages do not count');
  assert.equal(statelessDue(h.s, h.manager.id, h.chat.id), false, 'not a member of the chat');

  await h.context.compact({ agentId: h.agent.id, conversationId: h.chat.id });
  assert.equal(ownCoveredSeq(h.s, h.chat.id, h.agent.id), 71 - KEEP_RECENT);
  assert.equal(statelessDue(h.s, h.agent.id, h.chat.id), false, 'counted from the observation');
});

test('an engine with sessions never compacts after the turn, however long the chat', async () => {
  const h = setup({ catalogWindow: 1_000_000 });
  for (let i = 1; i <= 120; i++) h.send(`Line ${i}`);
  await h.turn();
  await h.settled();
  assert.equal(h.compacts.length, 0);
  assert.deepEqual(h.notes('run_1'), []);
});

test('near the limit: from 80 % of the renewal limit the subconscious gets a run first', () => {
  assert.equal(nearLimit(0.8 * WORKING_SET_TOKENS, 1_000_000), true);
  assert.equal(nearLimit(0.8 * WORKING_SET_TOKENS - 1, 1_000_000), false);
  assert.equal(nearLimit(48_000, 100_000), true, '60 % of a small window is its limit');
  assert.equal(nearLimit(undefined, 100_000), false);
});
