// What makes a run land (subconscious/flow.ts, tools.ts, context-tools.ts, service.ts, live findings of 02.11.2026): a repeated call gets no
// second answer, a stuck model call ends a step and the run keeps what it did, what the run noticed travels with what it shows, memory holds what
// was said here in the language of the exchange, the person's name is no part of the look before a turn, a tidy run sees a compact
// view and what it costs against what it saves, and the prompt orders no search and carries nothing of a test or one engine's files.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RESOURCES, fixture } from '../context/fixture.ts';
import { ledgerSetup } from '../context/ledger-fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { runFlow, type FlowBrains } from '../../../src/runtime/subconscious/flow.ts';
import { contextTools, savableTokens, WORTH_TOKENS } from '../../../src/runtime/subconscious/context-tools.ts';
import { knownShare } from '../../../src/runtime/subconscious/text.ts';
import { createEngineRunner } from '../../../src/runtime/decision/engine-runner.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import type { RouteRequest, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Engine, EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { VectorSearchInput } from '../../../src/shared/model/vectors.ts';
import { tmpdir } from 'node:os';

type Scripted = { tool: string; args?: Record<string, unknown> };

function brain(steps: Scripted[], usage?: { inputTokens: number; outputTokens: number }) {
  const prompts: string[] = [];
  const runner: StructuredRunner = async ({ prompt }) => {
    prompts.push(prompt);
    const next = steps.shift() ?? { tool: 'done' };
    const structured = { tool: next.tool, args: JSON.stringify(next.args ?? {}) };
    return { text: JSON.stringify(structured), structured, by: 'fake', ...(usage ? { usage } : {}) };
  };
  return { runner, prompts };
}

function world() {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const searches: VectorSearchInput[] = [];
  const written: Array<{ title: string; text: string; folder?: string }> = [];
  Object.assign(f.services, {
    vectors: {
      available: () => true,
      embed: async () => ({ embedded: 1, reembedded: 0, unchanged: 0, skipped: [] }),
      search: async (input: VectorSearchInput) => {
        searches.push(input);
        return { hits: [{ path: 'memory/company/billing.md', chunk: 0, snippet: 'Invoices go out by post only.', score: 0.9 }], searched: { places: input.in, embeddedFiles: 1 } };
      },
    },
    knowledge: { memoryWrite: (input: { title: string; text: string; folder?: string }) => { written.push(input); return { path: 'x.md', outcome: 'created' }; } },
  } as unknown as Partial<RuntimeServices>);
  return { f, searches, written };
}

const flow = (t: ReturnType<typeof world>, brains: FlowBrains, input: Partial<Parameters<typeof runFlow>[2]> = {}) =>
  runFlow(t.f.services, brains, { kind: 'after-turn', agent: t.f.vid, thread: 'th', ...input });

test('a call repeated with nothing changed gets no second answer, and a second such call ends the run', async () => {
  const t = world();
  const search = { tool: 'vector.search', args: { query: 'Rechnungen', in: ['memory'] } };
  const decision = brain([search, search, search, search]);
  const result = await flow(t, { decision: decision.runner });
  assert.equal(result.end, 'steps');
  assert.equal(decision.prompts.length, 3, 'the first answer, the note, the end');
  assert.match(decision.prompts[2], /Nothing changed since I made this same call/);
});

test('the same call after something changed is no repeat', async () => {
  const t = world();
  let n = 0;
  (t.f.services.vectors as unknown as { search: () => Promise<unknown> }).search = async () => ({ hits: [], searched: { places: [], embeddedFiles: 1 }, note: `${++n} files changed.` });
  const search = { tool: 'vector.search', args: { query: 'Rechnungen', in: ['memory'] } };
  const decision = brain([search, search, { tool: 'done' }]);
  const result = await flow(t, { decision: decision.runner });
  assert.equal(result.end, 'done');
  assert.doesNotMatch(decision.prompts[2], /Nothing changed/);
});

