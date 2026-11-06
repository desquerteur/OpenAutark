// The run before a turn (subconscious/service.ts lookFirst): a person's message with content wakes it, the model decides, the turn waits a
// bounded time and what comes later waits for the next turn. Marking (context-tools.ts): context.condense words whole originals through
// the LLM in one call; a brain's context.restore undoes without a pin and shows nothing unless done.show names it. A kept output of an
// engine's own tool stays whole in a rebuild.
// Owns: these assertions only. Never: real models or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RESOURCES } from '../context/fixture.ts';
import { ledgerSetup } from '../context/ledger-fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { contextTools } from '../../../src/runtime/subconscious/context-tools.ts';
import { runFlow } from '../../../src/runtime/subconscious/flow.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import type { FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { TraceCall } from '../../../src/shared/model/subconscious.ts';

const tool = (name: string) => contextTools.find((entry) => entry.name === name)!;

/** A brain answering step by step; after its script it says done. */
function scripted(steps: Array<{ tool: string; args?: Record<string, unknown> }>) {
  const calls: Array<Parameters<StructuredRunner>[0]> = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    const next = steps.shift() ?? { tool: 'done' };
    const structured = { tool: next.tool, args: JSON.stringify(next.args ?? {}) };
    return { text: JSON.stringify(structured), structured, by: 'fake' };
  };
  return { runner, calls };
}

/** Four finished turns, each with one long tool output: t1 and t2 are older than the newest 2 turns. */
function fourTurns(t: ReturnType<typeof ledgerSetup>): void {
  for (let index = 1; index <= 4; index++) {
    const run = t.turn(t.say(`Step ${index} please, with some words.`).seq);
    t.ourCall(run, 'shell.exec', { command: `build ${index}` }, `build ${index} finished in 40${index} seconds\n${'log line\n'.repeat(400)}THE END ${index}`, `c${index}`);
    t.done(run);
    t.clock.advance(1000);
  }
}

function runOf(t: ReturnType<typeof ledgerSetup>, kind: FlowRun['kind'], word?: FlowRun['word']): { run: FlowRun; shown: TraceCall[] } {
  const shown: TraceCall[] = [];
  const run = {
    services: t.services, agent: t.tom, conversationId: t.chat.id, thread: t.chat.id, kind, signal: new AbortController().signal,
    hits: new Map(), searches: [], restored: new Set<string>(), word, show: (call: TraceCall) => { shown.push(call); }, route: () => {}, finish: () => {},
  } as unknown as FlowRun;
  return { run, shown };
}

function look(t: ReturnType<typeof ledgerSetup>, brain: StructuredRunner, beforeWaitMs = 1000) {
  t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  Object.assign(t.services, {
    dispatcher: { activity: () => [] },
    catalog: { list: () => [] },
    vectors: {
      available: () => true,
      search: async (input: { in: string[] }) => ({ hits: [{ path: 'memory/company/post.md', chunk: 0, snippet: 'Rechnungen an Müller nur per Post.', score: 0.8 }], searched: { places: input.in, embeddedFiles: 1 } }),
    },
  });
  const impl = new SubconsciousImpl({ services: () => t.services, runner: brain, beforeWaitMs });
  return (said: string | undefined) => impl.beforeTurn({ agent: t.tom, thread: t.chat.id, conversationId: t.chat.id, said });
}

test('a person\'s message with content: the run looks before the turn, its find is this turn\'s trace; the model chose query and place', async () => {
  const t = ledgerSetup();
  try {
    t.say('Die Rechnung an Müller geht morgen per E-Mail raus.');
    const brain = scripted([{ tool: 'vector.search', args: { query: 'Wie gehen Rechnungen an Müller raus?', in: ['memory/company/rechnungen'] } }, { tool: 'done', args: { show: ['h1'] } }]);
    const trace = await look(t, brain.runner)('Die Rechnung an Müller geht morgen per E-Mail raus.');
    assert.equal(trace?.calls[0].tool, 'vector.search');
    assert.deepEqual(trace?.calls[0].args, { query: 'Wie gehen Rechnungen an Müller raus?', in: ['memory/company/rechnungen'] });
    assert.match(trace!.calls[0].output, /nur per Post/);
    assert.match(brain.calls[0].prompt, /^Run: before-turn/);
    assert.match(brain.calls[0].prompt, /per E-Mail raus/, 'it reads what the person wrote');
    assert.doesNotMatch(brain.calls[0].prompt, /first step/, 'no code orders a search');
  } finally { t.cleanup(); }
});

test('no model before a bare go-ahead, without a person\'s words, or while a tool call waits; a run that does nothing leaves nothing', async () => {
  const t = ledgerSetup();
  try {
    const brain = scripted([]);
    const before = look(t, brain.runner);
    assert.equal(await before('ja bitte'), undefined);
    assert.equal(await before(undefined), undefined);
    assert.equal(brain.calls.length, 0);
    assert.equal(await before('Was denkst du über das neue Angebot?'), undefined);
    assert.equal(brain.calls.length, 1, 'with content the model decides; it said done');
    Object.assign(t.services, { dispatcher: { activity: () => [{ agentId: t.tom.id, conversationId: t.chat.id, toolCalls: 1 }] } });
    assert.equal(await before('Was denkst du über das neue Angebot?'), undefined);
    assert.equal(brain.calls.length, 1, 'never while a tool call waits for its output');
  } finally { t.cleanup(); }
});

