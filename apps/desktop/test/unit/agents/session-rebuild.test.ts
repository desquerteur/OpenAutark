// B-048 E2 (TRANSFER) – the executor's native rebuild over the real chat store, context service and run journal
// with two recording engines (caps.rebuild) and a fake context ledger: an engine switch rebuilds from the ledger and
// binds the new session (only new lines as input, the old binding superseded, ledger.rebuilt, run note); a failed
// rebuild or probe falls back to today's path with a run note; the probe is kept per CLI version; a rebuilt session
// that ends on its first turn falls back at once and blocks further rebuilds of that chat; marks that take something off
// rebuild at the next turn, with the call naming what is marked; the view mapping (lines the delta carries stay out).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore, SUPERSEDED_NS, type SupersededSession } from '../../../src/runtime/agents/sessions.ts';
import { PROBE_NS, PROBE_REV, probeFor, rebuildItems, resetRebuildMemory, withMarks } from '../../../src/runtime/agents/rebuild.ts';
import { marksCall } from '../../../src/runtime/context/ledger/marks.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import type { Engine, EngineCaps, EngineRebuildInput, EngineTurnInput, EngineTurnResult, RebuildProbe } from '../../../src/runtime/engines/types.ts';
import type { EngineId, ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';
import type { LedgerItem, LedgerViewItem } from '../../../src/shared/model/context-ledger.ts';
import type { RebuildNeed } from '../../../src/runtime/contracts/ledger.ts';

type Reply = (input: EngineTurnInput) => Partial<EngineTurnResult> | undefined;
const ENDED: Partial<EngineTurnResult> = { text: '', stop: 'error', error: { code: 'conflict', message: 'The rebuilt session could not continue.', details: { rebase: true, rebuild: 'failed' } } };

function rebuildingEngine(id: EngineId) {
  const calls: EngineTurnInput[] = [];
  const rebuilds: EngineRebuildInput[] = [];
  const state: { reply?: Reply; sessions: number; fail?: string; probe: Partial<RebuildProbe>; probes: number; version: string } = { sessions: 0, probe: {}, probes: 0, version: '1.0.0' };
  const caps: EngineCaps = { sessions: true, dynamicTools: false, mcp: false, images: false, rebase: true, structured: false, ownTools: false, rebuild: true };
  const engine = {
    id, caps,
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      calls.push(input);
      const session = input.session ?? { ref: `${id}-s${++state.sessions}`, generation: 1 };
      return { text: `${id} answer ${calls.length}`, stop: 'done', session, ...state.reply?.(input) };
    },
    async rebuild(input: EngineRebuildInput) {
      if (state.fail) throw new Error(state.fail);
      rebuilds.push(input);
      return { ref: `${id}-r${rebuilds.length}`, generation: input.generation, items: input.items.length };
    },
    async rebuildVersion() { return state.version; },
    async probeRebuild(): Promise<RebuildProbe> { state.probes++; return { version: state.version, ok: true, at: 0, ...state.probe }; },
  } as unknown as Engine;
  return { engine, calls, rebuilds, state };
}

/** A context ledger with a settable view and marks (the LEDGER track's ContextLedger shape). */
function fakeLedger() {
  const state: { view: LedgerViewItem[]; need?: RebuildNeed; marked: LedgerItem[]; rebuilt: number[] } = { view: [], marked: [], rebuilt: [] };
  const item = (entry: LedgerViewItem): LedgerItem => ({ agentId: 'a', conversationId: 'c', itemId: entry.itemId, kind: entry.kind, order: entry.order, createdAt: 0, tokens: 10, title: entry.text.slice(0, 20), state: 'keep', origin: entry.origin });
  const ledger = {
    view: () => state.view,
    needsRebuild: () => state.need,
    items: (_a: string, _c: string, opts?: { since?: number }) => [...state.view.map(item), ...state.marked].filter((entry) => entry.order >= (opts?.since ?? 0)),
    rebuilt: (_a: string, _c: string, upTo: number) => { state.rebuilt.push(upTo); state.need = undefined; },
    record: () => { throw new Error('not used'); }, mark: () => {}, original: () => undefined,
  };
  return { ledger, state };
}

const view = (entries: Array<[string, LedgerViewItem['kind'], LedgerViewItem['role'], string, LedgerViewItem['call']?]>): LedgerViewItem[] =>
  entries.map(([itemId, kind, role, text, call], index) => ({ itemId, kind, role, text, origin: { engine: 'claude', model: 'claude:opus' }, order: index + 1, state: 'keep', ...(call ? { call } : {}) }));

