// The subconscious and the transcript under attack: the person's still open instruction survives a bare "ja bitte"; a stamp never
// promises a way back that is gone; a trace stays in the history of a stateless engine, bounded, following the marks; in a chat of
// two agents neither loses its wake; a paid brain's cost reaches the spend journal.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { contextTools } from '../../../src/runtime/subconscious/context-tools.ts';
import type { FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import type { TraceCall } from '../../../src/shared/model/subconscious.ts';
import { traceCallId } from '../../../src/shared/model/subconscious.ts';
import { carriedCalls, markedMessages, marksOf, CARRIED_TOKENS } from '../../../src/runtime/context/ledger/marks.ts';
import { rebuildItems } from '../../../src/runtime/agents/rebuild-items.ts';
import { restoreItems } from '../../../src/runtime/context/ledger/restore.ts';
import { MAX_TEXT_CHARS } from '../../../src/runtime/tools/outputs.ts';
import { ledgerSetup } from '../context/ledger-fixture.ts';
import { RESOURCES, fixture } from '../context/fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { createEngineRunner } from '../../../src/runtime/decision/engine-runner.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { Engine, EngineTurnInput } from '../../../src/runtime/engines/types.ts';

const tool = (name: string) => contextTools.find((entry) => entry.name === name)!;

function runOf(t: ReturnType<typeof ledgerSetup>): FlowRun {
  return {
    services: t.services, agent: t.tom, conversationId: t.chat.id, thread: t.chat.id, kind: 'after-turn', signal: new AbortController().signal,
    hits: new Map(), searches: [], show: () => {}, route: () => {}, finish: () => {},
  } as unknown as FlowRun;
}

test('the person\'s instruction stays out of reach while only a bare "ja bitte" came after it', async () => {
  const t = ledgerSetup();
  try {
    const old = t.say('An older finished topic about the logo, long enough to be worth a look.');
    t.done(t.turn(old.seq));
    t.clock.advance(1000);
    const instruction = t.say(`Build the whole invoice export for Brightwave and send it to Lea. ${'Details follow. '.repeat(40)}`);
    t.done(t.turn(instruction.seq));
    t.clock.advance(1000);
    const yes = t.say('ja bitte');
    t.done(t.turn(yes.seq));
    for (let index = 0; index < 4; index++) {
      t.clock.advance(1000);
      const run = t.turn(yes.seq);
      t.ourCall(run, 'shell.exec', { command: `step ${index}` }, 'x'.repeat(5000), `c${index}`);
      t.done(run);
    }
    const run = runOf(t);
    const id = `m${instruction.seq}`;
    assert.doesNotMatch(String(await tool('context.list').run({}, run)), new RegExp(`\\n${id} `));
    assert.match(String(await tool('context.condense').run({ id, text: 'export for Brightwave' }, run)), /stays as it is/);
    assert.match(String(await tool('context.hide').run({ ids: [id] }, run)), /left as they are/);
    assert.match(String(await tool('context.hide').run({ ids: [`m${yes.seq}`] }, run)), /left as they are/, 'the newest message too');
    assert.match(String(await tool('context.hide').run({ ids: [`m${old.seq}`] }, run)), /^hidden: /, 'what is older may go');
  } finally { t.cleanup(); }
});

test('a condensed item whose original is gone: the stamp no longer promises the way back, and the hidden one is not offered', async () => {
  const t = ledgerSetup({ budget: 1 });
  try {
    const run = t.turn(t.say('Do it.').seq);
    t.ourCall(run, 'shell.exec', { command: 'a' }, 'a'.repeat(9000), 'c1');
    t.ourCall(run, 'shell.exec', { command: 'b' }, 'b'.repeat(9000), 'c2');
    t.done(run);
    t.ledger.mark(t.tom.id, t.chat.id, [
      { itemId: 't1', state: 'condensed', condensed: 'a log', reason: 'old', by: 'subconscious' },
      { itemId: 't2', state: 'hidden', reason: 'old', by: 'subconscious' },
    ]);
    assert.match(t.ledger.view(t.tom.id, t.chat.id).find((item) => item.itemId === 't1')!.text, /"restore":"context\.restore"/, 'kept 14 days: the way back holds');
    assert.ok(marksOf(t.services, t.tom.id, t.chat.id).some((item) => item.itemId === 't2'));
    t.clock.advance(15 * 24 * 3600_000);
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 'm1', state: 'hidden', reason: 'a later mark runs the retention', by: 'subconscious' }]);
    assert.equal(t.ledger.original(t.tom.id, t.chat.id, 't1')?.pruned, true, 'retention took the condensed original');
    assert.equal(t.ledger.original(t.tom.id, t.chat.id, 't2')?.pruned, true, 'and the hidden one');
    assert.equal(marksOf(t.services, t.tom.id, t.chat.id).some((item) => item.itemId === 't2'), false, 'nothing to get back: not named');
    const view = t.ledger.view(t.tom.id, t.chat.id).find((item) => item.itemId === 't1')!;
    assert.doesNotMatch(view.text, /"restore"/);
    assert.match(view.text, /a log\n\{"compacted":"t1","was":"\d+ tokens","original":"gone"\}/);
    assert.equal(rebuildItems([view], 10).items[0].call?.output, view.text);
  } finally { t.cleanup(); }
});