test('a stuck model call ends at the step limit: the other brain goes on and what the run did stays', async () => {
  const t = world();
  const seen: Array<AbortSignal | undefined> = [];
  const steps: Scripted[] = [{ tool: 'agent.tell', args: { text: 'Die Rechnung ist schon raus.' } }];
  const stuck: StructuredRunner = ({ signal, deadlineMs }) => {
    seen.push(signal);
    assert.equal(deadlineMs, 20);
    const next = steps.shift();
    if (next) { const structured = { tool: next.tool, args: JSON.stringify(next.args ?? {}) }; return Promise.resolve({ text: '', structured, by: 'fake' }); }
    return new Promise((_, reject) => { signal!.addEventListener('abort', () => reject(new Error('The turn was stopped.'))); });
  };
  const llm = brain([{ tool: 'done' }]);
  const started = Date.now();
  const result = await flow(t, { decision: stuck, llm: llm.runner }, { stepMs: 20 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.end, 'done');
  assert.equal(llm.prompts.length, 1, 'the LLM took over');
  assert.ok(llm.prompts[0].includes('agent.tell'), 'it sees what was done');
  assert.deepEqual(result.trace.calls.map((call) => call.output), ['Die Rechnung ist schon raus.']);
});

test('two stuck calls end the run as failed, with what it did', async () => {
  const t = world();
  const steps: Scripted[] = [{ tool: 'agent.tell', args: { text: 'Eine Notiz.' } }];
  const stuck: StructuredRunner = ({ signal }) => {
    const next = steps.shift();
    if (next) { const structured = { tool: next.tool, args: JSON.stringify(next.args ?? {}) }; return Promise.resolve({ text: '', structured, by: 'fake' }); }
    return new Promise((_, reject) => { signal!.addEventListener('abort', () => reject(new Error('stopped'))); });
  };
  const result = await flow(t, { decision: stuck }, { stepMs: 10 });
  assert.equal(result.end, 'failed');
  assert.equal(result.trace.calls.length, 1);
});

test('a helper call that hangs inside a condensation: what is condensed so far stays and the brain hears the rest', async () => {
  const t = ledgerSetup();
  try {
    await fourTurns(t);
    let words = 0;
    const run = {
      services: t.services, agent: t.tom, conversationId: t.chat.id, thread: t.chat.id, kind: 'after-turn', signal: new AbortController().signal, hits: new Map(), searches: [], restored: new Set<string>(),
      word: async () => { if (++words > 1) throw new Error('structured runner: The turn was stopped.'); return 'build 1 finished in 401 seconds'; }, show: () => {}, route: () => {}, finish: () => {},
    } as unknown as FlowRun;
    const said = String(await contextTools.find((tool) => tool.name === 'context.condense')!.run({ ids: ['t1', 't2'] }, run));
    assert.match(said, /condensed t1/);
    assert.match(said, /t2 not condensed: structured runner/);
    assert.equal(t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === 't1')?.state, 'condensed');
  } finally { t.cleanup(); }
});

test('what the run noticed travels with the hit it shows, first, so a cut keeps it', async () => {
  const t = world();
  const hits = Array.from({ length: 8 }, (_, chunk) => ({ path: 'memory/company/billing.md', chunk, snippet: 'Rechnungen nur per Post. '.repeat(20), score: 0.9 }));
  t.f.services.vectors.search = async (input: VectorSearchInput) => ({ hits, searched: { places: input.in, embeddedFiles: 1 } });
  const decision = brain([{ tool: 'vector.search', args: { query: 'Versand', in: ['memory'] } }, { tool: 'done', args: { show: hits.map((_, index) => `h${index + 1}`), note: 'Gewünscht ist E-Mail, die Regel sagt Post.' } }]);
  const result = await flow(t, { decision: decision.runner }, { kind: 'before-turn' });
  assert.equal(result.trace.calls[0].tool, 'vector.search');
  assert.ok(result.trace.calls[0].output.startsWith('Noticed, to tell the person when I answer: Gewünscht ist E-Mail, die Regel sagt Post.\n'), result.trace.calls[0].output.slice(0, 120));
  assert.ok(result.trace.calls[0].output.endsWith('[cut]'));
});

test('what a run noticed goes only with what it shows: alone it reaches the main AI only when the main AI asked', async () => {
  const t = world();
  const noted = await flow(t, { decision: brain([{ tool: 'done', args: { note: 'Der Vertrag läuft aus.' } }]).runner });
  assert.deepEqual(noted.trace.calls, []);
  assert.deepEqual((await flow(t, { decision: brain([{ tool: 'done' }]).runner })).trace.calls, []);
  const asked = await flow(t, { decision: brain([{ tool: 'done', args: { answer: 'Ja.', note: 'Der Vertrag läuft aus.' } }]).runner }, { kind: 'asked', task: 'Was ist bekannt?' });
  assert.deepEqual(asked.trace.calls.map((call) => call.tool), ['subconscious']);
  assert.match(asked.answer, /Noticed, to tell the person when I answer: Der Vertrag läuft aus\./);
});