function setup() {
  resetRebuildMemory();
  const f = fixture();
  const s = f.services;
  const agent = f.vid;
  const chat = f.chats.create({ title: 'Launch', agentIds: [agent.id], createdBy: 'human' });
  const claude = rebuildingEngine('claude');
  const codex = rebuildingEngine('codex');
  const models = new Map<string, ModelInfo>([
    ['claude:opus', { ...model('claude:opus', 'frontier', 'Claude Opus'), provider: 'claude', engine: 'claude' }],
    ['codex:sol', model('codex:sol', 'frontier', 'GPT Sol')],
  ]);
  const route = (engine: 'claude' | 'codex'): RouteDecision => ({
    modelId: engine === 'claude' ? 'claude:opus' : 'codex:sol', engine, accountId: `acc_${engine}`, effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [],
  });
  const current = { engine: 'claude' as 'claude' | 'codex' };
  const accounts = new Map([['acc_claude', account('acc_claude', 'claude')], ['acc_codex', account('acc_codex', 'codex')]]);
  const { ledger, state: ledgerState } = fakeLedger();
  const notices: unknown[] = [];
  Object.assign(s, {
    router: { route: async () => route(current.engine) },
    engines: { get: (id: string) => (id === 'codex' ? codex.engine : claude.engine) },
    accounts: { get: (id: string) => accounts.get(id), markLimited: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()], recordOutcome: () => {} },
    subconscious: {
      afterTurn: async () => {},
    },
    tools: { get: () => undefined, specsFor: () => [], call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
    ledger,
  });
  let runs = 0;
  const store = new SessionStore(f.db);
  return {
    ...f, s, agent, chat, claude, codex, ledgerState, notices, store,
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
    notes: (runId: string) => s.runs.items(runId).filter((item) => item.kind === 'note' && item.name !== 'Answer').map((item) => item.data as Record<string, unknown>),
  };
}

const textOf = (input: EngineTurnInput | undefined) => (input?.input[0] as { text: string } | undefined)?.text ?? '';

test('switch: the turn on the other engine rebuilds its session from the ledger, binds it and sends only the new lines', async () => {
  const h = setup();
  h.send('Build the export');
  await h.turn('claude');
  const seen = h.cursor();
  h.ledgerState.view = view([
    [`m${seen}`, 'message', 'user', '[09:00] Alex: Build the export'],
    ['a1', 'assistant', 'assistant', 'Starting.'],
    ['t2', 'tool', 'tool', 'created tsk_1', { name: 'tasks.create', args: { title: 'Export' }, callId: 'toolu_1', output: 'created tsk_1' }],
  ]);
  h.send('Use CSV please');
  const outcome = await h.turn('codex');
  assert.equal(outcome.status, 'done');

  assert.equal(h.codex.rebuilds.length, 1);
  const rebuild = h.codex.rebuilds[0];
  assert.deepEqual(rebuild.items.map((item) => [item.itemId, item.kind, item.role]), [[`m${seen}`, 'm', 'user'], ['a1', 'a', 'assistant'], ['t2', 't', 'tool']]);
  assert.deepEqual(rebuild.items[2].call, { name: 'tasks.create', args: { title: 'Export' }, callId: 'toolu_1', output: 'created tsk_1' });
  assert.equal(rebuild.generation, 1);
  assert.equal(rebuild.system.stable.length > 0, true);
  assert.equal(h.codex.state.probes, 1, 'the probe ran once for this version');

  const input = h.codex.calls[0];
  assert.deepEqual(input.session, { ref: 'codex-r1', generation: 1 });
  assert.match(textOf(input), /Use CSV please/);
  assert.doesNotMatch(textOf(input), /Earlier messages:|Build the export/, 'no catch-up block: the history is native now');
  assert.equal(h.binding('codex')?.ref, 'codex-r1');
  assert.deepEqual(h.ledgerState.rebuilt, [3]);
  assert.deepEqual(h.notes('run_2').find((note) => note.rebuild), { rebuild: 'native', why: 'switch', engine: 'codex', items: 3, generation: 1, tokens: h.notes('run_2').find((note) => note.rebuild)!.tokens, from: 'claude' });

  // Back to Claude: its old session is superseded by a rebuilt one (generation 2), the probe is not repeated.
  h.send('Thanks');
  await h.turn('claude');
  assert.equal(h.claude.rebuilds.length, 1);
  assert.equal(h.claude.rebuilds[0].generation, 2);
  assert.equal(h.binding('claude')?.ref, 'claude-r1');
  const superseded = new KvRepo(h.db).list<SupersededSession>(SUPERSEDED_NS).map((entry) => entry.value.ref);
  assert.ok(superseded.includes('claude-s1'), 'the replaced Claude session is recorded for the sweep');
  h.send('Once more');
  await h.turn('claude');
  assert.equal(h.claude.rebuilds.length, 1, 'the same engine again resumes its session');
  assert.equal(h.claude.calls.at(-1)?.session?.ref, 'claude-r1');
});

