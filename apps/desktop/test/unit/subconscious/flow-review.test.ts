// The review of the subconscious around the main AI: what it asks to get back comes back whole; a run whose place in the queue
// comes during a tool call waits; the same note or hit is not shown turn after turn; the person's newest message stays out of
// reach; a kept trace does not outlive a Forget; and the marks and the trace stay real pairs in a rebuilt history.
// Owns: these assertions only. Never: real models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RESOURCES, fixture } from '../context/fixture.ts';
import { ledgerSetup } from '../context/ledger-fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { AfterTurnRuns, type TurnEnd } from '../../../src/runtime/subconscious/after-turn.ts';
import { contextTools, savableTokens, WORTH_TOKENS } from '../../../src/runtime/subconscious/context-tools.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { wakeAfterTurn } from '../../../src/runtime/subconscious/wake.ts';
import type { FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { rebuildItems } from '../../../src/runtime/agents/rebuild-items.ts';
import { TRACE_TOKENS, capTrace } from '../../../src/shared/model/subconscious.ts';

const tool = (name: string) => contextTools.find((entry) => entry.name === name)!;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function scripted(steps: Array<{ tool: string; args?: Record<string, unknown> }>): StructuredRunner {
  return async () => {
    const next = steps.shift() ?? { tool: 'done' };
    return { text: '', structured: { tool: next.tool, args: JSON.stringify(next.args ?? {}) }, by: 'fake' };
  };
}

test('asking the subconscious to get something back: the original comes back whole, not cut to a trace', async () => {
  const t = ledgerSetup();
  try {
    for (let index = 1; index <= 4; index++) {
      const run = t.turn(t.say(`Step ${index} please, with some words.`).seq);
      t.ourCall(run, 'shell.exec', { command: `build ${index}` }, `${'log line\n'.repeat(800)}THE END ${index}`, `c${index}`);
      t.done(run);
      t.clock.advance(1000);
    }
    await t.journal.settled();
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 't1', state: 'condensed', condensed: 'build 1 log', reason: 'old', by: 'subconscious' }]);
    t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const impl = new SubconsciousImpl({ services: () => t.services, runner: scripted([{ tool: 'context.restore', args: { ids: ['t1'] } }, { tool: 'done' }]), settleMs: 0 });
    const answer = await impl.ask({ agent: t.tom, conversationId: t.chat.id, ask: 'Hol mir t1 zurück', context: 'none' });
    assert.ok(answer.length > TRACE_TOKENS * 4, `the answer holds ${answer.length} characters`);
    assert.match(answer, /THE END 1/);
  } finally { t.cleanup(); }
});

test('an automatic trace stays small and says when it is cut', () => {
  const capped = capTrace({ calls: [{ tool: 'context.restore', args: { ids: ['t1'] }, output: 'x'.repeat(TRACE_TOKENS * 10) }] });
  assert.match(capped.calls[0].output, /\[cut\]$/);
  assert.ok(capped.calls[0].output.length <= TRACE_TOKENS * 4);
});

const agentOf = (id: string) => ({ id, name: id }) as unknown as Agent;
const turnOf = (id: string, chat: string, fromSeq: number, toSeq: number): TurnEnd => ({ agent: agentOf(id), conversationId: chat, fromSeq, toSeq, reply: `reply of ${id}`, taskEnded: true });

test('a run whose place in the queue comes while a tool call of that chat waits goes back to waiting, with its whole range', async () => {
  let waiting = false;
  const services = {
    dispatcher: { activity: () => (waiting ? [{ agentId: 'b', conversationId: 'c2', toolCalls: 1 }] : []) },
    chats: { messages: () => [] },
    log: { debug() {} },
  };
  const ran: Array<{ id: string; from: number; to: number; context: string }> = [];
  let release = () => {};
  const runs = new AfterTurnRuns({
    services: () => services as never, settleMs: 0, toolRetryMs: 5,
    run: async ({ turn, context }) => {
      ran.push({ id: turn.agent.id, from: turn.fromSeq, to: turn.toSeq, context });
      if (turn.agent.id === 'a') await new Promise<void>((resolve) => { release = resolve; });
      return undefined;
    },
    keep: () => {},
  });
  runs.note(turnOf('a', 'c1', 0, 3));
  runs.note(turnOf('b', 'c2', 4, 9));
  await pause(20);
  assert.deepEqual(ran.map((run) => run.id), ['a'], 'one after another');
  waiting = true;
  release();
  await pause(30);
  assert.deepEqual(ran.map((run) => run.id), ['a'], 'never while the tool output is pending');
  waiting = false;
  await pause(40);
  assert.deepEqual(ran.map((run) => run.id), ['a', 'b']);
  assert.equal(ran[1].from, 4, 'its range is whole');
  assert.equal(ran[1].to, 9);
  assert.match(ran[1].context, /reply of b/);
});