test('a condensed chat line whose message is gone from retention keeps a stamp without the way back', () => {
  const t = ledgerSetup({ budget: 1 });
  try {
    const said = t.say(`A long request. ${'words '.repeat(200)}`);
    t.done(t.turn(said.seq));
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: `m${said.seq}`, state: 'condensed', condensed: 'a request', reason: 'old', by: 'subconscious' }]);
    t.db.run(`UPDATE context_items SET pruned_at = 1 WHERE item_id = ?`, [`m${said.seq}`]);
    const [line] = markedMessages(t.services, t.tom.id, t.chat.id, [said as Message]);
    assert.match(line.body, /a request\n\{"compacted":"m\d+","was":"\d+ tokens","original":"gone"\}/);
  } finally { t.cleanup(); }
});

/** A subconscious call as runAttempt journals it. */
function journalCall(t: ReturnType<typeof ledgerSetup>, runId: string, index: number, call: TraceCall): void {
  const callId = traceCallId(runId, index);
  t.journal.item(runId, { kind: 'tool_call', name: call.tool, idemKey: `${callId}:call`, effectStatus: 'none', data: { callId, args: JSON.stringify(call.args), summary: 'x', subconscious: true } });
  t.journal.item(runId, { kind: 'tool_result', name: call.tool, idemKey: `${callId}:result`, effectStatus: 'none', data: { callId, ok: true, summary: 'x', output: { content: [{ type: 'text', text: call.output }] } } });
}

test('stateless engine: a trace stays in the next turns, follows the marks, leaves out this run and stays bounded', () => {
  const t = ledgerSetup();
  try {
    const first = t.turn(t.say('Rechnungen?').seq, 'openai', 'openai:x');
    journalCall(t, first, 0, { tool: 'vector.search', args: { query: 'invoices', in: ['memory/company'] }, output: 'memory/company/billing.md: on the 3rd' });
    journalCall(t, first, 1, { tool: 'agent.tell', args: {}, output: 'Frau Berger bekommt die Mahnungen.' });
    t.done(first);
    t.ourCall(t.turn(t.say('Weiter.').seq, 'openai', 'openai:x'), 'shell.exec', { command: 'x' }, 'own work', 'c9');

    const calls = carriedCalls(t.services, t.tom.id, t.chat.id, 'run_other');
    assert.deepEqual(calls.map((call) => [call.tool, call.output]), [
      ['vector.search', 'memory/company/billing.md: on the 3rd'],
      ['agent.tell', 'Frau Berger bekommt die Mahnungen.'],
    ], 'only what the subconscious showed, oldest first, not the agent\'s own calls');
    assert.deepEqual(calls[0].args, { query: 'invoices', in: ['memory/company'] });
    assert.deepEqual(carriedCalls(t.services, t.tom.id, t.chat.id, first), [], 'a retry of the same run brings its own');

    const [search, tell] = t.ledger.items(t.tom.id, t.chat.id, { kinds: ['tool'] });
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: search.itemId, state: 'hidden', reason: 'old', by: 'subconscious' }, { itemId: tell.itemId, state: 'condensed', condensed: 'Berger: Mahnungen', reason: 'old', by: 'subconscious' }]);
    const marked = carriedCalls(t.services, t.tom.id, t.chat.id, 'run_other');
    assert.equal(marked.length, 1, 'hidden is out');
    assert.match(marked[0].output, /^Berger: Mahnungen\n\{"compacted":"/, 'condensed with its stamp');

    const later = t.turn(t.say('Noch mehr.').seq, 'openai', 'openai:x');
    for (let index = 0; index < 40; index++) journalCall(t, later, index, { tool: 'agent.tell', args: {}, output: `Note ${index}: ${'long text '.repeat(100)}` });
    const big = carriedCalls(t.services, t.tom.id, t.chat.id, 'run_other');
    const chars = big.reduce((sum, call) => sum + call.tool.length + JSON.stringify(call.args).length + call.output.length, 0);
    assert.ok(chars <= CARRIED_TOKENS * 4, String(chars));
    assert.match(big.at(-1)!.output, /^Note 39: /, 'the newest stay');
  } finally { t.cleanup(); }
});

