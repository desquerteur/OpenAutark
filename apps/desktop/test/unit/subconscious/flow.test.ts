// The subconscious as a routed flow of two brains (subconscious/flow.ts, service.ts, after-turn.ts, wake.ts) with fake brains
// and fake vector and memory services: the decision model writes its own query and places and picks; route to the LLM and back;
// the loop's stops; no wake while a tool output is pending; the cheap wake check; agent.tell reaching
// the next turn; failure isolation; one run per burst; memory.browse and memory.read as the main AI's tools word them; B-078:
// the main AI's stable prompt in the system text, its thoughts and the catalog's hits opening a step, and skills.load as the main AI's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESOURCES, fixture } from '../context/fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { FLOW_TOOLS, type FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import { memoryFolders, parseCall, runFlow } from '../../../src/runtime/subconscious/flow.ts';
import { folderText } from '../../../src/runtime/tools/builtin/memory.ts';
import { loadedSkillText, skillTools } from '../../../src/runtime/tools/builtin/skills.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { SkillInfo } from '../../../src/shared/model/knowledge.ts';
import { EVERY_TURNS, hasContent, wakeAfterTurn } from '../../../src/runtime/subconscious/wake.ts';
import { TRACE_TOKENS, capTrace } from '../../../src/shared/model/subconscious.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import { SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { RouteRequest, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Engine, EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { MemoryFile, MemoryFolder, MemoryWriteInput } from '../../../src/shared/model/memory.ts';
import type { VectorSearchInput } from '../../../src/shared/model/vectors.ts';

type Call = Parameters<StructuredRunner>[0];
/** One scripted step: a tool call, or an error the brain throws. */
type Scripted = { tool: string; args?: Record<string, unknown> } | Error;

const quiet = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A brain answering step by step; after its script it says done. */
function brain(steps: Scripted[]) {
  const calls: Call[] = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    const next = steps.shift() ?? { tool: 'done' };
    if (next instanceof Error) throw next;
    const structured = { tool: next.tool, args: JSON.stringify(next.args ?? {}) };
    return { text: JSON.stringify(structured), structured, by: 'fake' };
  };
  return { runner, calls };
}

function setup(options: { decision?: Scripted[]; llm?: Scripted[]; embedder?: boolean; deps?: Partial<ConstructorParameters<typeof SubconsciousImpl>[0]> } = {}) {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const searches: VectorSearchInput[] = [];
  const written: MemoryWriteInput[] = [];
  Object.assign(f.services, {
    vectors: {
      available: () => options.embedder !== false,
      embed: async () => ({ embedded: 1, reembedded: 0, unchanged: 0, skipped: [] }),
      search: async (input: VectorSearchInput) => {
        searches.push(input);
        return {
          hits: [
            { path: 'memory/company/billing.md', chunk: 0, snippet: 'Invoices go out on the 3rd.', score: 0.9 },
            { path: 'memory/company/lunch.md', chunk: 0, snippet: 'Lunch is at noon.', score: 0.4 },
          ],
          searched: { places: input.in, embeddedFiles: 2 },
        };
      },
    },
    dispatcher: { activity: () => activity.runs },
  });
  const activity: { runs: Array<{ agentId: string; conversationId?: string; toolCalls?: number }> } = { runs: [] };
  Object.assign(f.services.knowledge as object, {
    memoryWrite: (input: MemoryWriteInput) => { written.push(input); return { path: `${input.folder}/x.md`, outcome: 'created' as const }; },
    memoryBrowse: () => ({ path: '', folders: [], files: [] }),
    memoryRead: () => undefined,
    memoryForget: () => ({ removed: true }),
  });
  const decision = brain(options.decision ?? []);
  const llm = brain(options.llm ?? []);
  const subconscious = new SubconsciousImpl({ services: () => f.services, runner: decision.runner, llm: llm.runner, settleMs: 0, toolRetryMs: 1, ...options.deps });
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  /** The person writes `text`, the agent replies; the turn ends. */
  const turn = (text: string, reply = 'Noted.', extra: Record<string, unknown> = {}) => {
    const before = f.chats.messages(chat.id, { limit: 500 }).at(-1)?.seq ?? 0;
    const last = f.chats.send({ conversationId: chat.id, authorId: 'human', body: text });
    subconscious.afterTurn({ agent: f.vid, conversationId: chat.id, fromSeq: before, toSeq: last.seq, reply, ...extra });
  };
  return { f, decision, llm, subconscious, chat, turn, searches, written, activity };
}