test('fallback: a failed rebuild or probe keeps today\'s path and notes why; the probe result is kept per CLI version', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  h.codex.state.fail = 'thread/inject_items refused chunk 1: bad item';
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.calls[0].session, undefined, 'a fresh session with the projection');
  assert.match(textOf(h.codex.calls[0]), /Hello[\s\S]*Next/);
  assert.deepEqual(h.notes('run_2').find((note) => note.rebuild), { rebuild: 'fallback', why: 'switch', reason: 'thread/inject_items refused chunk 1: bad item' });

  const p = setup();
  p.send('Hello');
  await p.turn('claude');
  p.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  p.codex.state.probe = { ok: false, reason: 'inject_items unsupported' };
  p.send('Next');
  await p.turn('codex');
  assert.equal(p.codex.rebuilds.length, 0);
  assert.deepEqual(p.notes('run_2').find((note) => note.rebuild), { rebuild: 'fallback', why: 'switch', reason: 'probe 1.0.0: inject_items unsupported' });
  assert.equal(new KvRepo(p.db).get<RebuildProbe>(PROBE_NS, 'codex@1.0.0')?.ok, false);
  p.send('Again');
  await p.turn('claude');
  p.send('And again');
  await p.turn('codex');
  assert.equal(p.codex.state.probes, 1, 'a failed probe is not repeated within a day');
  p.codex.state.version = '1.1.0';
  p.codex.state.probe = {};
  p.send('New version');
  await p.turn('claude');
  await p.turn('codex');
  assert.equal(p.codex.state.probes, 2, 'a new CLI version is probed again');
  assert.equal(p.codex.rebuilds.length, 1);
});

test('a rebuild the engine refuses is not tried again every turn (each try starts and deletes a session)', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  let tries = 0;
  const rebuild = h.claude.engine.rebuild!.bind(h.claude.engine);
  h.claude.engine.rebuild = async (input) => { tries++; return rebuild(input); };
  h.claude.state.fail = 'refused';
  h.ledgerState.need = { since: 1, reason: '1 hidden', saves: 50_000 };
  h.send('One');
  await h.turn('claude');
  assert.equal(tries, 1);
  assert.deepEqual(h.notes('run_2').find((note) => note.rebuild), { rebuild: 'fallback', why: 'marks', reason: 'refused' });
  h.send('Two');
  await h.turn('claude');
  h.send('Three');
  await h.turn('claude');
  assert.equal(tries, 1, 'the same marks do not start one more session each turn');
});

test('first-turn error: a rebuilt session that ends on its first turn falls back at once (renewal) and blocks rebuilds of that chat', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  h.codex.state.reply = (input) => (input.session?.ref === 'codex-r1' ? ENDED : undefined);
  h.send('Next');
  const outcome = await h.turn('codex');
  assert.equal(outcome.status, 'done');
  assert.equal(h.codex.calls.length, 2, 'one retry');
  assert.equal(h.codex.calls[0].session?.ref, 'codex-r1');
  assert.equal(h.codex.calls[1].session, undefined, 'the retry is today\'s renewal: a fresh session with the projection');
  assert.match(textOf(h.codex.calls[1]), /Earlier messages:[\s\S]*Hello[\s\S]*Next/);
  const notes = h.notes('run_2');
  assert.ok(notes.some((note) => note.rebuild === 'fallback' && note.reason === 'first_turn_error'));
  assert.equal(h.codex.rebuilds.length, 1);

  h.send('Go on');
  await h.turn('claude');
  h.send('Codex again');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1, 'no new rebuild of this chat on codex for a while');
});