function telling(steps: Array<{ tool: string; args?: Record<string, unknown> }>) {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const impl = new SubconsciousImpl({ services: () => f.services, runner: scripted(steps), settleMs: 0 });
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  const turn = () => ({ agent: f.vid, conversationId: chat.id, thread: chat.id, fromSeq: 0, toSeq: 0, reply: '', taskEnded: true });
  const before = () => impl.beforeTurn({ agent: f.vid, thread: chat.id });
  return { f, impl, turn, before };
}

test('the same note is not shown turn after turn; another note is', async () => {
  const told = { tool: 'agent.tell', args: { text: 'The invoices go out on the third.' } };
  const t = telling([told, { tool: 'done' }, told, { tool: 'done' }, { tool: 'agent.tell', args: { text: 'Another thing.' } }, { tool: 'done' }]);
  t.impl.afterTurn(t.turn());
  await t.impl.settle();
  assert.deepEqual((await t.before())?.calls.map((call) => call.output), ['The invoices go out on the third.']);
  t.impl.afterTurn(t.turn());
  await t.impl.settle();
  assert.equal(await t.before(), undefined, 'nothing new: nothing at all');
  t.impl.afterTurn(t.turn());
  await t.impl.settle();
  assert.deepEqual((await t.before())?.calls.map((call) => call.output), ['Another thing.']);
});

test('after a while the same note may come again (the context may have been renewed)', async () => {
  const told = { tool: 'agent.tell', args: { text: 'The invoices go out on the third.' } };
  const t = telling([told, { tool: 'done' }, told, { tool: 'done' }]);
  t.impl.afterTurn(t.turn());
  await t.impl.settle();
  assert.ok(await t.before());
  t.f.clock.advance(2 * 60 * 60_000);
  t.impl.afterTurn(t.turn());
  await t.impl.settle();
  assert.ok(await t.before());
});

test('a kept trace that mentions what the person forgot never reaches the main AI', async () => {
  const t = telling([{ tool: 'agent.tell', args: { text: 'Invoice INV-55821 is disputed.' } }, { tool: 'done' }]);
  t.impl.afterTurn(t.turn());
  await t.impl.settle();
  t.impl.forget((text) => text.includes('INV-55821'));
  assert.equal(await t.before(), undefined);
});

function runOf(t: ReturnType<typeof ledgerSetup>): FlowRun {
  return {
    services: t.services, agent: t.tom, conversationId: t.chat.id, thread: t.chat.id, kind: 'after-turn', signal: new AbortController().signal,
    hits: new Map(), searches: [], show: () => {}, route: () => {}, finish: () => {},
  } as unknown as FlowRun;
}

test('the person\'s newest message stays out of reach however many turns the work took since', async () => {
  const t = ledgerSetup();
  try {
    const first = t.turn(t.say('An older wish about the logo, long enough to be worth a look.').seq);
    t.done(first);
    t.clock.advance(1000);
    const said = t.say(`Build the whole invoice export for Brightwave and send it to Lea. ${'Details follow. '.repeat(40)}`);
    const second = t.turn(said.seq);
    t.done(second);
    for (let index = 0; index < 4; index++) {
      t.clock.advance(1000);
      const run = t.turn(said.seq);
      t.ourCall(run, 'shell.exec', { command: `step ${index}` }, 'x'.repeat(5000), `c${index}`);
      t.done(run);
    }
    const run = runOf(t);
    const newest = `m${said.seq}`;
    assert.doesNotMatch(String(await tool('context.list').run({}, run)), new RegExp(`\\n${newest} `), 'not even offered');
    assert.match(String(await tool('context.hide').run({ ids: [newest] }, run)), /left as they are/);
    assert.match(String(await tool('context.condense').run({ id: newest, text: 'export for Brightwave' }, run)), /stays as it is/);
    assert.equal(t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === newest)?.state, 'keep');
    assert.match(String(await tool('context.hide').run({ ids: [`m${said.seq - 1}`] }, run)), /^hidden: /, 'an older message may go');
  } finally { t.cleanup(); }
});