test('memory holds what was said here: a text from elsewhere or in another language is not written, what the exchange says is', async () => {
  const t = world();
  const context = 'The person: Wichtig für unsere Firma: Große Rechnungen über fünftausend Euro prüft künftig immer Frau Berger persönlich, bevor sie rausgehen.';
  const foreign = { tool: 'memory.write', args: { title: 'Arbeitsweise des Managers', text: 'Der Manager soll objektiv vorgehen und bei Problemen möglichst viel selbstständig lösen, bevor er um Hilfe bittet.' } };
  const english = { tool: 'memory.write', args: { title: 'Invoice approval by Ms Berger', text: 'Large invoices above five thousand euros are always reviewed personally by Ms Berger before dispatch.' } };
  const german = { tool: 'memory.write', args: { title: 'Prüfung großer Rechnungen', text: 'Rechnungen über fünftausend Euro prüft künftig immer Frau Berger persönlich, bevor sie rausgehen.' } };
  const decision = brain([foreign, english, german]);
  await flow(t, { decision: decision.runner }, { context });
  assert.deepEqual(t.written.map((item) => item.title), ['Prüfung großer Rechnungen']);
  assert.match(decision.prompts[1], /Not written: most of this text is not in what happened/);
  assert.match(decision.prompts[2], /Not written/);
});

test('the run before a turn keeps nothing', async () => {
  const t = world();
  const decision = brain([{ tool: 'memory.write', args: { title: 'Filiale Bonn', text: 'Frau Sommer leitet ab Januar die Filiale in Bonn.' } }]);
  await flow(t, { decision: decision.runner }, { kind: 'before-turn', context: 'The person: Frau Sommer leitet ab Januar die Filiale in Bonn.' });
  assert.deepEqual(t.written, []);
  assert.match(decision.prompts[1], /Not written: this run keeps nothing/);
});

test('nothing hands an answer to the LLM by its length: the brain that holds the flow decides', async () => {
  const t = world();
  const long = 'Die Lindner Feinmechanik will Angebote immer auf Englisch. '.repeat(8);
  const llm = brain([{ tool: 'done', args: { answer: 'Kürzer und besser.' } }]);
  const result = await flow(t, { decision: brain([{ tool: 'done', args: { answer: long } }]).runner, llm: llm.runner }, { kind: 'asked', task: 'Was ist bekannt?' });
  assert.equal(llm.prompts.length, 0);
  assert.ok(result.answer.startsWith(long.trim()));
});

test('what a tool returned counts as known, and a short text is no case for the check', async () => {
  const t = world();
  t.f.services.vectors.search = async (input: VectorSearchInput) => ({ hits: [{ path: 'memory/company/billing.md', chunk: 0, snippet: 'Frankfurter Niederlassung übernimmt Abrechnung sämtlicher Lieferanten künftig zentral', score: 0.9 }], searched: { places: input.in, embeddedFiles: 1 } });
  const decision = brain([
    { tool: 'vector.search', args: { query: 'Abrechnung', in: ['memory'] } },
    { tool: 'memory.write', args: { title: 'Abrechnung', text: 'Frankfurter Niederlassung übernimmt Abrechnung sämtlicher Lieferanten zentral.' } },
    { tool: 'memory.write', args: { title: 'Kurz', text: 'Etwas ganz anderes.' } },
  ]);
  await flow(t, { decision: decision.runner }, { context: 'The person: Wer rechnet ab?' });
  assert.equal(t.written.length, 2);
});

test('the word check goes by stems, and leaves scripts without spaces alone', () => {
  assert.equal(knownShare('Große Ausgaben sollen verdichtet werden, Stichworte bleiben stehen', 'Große Ausgabe sollen verdichten, Stichwort bleibt stehend'), 1);
  assert.equal(knownShare('输出应当被压缩而不是隐藏,关键词要保留', '用户希望旧输出被压缩而不是隐藏,保留关键词以便之后查找'), undefined);
  assert.ok(knownShare('nur etwas Deutsch hier und sonst nichts', 'Large invoices above thousand euros always reviewed') === 0);
});