test('backstop: an ended (overflowing) session that was not rebuilt renews as today in its retry – no rebuild in that run', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  h.claude.state.reply = (input) => (input.session?.ref === 'claude-s1' ? { ...ENDED, error: { code: 'conflict', message: 'The conversation is too long for this session.', details: { rebase: true } } } : undefined);
  h.send('Next');
  await h.turn('claude');
  assert.equal(h.claude.calls.length, 3);
  assert.equal(h.claude.calls[2].session, undefined, 'the retry starts fresh with the projection');
  assert.equal(h.claude.rebuilds.length, 0);
  assert.ok(!h.notes('run_2').some((note) => note.rebuild), 'no rebuild and no fallback note');
});

test('marks: any mark the session lacks that takes something off rebuilds it at the next turn; the rebuilt history ends with the call naming what is marked', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('codex');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Long answer'], ['t2', 'tool', 'tool', 'short {"compacted":"t2"}', { name: 'shell', args: { command: 'npm i' }, callId: 'c1', output: 'short' }]]);
  h.ledgerState.marked = [{ agentId: 'a', conversationId: 'c', itemId: 't2', kind: 'tool', order: 2, createdAt: 0, tokens: 9000, title: 'npm install log', state: 'condensed', origin: {} }];
  h.ledgerState.need = { since: 2, reason: '1 restored', saves: -400 };
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 0, 'a restore alone takes nothing off: the call that brought it back stands for it');
  assert.equal(h.codex.calls[1].session?.ref, 'codex-s1');
  // q-r3: a restore whose result was condensed about balances (the item back in place, the result short) – still nothing to rebuild for.
  h.ledgerState.need = { since: 2, reason: '1 restored, 1 condensed', saves: 300, marked: false };
  h.send('Again');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 0, 'no mark of the subconscious among the changes');

  // q-r1b2 (03.11.2026): marks came almost every turn, a gate of max(12k, 25 %) let them in only every third; medium items never.
  h.ledgerState.need = { since: 2, reason: '1 condensed', saves: 400 };
  h.send('More');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1, 'no minimum saving');
  const items = h.codex.rebuilds[0].items;
  const said = 'My context, kept small by the subconscious: condensed t2 – get any back with tools.call {"name":"context.restore","args":{"ids":[…]}}.';
  assert.deepEqual(items.at(-1), { itemId: 'marks2', kind: 't', role: 'tool', text: said, call: { name: 'subconscious', args: {}, callId: 'call_context_marks_2', output: said } });
  assert.equal(h.codex.calls[3].session?.ref, 'codex-r1');
  assert.equal(h.notes('run_4').find((note) => note.rebuild)?.why, 'marks');
});

test('marks come before the backstop: past the renewal limit any marks rebuild the session; without marks it renews', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('codex');
  h.store.save({ ...h.binding('codex')!, contextTokens: 70_000 });
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Long answer'], ['t2', 'tool', 'tool', 'kept', { name: 'shell', args: { command: 'npm i' }, callId: 'c1', output: 'kept' }]]);
  h.ledgerState.marked = [{ agentId: 'a', conversationId: 'c', itemId: 't3', kind: 'tool', order: 3, createdAt: 0, tokens: 5000, title: 'log', state: 'hidden', origin: {} }];
  h.ledgerState.need = { since: 3, reason: '1 hidden', saves: 5_000 };
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1);
  assert.equal(h.codex.calls[1].session?.ref, 'codex-r1', 'the rebuilt session goes on');
  assert.equal(h.notes('run_2').find((note) => note.rebuild)?.why, 'marks');

  h.store.save({ ...h.binding('codex')!, contextTokens: 70_000 });
  h.ledgerState.need = undefined;
  h.ledgerState.marked = [];
  h.send('More');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1, 'nothing marked: no rebuild');
  assert.equal(h.codex.calls[2].session, undefined, 'the renewal: a fresh session with the projection');
});