function brain() {
  const calls: Array<Parameters<StructuredRunner>[0]> = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    const structured = { tool: 'done', args: '{}' };
    return { text: JSON.stringify(structured), structured, by: 'fake' };
  };
  return { runner, calls };
}

function groupSetup() {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const decision = brain();
  Object.assign(f.services, {
    vectors: { available: () => false, embed: async () => ({}), search: async () => ({}) },
    dispatcher: { activity: () => [] },
  });
  const subconscious = new SubconsciousImpl({ services: () => f.services, runner: decision.runner, llm: decision.runner, settleMs: 60_000, toolRetryMs: 1 });
  const chat = f.chats.create({ agentIds: [f.vid.id, f.manager.id], createdBy: 'human' });
  return { f, decision, subconscious, chat };
}

test('a chat of two agents: one agent nearing its limit is not lost because the other finished a turn next', async () => {
  const t = groupSetup();
  const said = t.f.chats.send({ conversationId: t.chat.id, authorId: 'human', body: 'Bitte beide die Rechnungen ansehen.' });
  t.subconscious.afterTurn({ agent: t.f.vid, conversationId: t.chat.id, fromSeq: 0, toSeq: said.seq, reply: 'Vid hat geschaut.', contextTokens: 190_000, contextWindow: 200_000 });
  t.subconscious.afterTurn({ agent: t.f.manager, conversationId: t.chat.id, fromSeq: 0, toSeq: said.seq, reply: 'Manager hat geschaut.', contextTokens: 1000, contextWindow: 200_000 });
  await t.subconscious.settle();
  const prompts = t.decision.calls.map((call) => call.prompt);
  assert.ok(prompts.some((prompt) => prompt.includes(`Agent: ${t.f.vid.name}`) && prompt.includes('190000')), prompts.join('\n---\n'));
  assert.ok(prompts.some((prompt) => prompt.includes(`Agent: ${t.f.manager.name}`)), prompts.join('\n---\n'));
});

test('one agent\'s burst in a chat of two still costs one run for that agent', async () => {
  const t = groupSetup();
  for (const body of ['Erste Nachricht mit Inhalt.', 'Zweite Nachricht mit Inhalt.']) {
    const said = t.f.chats.send({ conversationId: t.chat.id, authorId: 'human', body });
    t.subconscious.afterTurn({ agent: t.f.vid, conversationId: t.chat.id, fromSeq: said.seq - 1, toSeq: said.seq, reply: 'Ok.' });
  }
  await t.subconscious.settle();
  assert.equal(t.decision.calls.length, 1);
  assert.ok(t.decision.calls[0].prompt.includes('Erste Nachricht') && t.decision.calls[0].prompt.includes('Zweite Nachricht'));
});