test('the decision model writes its own query and places, picks a hit; the trace holds that call with only that hit', async () => {
  const t = setup({ decision: [
    { tool: 'vector.search', args: { query: 'when do invoices go out', in: ['memory/company'] } },
    { tool: 'done', args: { show: ['h1'] } },
  ] });
  t.turn('Wann schicken wir die Rechnungen raus?');
  await t.subconscious.settle();
  const trace = await t.subconscious.beforeTurn({ agent: t.f.vid, thread: t.chat.id });
  assert.deepEqual(t.searches, [{ query: 'when do invoices go out', in: ['memory/company'] }]);
  assert.equal(trace?.calls.length, 1);
  assert.equal(trace!.calls[0].tool, 'vector.search');
  assert.deepEqual(trace!.calls[0].args, { query: 'when do invoices go out', in: ['memory/company'] });
  assert.ok(trace!.calls[0].output.includes('Invoices go out on the 3rd.'));
  assert.ok(!trace!.calls[0].output.includes('Lunch'), 'what it did not pick stays out');
  assert.equal(t.llm.calls.length, 0, 'the decision model drives by default');
  assert.ok(t.decision.calls[1].prompt.includes('h1 (0.90) memory/company/billing.md'), 'the result comes back to the brain');
  assert.ok(t.decision.calls[0].prompt.includes('Run: after-turn'));
  assert.ok(t.decision.calls[0].prompt.includes('Wann schicken wir'));
});

test('a search it does not pick shows nothing at all', async () => {
  const t = setup({ decision: [{ tool: 'vector.search', args: { query: 'x y', in: ['memory'] } }, { tool: 'done' }] });
  t.turn('Wie heißt unser Steuerberater?');
  await t.subconscious.settle();
  assert.equal(await t.subconscious.beforeTurn({ agent: t.f.vid, thread: t.chat.id }), undefined);
});

test('route to the LLM and back: the flow goes on with the same tools; the LLM thinks at medium effort', async () => {
  const t = setup({
    decision: [{ tool: 'route', args: { to: 'llm', task: 'write this down well' } }, { tool: 'done' }],
    llm: [{ tool: 'memory.write', args: { title: 'Steuerberater von Alex', text: 'Jonas Weber in Bonn.', folder: 'company' } }, { tool: 'route', args: { to: 'decision', task: 'nothing left' } }],
  });
  t.turn('Unser Steuerberater ist Jonas Weber in Bonn.');
  await t.subconscious.settle();
  assert.equal(t.decision.calls.length, 2);
  assert.equal(t.llm.calls.length, 2);
  assert.deepEqual(t.written.map((item) => [item.title, item.folder]), [['Steuerberater von Alex', 'company']]);
  assert.equal(t.llm.calls[0].effort, 'medium');
  assert.equal(t.decision.calls[0].effort, undefined);
  assert.ok(t.llm.calls[0].prompt.includes('I am: the LLM') && t.llm.calls[0].prompt.includes('Handed to me: write this down well'));
  assert.ok(t.decision.calls[1].prompt.includes('Handed to me: nothing left') && t.decision.calls[1].prompt.includes('memory.write'), 'it sees what the LLM did');
  assert.deepEqual(t.llm.calls[0].schema, t.decision.calls[0].schema, 'the same tools');
});

test('the loop stops at done and at its maximum of steps', async () => {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const input = { kind: 'after-turn' as const, agent: f.vid, thread: 't', maxSteps: 3 };
  const atDone = brain([{ tool: 'done' }]);
  assert.deepEqual([(await runFlow(f.services, { decision: atDone.runner }, input)).end, atDone.calls.length], ['done', 1]);
  const endless = brain(Array.from({ length: 9 }, () => ({ tool: 'memory.browse' })));
  const result = await runFlow(f.services, { decision: endless.runner }, input);
  assert.deepEqual([result.end, result.steps, endless.calls.length], ['steps', 3, 3]);
});

test('before a turn: no model and no wait, whatever the person wrote; only what a run kept', async () => {
  const t = setup({ decision: [{ tool: 'done' }] });
  assert.equal(await t.subconscious.beforeTurn({ agent: t.f.vid, thread: t.chat.id }), undefined);
  assert.equal(t.decision.calls.length, 0);
  assert.equal(t.searches.length, 0, 'nothing searches on its own');
});