test('B-048 integration: a switch after marks were applied still names every condensed and hidden item (the new session has no other trace of them)', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  const seen = h.cursor();
  h.ledgerState.view = view([[`m${seen}`, 'message', 'user', '[09:00] Alex: Hello'], ['a3', 'assistant', 'assistant', 'Done.']]);
  h.ledgerState.marked = [
    { agentId: 'a', conversationId: 'c', itemId: 't2', kind: 'tool', order: 2, createdAt: 0, tokens: 9000, title: 'npm install log', state: 'hidden', origin: {} },
    { agentId: 'a', conversationId: 'c', itemId: 't4', kind: 'tool', order: 4, createdAt: 0, tokens: 900, title: 'build output', state: 'condensed', origin: {} },
  ];
  h.ledgerState.need = undefined; // applied by an earlier rebuild: nothing new to rebuild for
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1);
  const items = h.codex.rebuilds[0].items;
  assert.deepEqual(items.map((item) => item.itemId), [`m${seen}`, 'marks0', 'a3'], 'the call sits in front of the closing words');
  assert.equal(items[1].call?.name, 'subconscious', 'the main AI\'s own tool: no call of a tool it lacks (q-r1b2 s15 went looking for context.hide)');
  assert.deepEqual(items[1].call?.args, {});
  assert.match(items[1].call?.output ?? '', /^My context, kept small by the subconscious: condensed t4; hidden t2 – get any back with tools\.call \{"name":"context\.restore"/, 'all marks, newest first');
});

test('trace: an engine that shows it natively gets the calls; one that cannot gets a tool-call-shaped block and a run note; both journal real calls', async () => {
  const h = setup();
  const trace = { calls: [{ tool: 'vector.search', args: { query: 'launch', in: ['memory'] }, output: 'memory/company/launch.md: Friday' }] };
  (h.s.subconscious as { beforeTurn?: unknown }).beforeTurn = async () => trace;
  h.send('When is the launch?');
  await h.turn('claude');
  const plain = h.claude.calls[0];
  assert.equal(plain.trace, undefined);
  assert.match((plain.input[0] as { text: string }).text, /^<tool_call name="vector\.search" args='\{"query":"launch","in":\["memory"\]\}'>\n<tool_output>\nmemory\/company\/launch\.md: Friday/);
  assert.ok(h.notes('run_1').some((note) => note.traceAsText === 'claude'));
  const items = h.s.runs.items('run_1');
  const call = items.find((item) => item.kind === 'tool_call' && item.name === 'vector.search')!;
  assert.equal(call.data.subconscious, true);
  const result = items.find((item) => item.kind === 'tool_result' && item.name === 'vector.search')!;
  assert.equal(result.data.callId, call.data.callId);

  (h.codex.engine.caps as { trace?: boolean }).trace = true;
  h.send('And the budget?');
  await h.turn('codex');
  assert.deepEqual(h.codex.calls.at(-1)!.trace, trace);
  assert.doesNotMatch(textOf(h.codex.calls.at(-1)), /tool_call/);
});

test('a fresh history from the projection carries the call naming what is marked there; a resumed session does not', async () => {
  const h = setup();
  h.ledgerState.marked = [{ agentId: 'a', conversationId: 'c', itemId: 'm1', kind: 'message', order: 1, createdAt: 0, tokens: 90, title: 'Old line', state: 'hidden', origin: {} }];
  (h.codex.engine.caps as { trace?: boolean }).trace = true;
  h.send('Hello');
  await h.turn('codex');
  assert.deepEqual(h.codex.calls[0].trace?.calls.map((call) => call.tool), ['subconscious']);
  assert.match(h.codex.calls[0].trace?.calls[0].output ?? '', /^My context, kept small by the subconscious: hidden m1 – get any back with tools\.call \{"name":"context\.restore"/);
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.calls[1].trace, undefined);
});

test('view mapping: lines after the cursor stay for the delta; trailing person lines go back to the delta; kinds become id letters', () => {
  const items = view([
    ['m3', 'message', 'user', 'first'], ['a1', 'assistant', 'assistant', 'answer'], ['r2', 'reasoning', 'assistant', 'thought'],
    ['m5', 'message', 'user', 'unanswered'], ['m6', 'message', 'user', 'also unanswered'], ['m9', 'message', 'user', 'not seen yet'],
  ]);
  const { items: out, sinceSeq } = rebuildItems(items, 7);
  assert.deepEqual(out.map((item) => `${item.itemId}:${item.kind}`), ['m3:m', 'a1:a', 'r2:r']);
  assert.equal(sinceSeq, 4, 'the delta starts before the first unanswered line');
  assert.equal(rebuildItems(items.slice(0, 2), 7).sinceSeq, 7, 'ending with the agent\'s own text: the delta starts at the cursor');
  assert.equal(marksCall([{ itemId: 't9', state: 'hidden' }, { itemId: 'm240', state: 'condensed' }])?.output,
    'My context, kept small by the subconscious: condensed m240; hidden t9 – get any back with tools.call {"name":"context.restore","args":{"ids":[…]}}.');

  // The marks call goes in front of the agent's closing words, so the history still ends at its answer.
  const tidy = { itemId: 'marks2', kind: 't', role: 'tool' as const, text: 'x', call: { name: 'context.hide', args: {}, callId: 'c', output: 'x' } };
  const answered = rebuildItems(view([['m3', 'message', 'user', 'go'], ['t4', 'tool', 'tool', 'ok', { name: 'tasks.create', args: {}, callId: 'c4', output: 'ok' }], ['r5', 'reasoning', 'assistant', 'thought'], ['a6', 'assistant', 'assistant', 'Done.']]), 7).items;
  assert.deepEqual(withMarks(answered, tidy).map((item) => item.itemId), ['m3', 't4', 'marks2', 'r5', 'a6']);
  assert.deepEqual(withMarks(answered.slice(0, 2), tidy).map((item) => item.itemId), ['m3', 't4', 'marks2'], 'no closing words: at the end');
  assert.equal(withMarks(answered, undefined), answered);
});