test('the look before a turn sees a neutral label, no name and no place to search; a run that writes down has the name once and this chat\'s folder to write in', async () => {
  const t = world();
  const chat = t.f.chats.create({ agentIds: [t.f.vid.id], createdBy: 'human' });
  t.f.chats.send({ conversationId: chat.id, authorId: 'human', authorKind: 'human', body: 'Was ist die Wurzel aus 144?' });
  const decision = brain([{ tool: 'done' }]);
  const impl = new SubconsciousImpl({ services: () => t.f.services, runner: decision.runner, settleMs: 0, beforeWaitMs: 1000 });
  await impl.beforeTurn({ agent: t.f.vid, thread: chat.id, conversationId: chat.id, said: 'Was ist die Wurzel aus 144?' });
  assert.ok(decision.prompts[0].includes('The person: Was ist die Wurzel aus 144?'), decision.prompts[0]);
  assert.ok(!decision.prompts[0].includes(t.f.profile.name), decision.prompts[0]);
  assert.ok(!/Memory folders|memory\/company|memory\/chats/.test(decision.prompts[0]), decision.prompts[0]);
  const after = brain([{ tool: 'done' }]);
  await flow(t, { decision: after.runner }, { conversationId: chat.id, context: 'The person: Ja.' });
  assert.ok(after.prompts[0].includes(`The person: ${t.f.profile.name}`));
  assert.match(after.prompts[0], new RegExp(`Memory folders to write in: company, .*chats/${chat.id}`));
  assert.ok(!/memory\/company|memory\/chats/.test(after.prompts[0]), 'folders to write in, no place to search');
});