test('the cheap wake check: content, tasks, limit, switch, growth and every few turns – never "ja bitte"', () => {
  for (const text of ['ja bitte', 'mach das', 'ok', 'Ja', 'passt', 'danke!', 'weiter', 'Ja, mach das bitte so.', 'go ahead and do it']) assert.equal(hasContent(text), false, text);
  for (const text of ['Rechnung an Müller schreiben', 'Wie heißt unser Steuerberater?', 'Steuerberater']) assert.equal(hasContent(text), true, text);
  const state = { turns: 0 };
  assert.equal(wakeAfterTurn({ said: 'ja bitte' }, state), undefined);
  assert.equal(wakeAfterTurn({ said: 'Rechnung an Müller schreiben' }, state), 'person');
  assert.equal(wakeAfterTurn({ said: '', taskEnded: true }, state), 'task-ended');
  assert.equal(wakeAfterTurn({ said: '', switchPlanned: true }, state), 'switch');
  assert.equal(wakeAfterTurn({ said: '', taskId: 'b' }, { turns: 0, taskId: 'a' }), 'other-task');
  assert.equal(wakeAfterTurn({ said: '', savable: 50_000 }, { turns: 0 }), undefined, 'how much could go wakes nothing by itself: every run has the transcript in front of it');
  assert.equal(wakeAfterTurn({ said: '', savable: 3000, contextTokens: 52_000, contextWindow: 1_000_000 }, { turns: 0 }), 'limit');
  assert.equal(wakeAfterTurn({ said: '', contextTokens: 52_000, contextWindow: 1_000_000 }, { turns: 0 }), undefined, 'near the limit with nothing a run could take off: the renewal is the backstop');
  assert.equal(wakeAfterTurn({ said: '', savable: 3000, contextTokens: 52_500, contextWindow: 1_000_000 }, { turns: 0, tokens: 52_000 }), undefined, 'near the limit, but barely grown');
  assert.equal(wakeAfterTurn({ said: '' }, { turns: EVERY_TURNS - 1 }), 'turns');
});

test('a bare yes wakes nothing; a later run sees it beside the proposal it answered', async () => {
  const t = setup();
  t.f.chats.send({ conversationId: t.chat.id, authorId: t.f.vid.id, body: 'Soll ich die Rechnungen künftig am 3. schicken?' });
  t.turn('ja bitte');
  await t.subconscious.settle();
  assert.equal(t.decision.calls.length, 0);
  t.turn('Und die Mahnungen gehen an Frau Berger.');
  await t.subconscious.settle();
  assert.equal(t.decision.calls.length, 1);
  assert.ok(t.decision.calls[0].prompt.includes('The person: ja bitte'), t.decision.calls[0].prompt);
  assert.ok(t.decision.calls[0].prompt.includes('Mahnungen'));
  assert.ok(t.decision.calls[0].prompt.includes('woken by person'));
});

test('no wake while a tool call waits for its output; the run comes when it has it', async () => {
  const t = setup();
  t.activity.runs = [{ agentId: t.f.vid.id, conversationId: t.chat.id, toolCalls: 1 }];
  t.turn('Unser Steuerberater ist Jonas Weber.');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(t.decision.calls.length, 0, 'still waiting');
  t.activity.runs = [{ agentId: t.f.vid.id, conversationId: t.chat.id }];
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(t.decision.calls.length, 1);
});

test('one run per burst: the newest turn, the widest range', async () => {
  const t = setup({ deps: { settleMs: 60_000 } });
  t.turn('Unser Steuerberater ist Jonas Weber.');
  t.turn('Er sitzt in Bonn.');
  t.turn('Telefon 0228 123.', 'Alles notiert.');
  await t.subconscious.settle();
  assert.equal(t.decision.calls.length, 1);
  const prompt = t.decision.calls[0].prompt;
  assert.ok(prompt.includes('Jonas Weber') && prompt.includes('Bonn') && prompt.includes('0228 123') && prompt.includes('Alles notiert.'), prompt);
  t.turn('Und die Kanzlei heißt Weber & Partner.');
  await t.subconscious.settle();
  assert.equal(t.decision.calls.length, 2);
  assert.ok(!t.decision.calls[1].prompt.includes('Jonas Weber'), 'the next run starts where the last one ended');
});