test('older chat (B-048 review): a ledger that starts after the chat\'s first line gets the chat\'s compaction summary in front', async () => {
  const h = setup();
  h.send('First, long ago');
  h.send('Second');
  await h.turn('claude');
  h.knowledge.save({
    title: 'Chat observations up to #1', body: 'Summary:\nAlex wants the export as CSV.', kind: 'observation', scope: 'conversation', scopeId: h.chat.id,
    createdBy: h.agent.id, tags: ['compaction'], source: { kind: 'agent', ref: h.chat.id, trusted: true },
  });
  h.ledgerState.view = view([['m2', 'message', 'user', '[09:00] Alex: Second'], ['a1', 'assistant', 'assistant', 'On it.']]);
  h.send('Go on');
  await h.turn('codex');
  const items = h.codex.rebuilds[0].items;
  assert.deepEqual(items.map((item) => item.itemId), ['summary', 'm2', 'a1']);
  assert.equal(items[0].role, 'user');
  assert.match(items[0].text, /^Summary of older messages in this chat \(generated by the runtime, not a message\):\nSummary:\nAlex wants the export as CSV\.$/);

  // A ledger from the chat's first line on needs no summary.
  h.ledgerState.view = view([['m1', 'message', 'user', '[09:00] Alex: First'], ['a1', 'assistant', 'assistant', 'On it.']]);
  h.send('And back');
  await h.turn('claude');
  assert.deepEqual(h.claude.rebuilds[0].items.map((item) => item.itemId), ['m1', 'a1']);
});

test('probe cache: per CLI version in kv, an unknown version only in memory, one probe at a time', async () => {
  const h = setup();
  const engine = h.codex.engine;
  const acc = account('acc_codex', 'codex');
  const [a, b] = await Promise.all([probeFor(h.s, engine, acc, '/ws'), probeFor(h.s, engine, acc, '/ws')]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(h.codex.state.probes, 1, 'concurrent callers share one probe');
  assert.ok(new KvRepo(h.db).get(PROBE_NS, 'codex@1.0.0'));
  (engine as unknown as { rebuildVersion: () => Promise<undefined> }).rebuildVersion = async () => undefined;
  await probeFor(h.s, engine, acc, '/ws');
  await probeFor(h.s, engine, acc, '/ws');
  assert.equal(h.codex.state.probes, 2);
  assert.equal(new KvRepo(h.db).get(PROBE_NS, 'codex@unknown'), undefined, 'an unknown version is not stored');
});

test('B-049 F6: a rebuild that keeps the session ref (a Codex revert) forgets what that session was sent – a failed first turn leaves no stale record', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('codex');
  h.send('Next');
  await h.turn('codex');
  assert.match(h.codex.calls[1].system.volatile, /Unchanged since my last turn/, 'resumed: a delta');
  // Like CodexEngine.revert: the bound thread stays (same ref), cut before a recorded turn – the context blocks of the cut turns are gone.
  (h.codex.engine as { rebuild: (input: EngineRebuildInput) => Promise<unknown> }).rebuild = async (input) => {
    h.codex.rebuilds.push(input);
    return { ref: 'codex-s1', generation: input.generation, items: input.items.length };
  };
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Long answer'], ['t2', 'tool', 'tool', 'short {"compacted":"t2"}', { name: 'shell', args: { command: 'npm i' }, callId: 'c1', output: 'short' }]]);
  h.ledgerState.marked = [{ agentId: 'a', conversationId: 'c', itemId: 't2', kind: 'tool', order: 2, createdAt: 0, tokens: 9000, title: 'npm install log', state: 'condensed', origin: {} }];
  h.ledgerState.need = { since: 2, reason: '1 condensed', saves: 20_000 };
  h.codex.state.reply = () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'model error' } });
  h.send('More');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1);
  const rebuiltTurn = h.codex.calls[2];
  assert.equal(rebuiltTurn.session?.ref, 'codex-s1');
  assert.ok(!rebuiltTurn.system.volatile.includes('Unchanged since my last turn'), 'a rebuilt session gets every section');

  h.codex.state.reply = undefined;
  h.send('Again');
  await h.turn('codex');
  const next = h.codex.calls.at(-1)!;
  assert.equal(next.session?.ref, 'codex-s1', 'resumed, not rebuilt again');
  assert.equal(h.codex.rebuilds.length, 1);
  assert.ok(next.system.volatile.includes('## This chat') && !next.system.volatile.includes('Unchanged since my last turn'), next.system.volatile);
});