test('a slow run: the turn goes on after the wait, the run goes on too and its find waits for the next turn', async () => {
  const t = ledgerSetup();
  try {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const steps = [{ tool: 'agent.tell', args: { text: 'Müller nur per Post.' } }, { tool: 'done' }];
    const brain: StructuredRunner = async () => { await gate; const structured = { tool: steps[0].tool, args: JSON.stringify(steps.shift()!.args ?? {}) }; return { text: JSON.stringify(structured), structured, by: 'fake' }; };
    const before = look(t, brain, 5);
    assert.equal(await before('Die Rechnung an Müller geht morgen per E-Mail raus.'), undefined, 'this turn did not wait for it');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = await before(undefined);
    assert.deepEqual(next?.calls.map((call) => [call.tool, call.output]), [['subconscious', 'Müller nur per Post.']]);
  } finally { t.cleanup(); }
});

test('a look before a turn: a slow step is not cut at the wait of the turn, only a hang is cut', async () => {
  const t = ledgerSetup();
  try {
    const limits: Array<number | undefined> = [];
    const brain: StructuredRunner = async (input) => { limits.push(input.deadlineMs); const structured = { tool: 'done', args: '{}' }; return { text: JSON.stringify(structured), structured, by: 'fake' }; };
    await look(t, brain)('Die Rechnung an Müller geht morgen per E-Mail raus.');
    assert.equal(limits.length, 1);
    assert.ok(limits[0]! >= 180_000, String(limits[0]));
  } finally { t.cleanup(); }
});

test('context.condense: several ids in one call, the LLM reads the whole original, the stamp stands in the view, protection holds', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    const asked: string[] = [];
    const { run } = runOf(t, 'after-turn', async (_system, prompt) => {
      asked.push(prompt);
      return prompt.includes('build 1') ? 'build 1 finished in 401 seconds' : 'build 2 finished in 402 seconds';
    });
    const out = String(await tool('context.condense').run({ ids: ['t1', 't2', 't4'] }, run));
    assert.match(out, /^condensed t1: about \d+ tokens saved/m);
    assert.match(out, /^condensed t2: about \d+ tokens saved/m);
    assert.match(out, /^t4 stays as it is: in the newest 2 turns\./m);
    assert.equal(asked.length, 2, 'a protected item costs no model');
    assert.match(asked[0], /THE END 1/, 'not only the head of the original');
    const view = t.ledger.view(t.tom.id, t.chat.id).find((entry) => entry.itemId === 't1')!;
    assert.match(view.call?.output ?? '', /^build 1 finished in 401 seconds\n\{"compacted":"t1","was":"\d+ tokens","restore":"context\.restore"\}$/);
  } finally { t.cleanup(); }
});

test('context.condense: an invented value is asked again once with the reason, then refused; no LLM leaves the item as it is', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    const asked: string[] = [];
    const { run } = runOf(t, 'after-turn', async (_system, prompt) => { asked.push(prompt); return asked.length === 1 ? 'took 999 seconds' : 'build 1 finished in 401 seconds'; });
    assert.match(String(await tool('context.condense').run({ ids: ['t1'] }, run)), /^condensed t1/);
    assert.match(asked[1], /could not be used: it names values the original lacks: 999/);
    const { run: stubborn } = runOf(t, 'after-turn', async () => 'took 999 seconds');
    assert.match(String(await tool('context.condense').run({ ids: ['t2'] }, stubborn)), /^t2 not condensed: it names values the original lacks: 999\./);
    const { run: without } = runOf(t, 'after-turn');
    assert.match(String(await tool('context.condense').run({ ids: ['t2'] }, without)), /^t2 not condensed: no model could word it\./);
    assert.equal(t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === 't2')!.state, 'keep');
  } finally { t.cleanup(); }
});

test('context.condense: a text about something else is asked again, an item condensed already costs no model', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    const asked: string[] = [];
    const { run } = runOf(t, 'after-turn', async (_system, prompt) => {
      asked.push(prompt);
      return asked.length === 1 ? 'Objektiv denken, Probleme möglichst selbst lösen, wirklich alles probieren, danach melden.' : 'build 1 finished in 401 seconds, many log lines';
    });
    assert.match(String(await tool('context.condense').run({ ids: ['t1'] }, run)), /^condensed t1/);
    assert.match(asked[1], /could not be used: it is about something else/);
    assert.equal(asked.length, 2);
    assert.match(String(await tool('context.condense').run({ ids: ['t1'] }, run)), /^t1 is condensed already\./);
    assert.equal(asked.length, 2);
  } finally { t.cleanup(); }
});