test('agent.tell reaches the next turn once, as a call with the note as its output', async () => {
  const t = setup({ decision: [{ tool: 'agent.tell', args: { text: 'Frau Berger bekommt die Mahnungen.' } }] });
  t.turn('Die Mahnungen gehen an Frau Berger.');
  await t.subconscious.settle();
  const trace = await t.subconscious.beforeTurn({ agent: t.f.vid, thread: t.chat.id });
  assert.deepEqual(trace?.calls.map(({ tool, args, output }) => ({ tool, args, output })), [{ tool: 'subconscious', args: {}, output: 'Frau Berger bekommt die Mahnungen.' }]);
  assert.equal(await t.subconscious.beforeTurn({ agent: t.f.vid, thread: t.chat.id }), undefined, 'once');
});

test('failures stay inside: a throwing brain or tool ends or informs the run, never the turn', async () => {
  const t = setup({ decision: [new Error('model down')] });
  assert.doesNotThrow(() => t.turn('Unser Steuerberater ist Jonas Weber.'));
  await t.subconscious.settle();
  assert.equal(await t.subconscious.beforeTurn({ agent: t.f.vid, thread: t.chat.id }), undefined);

  const told = setup({ decision: [{ tool: 'agent.tell', args: { text: 'Eine Notiz.' } }, new Error('model down')] });
  told.turn('Rechnung an Müller schreiben');
  await told.subconscious.settle();
  const trace = await told.subconscious.beforeTurn({ agent: told.f.vid, thread: told.chat.id });
  assert.equal(trace?.calls[0].output, 'Eine Notiz.', 'what it had stays');

  const broken = setup({ decision: [{ tool: 'memory.write', args: { title: 'T', text: 'x' } }, { tool: 'no.such', args: {} }] });
  (broken.f.services.knowledge as unknown as { memoryWrite: unknown }).memoryWrite = () => { throw new Error('disk full'); };
  broken.turn('Unser Steuerberater ist Jonas Weber.');
  await broken.subconscious.settle();
  assert.ok(broken.decision.calls[1].prompt.includes('memory.write failed: disk full'), 'the failing tool answers as text');
  assert.ok(broken.decision.calls[2].prompt.includes('Unknown tool no.such.'));

  const babble = brain([]);
  const nonsense: StructuredRunner = async (call) => { babble.calls.push(call); return { text: 'I think nothing.', by: 'fake' }; };
  const end = await runFlow(broken.f.services, { decision: nonsense }, { kind: 'after-turn', agent: broken.f.vid, thread: 't' });
  assert.deepEqual([end.end, babble.calls.length], ['failed', 2]);
});

test('no model: nothing runs, nothing throws, and the main AI is told so when it asks', async () => {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const subconscious = new SubconsciousImpl({ services: () => f.services, runner: false, llm: false, settleMs: 0 });
  assert.match(await subconscious.ask({ agent: f.vid, ask: 'Was weißt du über Rechnungen?' }), /no model/);
});

test('the prompt holds the tool list generated from the tools, and no list of memory: only the folders to write in', async () => {
  const t = setup({ decision: [{ tool: 'done' }] });
  await t.subconscious.ask({ agent: t.f.vid, ask: 'Was weißt du über Rechnungen?', context: 'none' });
  const { system, prompt, schema } = t.decision.calls[0];
  for (const tool of FLOW_TOOLS) assert.ok(system.includes(`- ${tool.name} ${tool.args} – ${tool.line}`), tool.name);
  assert.ok(!system.includes('{{tools}}'));
  assert.deepEqual((schema as { properties: { tool: { enum: string[] } } }).properties.tool.enum, FLOW_TOOLS.map((tool) => tool.name));
  assert.ok(prompt.includes(memoryFolders(t.f.vid).join(', ')));
});

test('brain answers: structured or text, args as JSON text or object; anything else is no call', () => {
  assert.deepEqual(parseCall({ text: '', structured: { tool: 'done', args: '{"show":["h1"]}' } }), { tool: 'done', args: { show: ['h1'] } });
  assert.deepEqual(parseCall({ text: 'Here: {"tool":"done","args":{"answer":"x"}}' }), { tool: 'done', args: { answer: 'x' } });
  assert.equal(parseCall({ text: 'nothing' }), undefined);
  assert.equal(parseCall({ text: '', structured: { tool: 'done', args: 'not json' } }), undefined);
});