test('the brains\' cost on a paid account reaches the spend journal; on a plan it does not', async () => {
  for (const [auth, expected] of [['api_key', 1], ['cli', 0]] as const) {
    const booked: Array<Record<string, unknown>> = [];
    const f = fixture();
    f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const engine = {
      id: 'compatible', caps: { sessions: false, structured: true },
      async run(_input: EngineTurnInput) {
        const structured = { tool: 'done', args: '{"answer":"Nichts."}' };
        return { text: JSON.stringify(structured), structured, stop: 'done', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.25 } };
      },
    } as unknown as Engine;
    Object.assign(f.services, {
      spend: { record: (entry: Record<string, unknown>) => { booked.push(entry); return undefined; } },
      vectors: { available: () => false },
      engines: { get: () => engine },
      accounts: { get: () => ({ id: 'acc', provider: 'p', auth }), markLimited() {}, markUnavailable() {}, updateLimits() {} },
      catalog: { get: () => ({ id: 'p:m', model: 'm', efforts: [] }), list: () => [{ id: 'p:m', available: true }] },
      router: { route: async (_request: RouteRequest) => ({ modelId: 'p:m', engine: 'compatible', accountId: 'acc', effort: 'low', category: 'cheap-chat', reason: 't', by: 'rules', alternatives: [] }) },
      paths: { ...f.services.paths, temp: path.join(RESOURCES, '..', 'test-results', 'helper-temp') },
    });
    const subconscious = new SubconsciousImpl({ services: () => f.services });
    assert.equal(await subconscious.ask({ agent: f.vid, ask: 'Was weißt du?', context: 'none' }), 'Nichts.\n\n(This answer used no tool, only the text it was given.)');
    assert.equal(booked.length, expected, auth);
    if (expected) {
      assert.equal(booked[0].amount, 0.25);
      assert.equal(booked[0].kind, 'tokens');
      assert.equal(booked[0].agentId, f.vid.id, 'it counts for the agent it ran for');
    }
  }
});

test('a brain on an engine runner reports what each attempt used', async () => {
  const used: unknown[] = [];
  const engine = { async run() { return { text: 'x', stop: 'done', usage: { inputTokens: 3, outputTokens: 1 } }; } } as unknown as Engine;
  const runner = createEngineRunner({
    engines: { get: () => engine } as never,
    router: { route: async () => ({ modelId: 'p:m', engine: 'compatible', accountId: 'acc', effort: 'low', category: 'cheap-chat', reason: 't', by: 'rules', alternatives: [] }) } as never,
    accounts: { get: () => ({ id: 'acc', provider: 'p', auth: 'api_key' }), markLimited() {}, markUnavailable() {}, updateLimits() {} } as never,
    catalog: { get: () => ({ id: 'p:m', model: 'm', efforts: [] }) } as never,
    paths: { temp: path.join(RESOURCES, '..', 'test-results', 'helper-temp') },
    clock: { now: () => 1 } as never,
    onUsage: (entry) => { used.push(entry); },
  });
  await runner({ purpose: 'subconscious', system: 's', prompt: 'p' });
  assert.equal(used.length, 1);
  assert.deepEqual((used[0] as { usage: unknown }).usage, { inputTokens: 3, outputTokens: 1 });
});

test('what the main AI asks back is never cut by the limit of a tool output: restore and answer stay below it', async () => {
  const t = ledgerSetup();
  try {
    for (let index = 1; index <= 5; index++) {
      const run = t.turn(t.say(`Step ${index} please, with some words.`).seq);
      t.ourCall(run, 'shell.exec', { command: `build ${index}` }, `${'log line\n'.repeat(1500)}THE END ${index}`, `c${index}`);
      t.done(run);
      t.clock.advance(1000);
    }
    await t.journal.settled();
    t.ledger.mark(t.tom.id, t.chat.id, ['t1', 't2', 't3'].map((itemId) => ({ itemId, state: 'condensed', condensed: 'a log', reason: 'old', by: 'subconscious' })));
    assert.ok(restoreItems(t.services, t.tom.id, t.chat.id, { ids: ['t1', 't2', 't3'] }).length < MAX_TEXT_CHARS);
    t.ledger.mark(t.tom.id, t.chat.id, ['t1', 't2', 't3'].map((itemId) => ({ itemId, state: 'condensed', condensed: 'a log', reason: 'again', by: 'agent' })));
    t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const steps = [{ tool: 'context.restore', args: JSON.stringify({ ids: ['t1', 't2', 't3'] }) }, { tool: 'done', args: JSON.stringify({ answer: 'Hier. '.repeat(2000) }) }];
    const runner: StructuredRunner = async () => { const structured = steps.shift(); return { text: JSON.stringify(structured), structured, by: 'fake' }; };
    const answer = await new SubconsciousImpl({ services: () => t.services, runner, settleMs: 0 }).ask({ agent: t.tom, conversationId: t.chat.id, ask: 'Hol sie zurück', context: 'none' });
    assert.ok(answer.length <= MAX_TEXT_CHARS, String(answer.length));
    assert.match(answer, /^Hier\. /);
    assert.match(answer, /THE END 1/);
  } finally { t.cleanup(); }
});