test('a brain\'s context.restore outside an asked run: back in full, all ids, no pin, nothing shown; it can still condense what it restored', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    const { run, shown } = runOf(t, 'after-turn', async () => 'build 1 finished in 401 seconds');
    await tool('context.hide').run({ ids: ['t1', 't2'] }, run);
    assert.equal(String(await tool('context.restore').run({ ids: ['t1', 't2'] }, run)), 'back in full: t1, t2');
    assert.deepEqual(shown, [], 'the main AI hears nothing of an undone mark');
    const items = t.ledger.items(t.tom.id, t.chat.id);
    for (const id of ['t1', 't2']) {
      const item = items.find((entry) => entry.itemId === id)!;
      assert.equal(item.state, 'keep');
      assert.equal(item.pinnedUntil, undefined, 'no pin');
    }
    assert.match(String(await tool('context.condense').run({ ids: ['t1'] }, run)), /^condensed t1/);
  } finally { t.cleanup(); }
});

test('a flow: restore without done.show shows nothing, a run cut off shows nothing, done.show names it: a real call, pinned for the main AI', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const hide = (ids: string[]) => t.ledger.mark(t.tom.id, t.chat.id, ids.map((itemId) => ({ itemId, state: 'hidden' as const, reason: 'old', by: 'subconscious' as const })));
    const flow = (steps: Parameters<typeof scripted>[0], maxSteps = 4) => runFlow(t.services, { decision: scripted(steps).runner }, { kind: 'after-turn', agent: t.tom, conversationId: t.chat.id, thread: t.chat.id, maxSteps });
    hide(['t1']);
    assert.deepEqual((await flow([{ tool: 'context.restore', args: { ids: ['t1'] } }, { tool: 'done' }])).trace.calls, []);
    hide(['t1']);
    const cut = await flow([{ tool: 'context.restore', args: { ids: ['t1'] } }, { tool: 'context.list' }], 2);
    assert.equal(cut.end, 'steps');
    assert.deepEqual(cut.trace.calls, []);
    hide(['t1']);
    const shown = await flow([{ tool: 'context.restore', args: { ids: ['t1'] } }, { tool: 'done', args: { show: ['t1'] } }]);
    assert.deepEqual(shown.trace.calls.map((call) => [call.tool, call.args]), [['context.restore', { ids: ['t1'] }]]);
    assert.match(shown.trace.calls[0].output, /build 1 finished in 401 seconds/);
    assert.notEqual(t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === 't1')!.pinnedUntil, undefined);
  } finally { t.cleanup(); }
});

test('asked: the restore is what the main AI wanted, its originals are the call\'s output', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 't1', state: 'hidden', reason: 'old', by: 'subconscious' }]);
    const { run, shown } = runOf(t, 'asked');
    assert.match(String(await tool('context.restore').run({ ids: ['t1'] }, run)), /^Restored t1/);
    assert.equal(shown[0].tool, 'context.restore');
    assert.match(shown[0].output, /build 1 finished in 401 seconds/);
  } finally { t.cleanup(); }
});

test('context.read pages through a long original', async () => {
  const t = ledgerSetup();
  try {
    const first = t.turn(t.say('Long one please, with some words.').seq);
    t.ourCall(first, 'shell.exec', { command: 'long' }, `${'a'.repeat(3600)}${'b'.repeat(100)}`, 'c1');
    t.done(first);
    const { run } = runOf(t, 'after-turn');
    const head = String(await tool('context.read').run({ id: 't1' }, run));
    assert.match(head, /\[… 100 more characters, from 3600\]$/);
    assert.doesNotMatch(head, /b/);
    const rest = String(await tool('context.read').run({ id: 't1', from: 3600 }, run));
    assert.match(rest, /b{100}$/);
    assert.doesNotMatch(rest, /more characters/);
  } finally { t.cleanup(); }
});

test('a rebuild keeps an engine\'s own output as the model saw it; ours stays at the model\'s own cap', async () => {
  const t = ledgerSetup();
  try {
    const runId = t.turn(t.say('Read the long file, with some words.').seq);
    const own = `${'x'.repeat(39_000)}THE END`;
    t.journal.item(runId, { kind: 'tool_call', name: 'exec', data: { callId: 'c_own', own: true, args: JSON.stringify({ source: 'text(1)' }), summary: 'Ran a command' }, effectStatus: 'none' });
    t.journal.item(runId, { kind: 'tool_result', data: { callId: 'c_own', ok: true, summary: 'done', output: own }, effectStatus: 'none' });
    t.ourCall(runId, 'files.read', { path: 'big' }, 'y'.repeat(30_000), 'c_ours');
    t.done(runId);
    await t.journal.settled();
    const view = t.ledger.view(t.tom.id, t.chat.id);
    const native = view.find((entry) => entry.call?.callId === 'c_own')!;
    assert.equal(native.call?.output, own, 'no cut and no note in an item nobody marked');
    const ours = view.find((entry) => entry.call?.callId === 'c_ours')!;
    assert.match(ours.call?.output ?? '', /output cut for context/);
  } finally { t.cleanup(); }
});