test('a trace stays within its cap: the first calls first, cut rather than overflowing', () => {
  const long = 'x'.repeat(TRACE_TOKENS * 10);
  const capped = capTrace({ calls: [{ tool: 'subconscious', args: {}, output: 'kurz' }, { tool: 'vector.search', args: { query: 'q' }, output: long }, { tool: 'agent.tell', args: {}, output: 'gone' }] });
  assert.deepEqual(capped.calls.map((call) => call.tool), ['subconscious', 'vector.search']);
  assert.ok(JSON.stringify(capped).length <= TRACE_TOKENS * 4 + 120);
  assert.ok(capped.calls[1].output.endsWith('… [cut]'));
});

test('the brains on real routes: the decision model routes as the runtime (Decisions use), the LLM as a working agent (Work use) that wants the strongest', async () => {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const asked: RouteRequest[] = [];
  const replies = [{ tool: 'route', args: '{"to":"llm","task":"write"}' }, { tool: 'done', args: '{}' }, { tool: 'done', args: '{}' }];
  const engine = { run: async (input: EngineTurnInput) => ({ text: '', structured: replies.shift(), stop: 'done' as const }) } as unknown as Engine;
  Object.assign(f.services, {
    router: { route: async (request: RouteRequest) => { asked.push(request); return { modelId: 'codex:luna', engine: 'codex', accountId: 'acc_1', effort: 'low', category: 'cheap-chat', reason: '', by: 'rules', alternatives: [] }; } },
    engines: { get: () => engine },
    accounts: { get: () => ({ id: 'acc_1' }), updateLimits: () => {}, markLimited: () => {}, markUnavailable: () => false },
    catalog: { get: () => ({ id: 'codex:luna', model: 'luna', efforts: ['low'] }), list: () => [{ available: true }] },
    paths: { temp: tmpdir() },
  } as unknown as Partial<RuntimeServices>);
  const subconscious = new SubconsciousImpl({ services: () => f.services });
  const answer = await subconscious.ask({ agent: f.vid, ask: 'Was weißt du über Rechnungen?', context: 'none' });
  assert.equal(answer, 'The subconscious has nothing to add.');
  assert.equal(asked.length, 3, 'told once that an empty done is no answer');
  assert.equal(asked[0].agent.id, SYSTEM_ID, 'the decision model: the Decisions use');
  assert.equal(asked[0].previous, undefined);
  assert.notEqual(asked[1].agent.id, SYSTEM_ID, 'the LLM: the Work use');
  assert.equal(asked[1].agent.modelPolicy.costMode, 'best');
  assert.equal(asked[1].agent.modelPolicy.ceilingTier, undefined);
  assert.deepEqual([asked[1].previous?.effort, asked[1].previous?.asked], ['medium', 'effort']);
});

test('a wake by a person orders nothing: the decision model writes query and place, or ends', async () => {
  const t = setup({ decision: [{ tool: 'done' }] });
  t.turn('Die Rechnung an Müller geht morgen raus.');
  await t.subconscious.settle();
  assert.match(t.decision.calls[0].prompt, /woken by person/);
  assert.doesNotMatch(t.decision.calls[0].prompt, /Look now|first step/);
  assert.equal(t.searches.length, 0, 'it decides: nothing searches on its own');
});

test('a step counts for the brain that made it, also the route that hands the flow on', async () => {
  const t = setup({ decision: [{ tool: 'route', args: { to: 'llm', task: 'write it' } }], llm: [{ tool: 'done' }] });
  t.turn('Unser Steuerberater ist Jonas Weber in Bonn.');
  await t.subconscious.settle();
  assert.ok(t.llm.calls[0].prompt.includes('[1 decision] route'));
});

test('memory.browse answers as the main AI\'s memory.browse (clipped), memory.read with the description', async () => {
  const t = setup();
  const file = (index: number, description?: string) => ({ path: `company/customers/c${index}.md`, title: `Customer ${index}`, ...(description ? { description } : {}), updated: Date.UTC(2026, 9, 1) });
  const folder: MemoryFolder = { path: 'company/customers', description: 'Who buys from us.', folders: [], files: [file(1, 'When an invoice to Müller is due.'), file(2)] };
  const big: MemoryFolder = { ...folder, files: Array.from({ length: 100 }, (_, index) => file(index, `When order ${index} is due, and what it needs.`)), more: true };
  const read: MemoryFile = { path: 'company/customers/c1.md', title: 'Customer 1', description: 'When an invoice to Müller is due.', text: 'Zahlt spät.', updated: 0 };
  let shown = folder;
  Object.assign(t.f.services.knowledge as object, { memoryBrowse: () => shown, memoryRead: () => read });
  const run = { services: t.f.services } as unknown as FlowRun;
  const tool = (name: string) => FLOW_TOOLS.find((entry) => entry.name === name)!;
  assert.equal(await tool('memory.browse').run({ folder: 'company/customers' }, run), folderText(folder));
  shown = big;
  const cut = await tool('memory.browse').run({}, run);
  assert.ok(cut.endsWith(' …') && folderText(big).startsWith(cut.slice(0, -2)) && cut.length < folderText(big).length, cut);
  assert.equal(await tool('memory.read').run({ path: 'company/customers/c1.md' }, run), 'Customer 1\nWhen an invoice to Müller is due.\nZahlt spät.');
});