test('a tidy run: the view is compact and shows only what is left, the mark says what is still big, the run counts what it costs against what it saves', async () => {
  const t = ledgerSetup();
  try {
    await fourTurns(t);
    assert.ok(savableTokens(t.services, t.tom, t.chat.id) >= 2 * WORTH_TOKENS);
    t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const decision = brain([{ tool: 'context.condense', args: { ids: ['t1'] } }, { tool: 'context.hide', args: { ids: ['t2'] } }, { tool: 'done' }], { inputTokens: 1000, outputTokens: 50 });
    const wording: StructuredRunner = async () => ({ text: '', structured: { text: 'build 1 finished in 401 seconds' }, by: 'fake', usage: { inputTokens: 700, outputTokens: 20 } });
    const brains: FlowBrains = { decision: async (input) => (input.schema && 'properties' in input.schema && (input.schema as { properties: Record<string, unknown> }).properties.text ? wording(input) : decision.runner(input)) };
    const result = await runFlow(t.services, brains, { kind: 'after-turn', agent: t.tom, conversationId: t.chat.id, thread: t.chat.id, firstStep: { tool: 'context.list', args: { minTokens: WORTH_TOKENS } } });
    assert.equal(result.end, 'done');
    assert.match(decision.prompts[0], /context\.list \{"minTokens":500\}\n\d+ older items in full/);
    assert.match(decision.prompts[1], /condensed t1: about \d+ tokens saved at the main AI's next turn\nStill big: t2 \d+t\./);
    assert.match(decision.prompts[2], /hidden: t2\nNothing big is left in full\./);
    assert.equal(result.used, 3 * 1050 + 720);
    assert.ok(result.saved > 2 * WORTH_TOKENS, String(result.saved));
    assert.equal(savableTokens(t.services, t.tom, t.chat.id), 0);
    // q-r2c (03.11.2026): a tidy run's list holds what could still come off – with the marked items in it, the cheap model hid them all and
    // condensed the hidden ones back, turn after turn.
    const tidy = String(await contextTools.find((tool) => tool.name === 'context.list')!.run({ minTokens: WORTH_TOKENS }, runOf(t, 'after-turn')));
    assert.doesNotMatch(tidy, /\nt[12] tool/, 'what takes less than minTokens now is not offered');
    // q-r1b2 (03.11.2026): marked items as bare ids – a run could not take a condensed file out on the person's word, nor bring it back.
    const again = String(await contextTools.find((tool) => tool.name === 'context.list')!.run({}, runOf(t, 'after-turn')));
    // q-r2a: with its old size a hidden item read as big and was condensed again: a marked item says what it takes now.
    assert.match(again, /\nt1 tool condensed \d+t \(was \d+t\) shell\.exec/, 'a marked item stands with its state, its size now and its words');
    assert.match(again, /\nt2 tool hidden \(was \d+t\) shell\.exec/);
    assert.doesNotMatch(again, /Already condensed or hidden/);
    const asked = String(await contextTools.find((tool) => tool.name === 'context.list')!.run({}, runOf(t, 'asked')));
    assert.match(asked, /\nt1 tool condensed \d+t/, 'the main AI looking for what is gone sees it');
    assert.match(asked, /\nt2 tool hidden/);
  } finally { t.cleanup(); }
});

test('no chat or no ledger: nothing to take off, and the check never throws', () => {
  const t = world();
  assert.equal(savableTokens(t.f.services, t.f.vid, undefined), 0);
  assert.equal(savableTokens({} as RuntimeServices, t.f.vid, 'ch_x'), 0);
});

test('an engine\'s usage reaches the flow through the runner', async () => {
  const f = fixture();
  const engine = { run: async (_input: EngineTurnInput) => ({ text: '', structured: { tool: 'done', args: '{}' }, stop: 'done' as const, usage: { inputTokens: 5100, outputTokens: 40 } }) } as unknown as Engine;
  const runner = createEngineRunner({
    engines: { get: () => engine } as never, clock: f.services.clock, paths: { temp: tmpdir() } as never,
    router: { route: async (_request: RouteRequest) => ({ modelId: 'p:m', engine: 'compatible', accountId: 'acc', effort: 'low', category: 'cheap-chat', reason: '', by: 'rules', alternatives: [] }) } as never,
    accounts: { get: () => ({ id: 'acc' }), updateLimits: () => {}, markLimited: () => {}, markUnavailable: () => false } as never,
    catalog: { get: () => ({ id: 'p:m', model: 'm', efforts: ['low'] }) } as never,
  });
  const reply = await runner({ purpose: 'subconscious', system: 's', prompt: 'p', schema: { type: 'object' } });
  assert.deepEqual(reply.usage, { inputTokens: 5100, outputTokens: 40 });
});

test('a kept pair stands in front of the chat line of its turn, as the engine holds it, also in a rebuild\'s order', async () => {
  const t = ledgerSetup();
  try {
    const { seq } = t.say('Schreib mir bitte den Text.');
    t.journal.start({ id: 'run_kept', agentId: t.tom.id, conversationId: t.chat.id, trigger: 'message' });
    t.ledger.capture({ runId: 'run_kept', agentId: t.tom.id, conversationId: t.chat.id, engine: 'codex', model: 'openai:gpt-5.5', seenSeq: seq, first: () => t.ourCall('run_kept', 'vector.search', { query: 'Versand' }, 'Rechnungen nur per Post.', 'sc_run_kept_0') });
    t.ourCall('run_kept', 'files.read', { path: 'a.md' }, 'Inhalt.');
    t.done('run_kept');
    await t.journal.settled();
    const ids = t.ledger.items(t.tom.id, t.chat.id).sort((a, b) => a.order - b.order).map((item) => item.kind);
    assert.deepEqual(ids.slice(0, 2), ['tool', 'message'], ids.join(' '));
  } finally { t.cleanup(); }
});

test('the prompt orders no search, names no place and carries nothing of a test or one engine\'s files; it is shorter than it was', () => {
  const text = new PromptTemplates(() => path.join(RESOURCES, 'prompts')).text('subconscious');
  for (const gone of ['without looking anything up', 'a greeting', 'plain arithmetic', 'general how-to', 'AGENTS.md', 'environment line', 'So you search', 'Search all of', 'search whenever']) assert.ok(!text.includes(gone), gone);
  assert.match(text, /done\.note/);
  assert.match(text, /LLM is the stronger model/);
  assert.ok(text.length < 6300, String(text.length)); // 4,992 + the before-turn skill tip (B-066 wish 1) + what they want to see first (B-072) + B-078 D14: own thoughts, the one catalog, the main AI's prompt below (6,124)
});

/** Four finished turns, each with one long tool output: t1 and t2 are older than the newest 2 turns. */
async function fourTurns(t: ReturnType<typeof ledgerSetup>): Promise<void> {
  for (let index = 1; index <= 4; index++) {
    const run = t.turn(t.say(`Step ${index} please, with some words.`).seq);
    t.ourCall(run, 'shell.exec', { command: `build ${index}` }, `build ${index} finished in 40${index} seconds\n${'log line\n'.repeat(1500)}`, `c${index}`);
    t.done(run);
    t.clock.advance(1000);
  }
  await t.journal.settled();
}

function runOf(t: ReturnType<typeof ledgerSetup>, kind: FlowRun['kind']): FlowRun {
  return { services: t.services, agent: t.tom, conversationId: t.chat.id, thread: t.chat.id, kind, signal: new AbortController().signal, hits: new Map(), searches: [], show: () => {}, route: () => {}, finish: () => {} } as unknown as FlowRun;
}