test('B-049 F9 guard: a marks rebuild that would not shrink the live context is skipped with a note; a bigger live context rebuilds; a switch always does', async () => {
  const h = setup();
  h.codex.state.reply = () => ({ contextTokens: 14_000 }); // what the engine reports as the session's real context
  h.send('Hello');
  await h.turn('codex');
  assert.equal(h.binding('codex')?.contextTokens, 14_000);
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'x'.repeat(60_000)], ['t2', 'tool', 'tool', 'short {"compacted":"t2"}', { name: 'shell', args: { command: 'npm i' }, callId: 'c1', output: 'short' }]]);
  h.ledgerState.marked = [{ agentId: 'a', conversationId: 'c', itemId: 't2', kind: 'tool', order: 2, createdAt: 0, tokens: 9000, title: 'npm install log', state: 'condensed', origin: {} }];
  h.ledgerState.need = { since: 2, reason: '1 condensed', saves: 20_000 }; // the ledger's savings alone say "worth it"
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 0, 'the rebuilt history (15k + prompt) is not smaller than the 14k the session really holds');
  const skipped = h.notes('run_2').find((note) => note.rebuild)!;
  assert.equal(skipped.rebuild, 'skipped');
  assert.equal(skipped.why, 'not smaller than the live context');
  assert.equal(skipped.live, 14_000);
  assert.ok(Number(skipped.rebuilt) > 15_500, `${skipped.rebuilt}: the history (~15.03k) plus the turn's prompt and tool definitions`);
  assert.equal(h.codex.calls[1].session?.ref, 'codex-s1', 'the session goes on as it is');

  h.store.save({ ...h.binding('codex')!, contextTokens: 60_000 });
  h.send('More');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1, 'clearly smaller than 60k: rebuilt');
  assert.equal(h.notes('run_3').find((note) => note.rebuild)?.why, 'marks');

  const s = setup();
  s.codex.state.reply = () => ({ contextTokens: 1_000 });
  s.send('Hello');
  await s.turn('codex');
  s.ledgerState.view = view([['a1', 'assistant', 'assistant', 'x'.repeat(60_000)]]);
  s.send('Next');
  await s.turn('claude');
  assert.equal(s.claude.rebuilds.length, 1, 'an engine switch rebuilds whatever the size');
  s.send('Back');
  await s.turn('codex');
  assert.equal(s.codex.rebuilds.length, 1, 'a switch back onto a small live Codex session rebuilds too (no guard on a switch)');
});

test('B-049 F9: a probe kept before PROBE_REV runs once more; the kept one of this revision holds', async () => {
  const h = setup();
  const acc = account('acc_codex', 'codex');
  new KvRepo(h.db).set(PROBE_NS, 'codex@1.0.0', { version: '1.0.0', ok: true, at: 0 }, 0);
  await probeFor(h.s, h.codex.engine, acc, '/ws');
  await probeFor(h.s, h.codex.engine, acc, '/ws');
  assert.equal(h.codex.state.probes, 1, 'the old probe knew nothing of custom items');
  assert.equal(new KvRepo(h.db).get<{ rev?: number }>(PROBE_NS, 'codex@1.0.0')?.rev, PROBE_REV);
});