const skill = (name: string, extra: Partial<SkillInfo> = {}): SkillInfo => ({ name, description: `When ${name.replace(/-/g, ' ')} is the work.`, source: 'builtin', path: `/skills/${name}`, modes: [], updatedAt: 0, ...extra });

test('B-078: the main AI\'s stable prompt follows the subconscious\'s own text in every step; its thoughts and the catalog open the step', async () => {
  const t = setup();
  t.f.services.skills = new SkillLibrary({ paths: { workspace: path.join(tmpdir(), 'no-workspace-b078'), resources: RESOURCES }, clock: t.f.services.clock, home: '' });
  Object.assign(t.f.services.knowledge as object, {
    memoryRead: (file: string) => (file === `agents/${t.f.vid.id}/thoughts.md` ? { path: file, title: 'Thoughts', text: '- 2026-11-01: invoices late again\n- 2026-11-02: Vic likes short cuts', updated: 0 } : undefined),
  });
  const two = brain([{ tool: 'memory.browse' }, { tool: 'done' }]);
  await runFlow(t.f.services, { decision: two.runner }, { kind: 'after-turn', agent: t.f.vid, thread: 't', mode: 'video', context: 'Person: render the remotion video with captions' });
  const [first, second] = two.calls;
  assert.ok(first.system.includes('<main-ai-prompt>') && first.system.includes(t.f.vid.name), 'the main AI\'s own prompt is part of the system text');
  assert.equal(first.system, second.system, 'the same system text in every step: its prefix caches');
  assert.ok(first.prompt.includes('My newest kept thoughts:\n- 2026-11-01: invoices late again\n- 2026-11-02: Vic likes short cuts'), first.prompt);
  assert.ok(/What the knowledge catalog holds[^\n]*\n[\s\S]*remotion-video/.test(first.prompt), first.prompt);
  assert.equal(first.temperature, 0.2, 'the decision brain asks for a low temperature');
});

test('skills.load opens one of the agent\'s skills as the main AI\'s skills.load gives it, a page at a time', async () => {
  const t = setup();
  const short = { info: skill('memory-hygiene'), body: 'Tidy memory now and then.' };
  const long = { info: skill('writing-skills'), body: 'w'.repeat(9000) };
  const asked: Array<[string, string | undefined]> = [];
  Object.assign(t.f.services, { skills: { ...t.f.services.skills, get: (name: string, viewerId?: string) => { asked.push([name, viewerId]); return [short, long].find((entry) => entry.info.name === name); } } });
  const run = { services: t.f.services, agent: t.f.vid } as unknown as FlowRun;
  const load = FLOW_TOOLS.find((entry) => entry.name === 'skills.load')!;
  assert.equal(await load.run({ name: 'memory-hygiene' }, run), loadedSkillText(short));
  assert.deepEqual(asked, [['memory-hygiene', t.f.vid.id]], 'the main AI\'s call and route');
  const main = await skillTools.find((entry) => entry.name === 'skills.load')!.run({ name: 'memory-hygiene' }, { services: t.f.services, agent: t.f.vid } as unknown as ToolContext);
  assert.equal((main.content[0] as { text: string }).text, loadedSkillText(short), 'the main AI\'s text');
  const text = loadedSkillText(long);
  assert.equal(await load.run({ name: 'writing-skills' }, run), `${text.slice(0, 3600)}\n[… ${text.length - 3600} more characters, from 3600]`);
  assert.equal(await load.run({ name: 'writing-skills', from: 3600 }, run), `${text.slice(3600, 7200)}\n[… ${text.length - 7200} more characters, from 7200]`);
  assert.equal(await load.run({ name: 'writing-skills', from: 7200 }, run), text.slice(7200));
  assert.equal(await load.run({ name: 'x' }, run), 'No skill x.');
  assert.equal(await load.run({}, run), 'skills.load needs a name.');
});