test('a condensed or hidden item never breaks a call from its output in a rebuilt history', async () => {
  const t = ledgerSetup();
  try {
    const run = t.turn(t.say('Do it.').seq);
    t.ourCall(run, 'shell.exec', { command: 'a' }, 'a'.repeat(5000), 'c1');
    t.ourCall(run, 'shell.exec', { command: 'b' }, 'b'.repeat(5000), 'c2');
    t.ourCall(run, 'shell.exec', { command: 'c' }, 'c'.repeat(5000), 'c3');
    t.done(run);
    t.ledger.mark(t.tom.id, t.chat.id, [
      { itemId: 't1', state: 'condensed', condensed: 'a log', reason: 'old', by: 'subconscious' },
      { itemId: 't2', state: 'hidden', reason: 'old', by: 'subconscious' },
    ]);
    const { items } = rebuildItems(t.ledger.view(t.tom.id, t.chat.id), 10);
    const calls = items.filter((item) => item.call);
    assert.deepEqual(calls.map((item) => item.call?.callId), ['c1', 'c3'], 'the hidden pair goes whole');
    assert.ok(calls.every((item) => item.call?.output), 'each call keeps an output');
    assert.match(calls[0].call!.output, /a log\n\{"compacted":"t1"/, 'the short text with its stamp under it');
  } finally { t.cleanup(); }
});

test('owner: small all the time, not at a limit: a person\'s message wakes a run, and every run has the transcript in front of it as soon as anything older could go', async () => {
  assert.equal(wakeAfterTurn({ said: 'Lies bitte die nächste Datei.', savable: 50_000 }, { turns: 0 }), 'person');
  const t = ledgerSetup();
  try {
    const seen: Array<{ why: string[]; transcript: boolean; context: string }> = [];
    const runs = new AfterTurnRuns({ services: () => t.services, settleMs: 0, keep: () => {}, run: async ({ why, transcript, context }) => { seen.push({ why, transcript, context }); return undefined; } });
    const turn = async (chars: number) => {
      const { seq } = t.say('Lies bitte die nächste Datei.');
      const run = t.turn(seq);
      t.ourCall(run, 'files.read', { path: `f${seq}` }, 'x'.repeat(chars));
      t.done(run);
      t.clock.advance(1000);
      await t.journal.settled();
      runs.note({ agent: t.tom, conversationId: t.chat.id, fromSeq: seq - 1, toSeq: seq, reply: 'Gelesen.', contextTokens: 30_000 });
      await runs.settle();
    };
    await turn(8000); await turn(8000);
    assert.equal(seen.at(-1)!.transcript, false, 'the newest 2 turns stay out of reach: nothing older yet');
    await turn(8000); await turn(8000);
    assert.deepEqual(seen.at(-1)!.why, ['person']);
    assert.equal(seen.at(-1)!.transcript, true, 'a 2k item is older now: no sum to reach first');
    assert.match(seen.at(-1)!.context, /What the person said earlier in this chat, not new:/);
    t.ledger.mark(t.tom.id, t.chat.id, t.ledger.items(t.tom.id, t.chat.id).filter((item) => item.tokens >= WORTH_TOKENS).map((item) => ({ itemId: item.itemId, state: 'hidden' as const, reason: 'test', by: 'subconscious' })));
    assert.equal(savableTokens(t.services, t.tom, t.chat.id), 0);
    runs.note({ agent: t.tom, conversationId: t.chat.id, fromSeq: 0, toSeq: 1, reply: 'Gelesen.', contextTokens: 50_000, switchPlanned: true });
    await runs.settle();
    assert.equal(seen.at(-1)!.transcript, false, 'nothing left to take off: only the exchange');
  } finally { t.cleanup(); }
});

test('live 01.11., q-r 03.11.: the rules name the vector tools in one line, as a reference and not a procedure, only where word search is offered too', () => {
  const rules = new PromptTemplates(() => path.join(RESOURCES, 'prompts')).text('rules');
  assert.match(rules, /\{\{#has_files_search\}\}[^{]*vector\.search finds what vector\.embed made searchable[^{]*\{\{\/has_files_search\}\}/);
  assert.doesNotMatch(rules, /vector\.embed once|then vector\.search|grep only/, 'no order of steps (owner\'s rule (f))');
});

test('live 01.11.: a run starts with the older items, without a model, whatever woke it', async () => {
  const t = ledgerSetup();
  try {
    for (let index = 1; index <= 4; index++) {
      const run = t.turn(t.say(`Step ${index} please, with some words.`).seq);
      t.ourCall(run, 'shell.exec', { command: `build ${index}` }, `${'log line\n'.repeat(4000)}THE END ${index}`, `c${index}`);
      t.done(run);
      t.clock.advance(1000);
    }
    await t.journal.settled();
    t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const prompts: string[] = [];
    const runner: StructuredRunner = async ({ prompt }) => { prompts.push(prompt); return { text: '', structured: { tool: 'done', args: '{}' }, by: 'fake' }; };
    const impl = new SubconsciousImpl({ services: () => t.services, runner, settleMs: 0 });
    const end = { agent: t.tom, conversationId: t.chat.id, fromSeq: 0, toSeq: 1, reply: 'Done.' };
    impl.afterTurn({ ...end, contextTokens: 40_000 });
    await impl.settle();
    assert.match(prompts[0], /woken by person; the main AI's context holds about 40000 tokens. My first step lists the older items/, 'no threshold: every run with something older has the list and what it is for');
    assert.doesNotMatch(prompts[0], /result the chat already states/);
    assert.match(prompts[0], /context\.list \{"minTokens":500\}\n\d+ older items in full/);
    assert.match(prompts[0], /\nt1 tool \d+t/);
    impl.afterTurn({ ...end, contextTokens: 41_000 });
    await impl.settle();
    assert.equal(prompts.length, 1, 'those items were looked at');
    const { seq } = t.say('Noch eine Frage zum Bericht bitte.');
    impl.afterTurn({ ...end, fromSeq: seq - 1, toSeq: seq, contextTokens: 41_000 });
    await impl.settle();
    assert.match(prompts[1], /woken by person/);
    assert.match(prompts[1], /context\.list/, 'a wake by the person has the list too while anything older could go');
  } finally { t.cleanup(); }
});

test('live 01.11.: the brains are told their tools are no functions: a model that tried real function calls got refusals, looped until the time limit or said the search was unavailable', () => {
  const prompt = new PromptTemplates(() => path.join(RESOURCES, 'prompts')).text('subconscious');
  assert.match(prompt, /I call no functions/);
  assert.doesNotMatch(prompt, /tool call as JSON/);
});

test('live 01.11.: a run with the transcript before it sees what the person said about it earlier; with nothing left to take off only the exchange', async () => {
  const t = ledgerSetup();
  try {
    t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const prompts: string[] = [];
    const runner: StructuredRunner = async ({ prompt }) => { prompts.push(prompt); return { text: '', structured: { tool: 'done', args: '{}' }, by: 'fake' }; };
    const impl = new SubconsciousImpl({ services: () => t.services, runner, settleMs: 0 });
    t.say('Die großen alten Ausgaben bitte verdichten, nicht ausblenden.');
    for (let index = 0; index < 4; index++) {
      const run = t.turn(t.say(`Datei ${index} bitte.`).seq);
      t.ourCall(run, 'files.read', { path: `f${index}` }, 'x'.repeat(index < 2 ? 24_000 : 100));
      t.done(run);
      t.clock.advance(1000);
    }
    await t.journal.settled();
    const from = t.say('Und jetzt die nächste Frage dazu.').seq;
    const last = t.say('Eine ganz andere Frage noch.').seq;
    impl.afterTurn({ agent: t.tom, conversationId: t.chat.id, fromSeq: from, toSeq: last, reply: 'Antwort.', switchPlanned: true });
    await impl.settle();
    assert.match(prompts[0], /verdichten, nicht ausblenden/);
    prompts.length = 0;
    t.ledger.mark(t.tom.id, t.chat.id, t.ledger.items(t.tom.id, t.chat.id).filter((item) => item.tokens >= 500).map((item) => ({ itemId: item.itemId, state: 'hidden' as const, reason: 'test', by: 'subconscious' })));
    const next = t.say('Noch eine Frage mit Inhalt, bitte.').seq;
    impl.afterTurn({ agent: t.tom, conversationId: t.chat.id, fromSeq: last, toSeq: next, reply: 'Antwort.' });
    await impl.settle();
    assert.doesNotMatch(prompts[0], /verdichten, nicht ausblenden/);
  } finally { t.cleanup(); }
});
