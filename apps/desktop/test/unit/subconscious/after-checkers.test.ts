// What the checkers of rounds q1, q2 and L3 found, as it now holds: words nobody reads, notes without a find, a run begun before a tool call,
// what an after-turn run is told is not new, close titles, places relative to the workspace, counts and search orders in text.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runFlow, type FlowInput } from '../../../src/runtime/subconscious/flow.ts';
import { FLOW_TOOLS, type FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import { exchangeText } from '../../../src/runtime/subconscious/exchange.ts';
import { weekdayText } from '../../../src/runtime/knowledge/age.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources/prompts');
const prompt = () => readFileSync(path.join(RESOURCES, 'subconscious.md'), 'utf8');
const rules = () => readFileSync(path.join(RESOURCES, 'rules.md'), 'utf8');

function world(over: Partial<Record<string, unknown>> = {}) {
  const written: Array<{ title: string; text: string; path?: string }> = [];
  const files: Array<{ path: string; title: string; updated: number }> = [];
  const services = {
    clock: { now: () => Date.parse('2026-11-02T10:00:00Z') },
    settings: { get: () => ({ profile: { name: 'Alex' } }) },
    log: { debug() {}, warn() {} },
    prompts: { text: () => 'My tools:\n{{tools}}' },
    paths: { workspace: tmpdir() },
    dispatcher: { activity: () => [] },
    vectors: { available: () => true, search: async (input: { in: string[] }) => ({ hits: [{ path: 'memory/company/a.md', chunk: 0, snippet: 'Regel: nur gegen Vorkasse', score: 0.7 }], searched: { places: input.in, embeddedFiles: 1 } }) },
    knowledge: {
      memoryBrowse: () => ({ path: 'company', folders: [], files }),
      memoryRead: (file: string) => ({ title: 'Alt', text: `Text von ${file}` }),
      memoryWrite: (input: { title: string; text: string; path?: string }) => { written.push(input); return { outcome: input.path ? 'updated' : 'created', path: input.path ?? 'company/neu.md' }; },
    },
    ...over,
  } as unknown as RuntimeServices;
  return { services, written, files };
}

const brain = (steps: Array<Record<string, unknown>>) => {
  const prompts: string[] = [];
  const runner: StructuredRunner = async (input) => { prompts.push(input.prompt); const next = steps.shift() ?? { tool: 'done', args: {} }; return { text: '', structured: { why: 'x', tool: next.tool, args: JSON.stringify(next.args ?? {}) }, by: 'fake' }; };
  return { prompts, runner };
};
const AGENT = { id: 'ag_a', name: 'Mara' } as FlowInput['agent'];
const flow = (t: ReturnType<typeof world>, runner: StructuredRunner, input: Partial<FlowInput>) => runFlow(t.services, { decision: runner }, { kind: 'before-turn', agent: AGENT, conversationId: 'ch_1', thread: 'ch_1', ...input });
const search = { tool: 'vector.search', args: { query: 'Hartwig', in: ['memory'] } };

test('q1d #23: before a turn, words in answer are told once to go through show; a find reaches the main AI as the real search', async () => {
  const t = world();
  const b = brain([search, { tool: 'done', args: { answer: 'Nur gegen Vorkasse.' } }, { tool: 'done', args: { show: ['h1'], note: 'Es gilt Vorkasse.' } }]);
  const result = await flow(t, b.runner, {});
  assert.match(b.prompts[2], /Nobody reads that: in this run only what show names/);
  assert.deepEqual(result.trace.calls.map((call) => call.tool), ['vector.search']);
  assert.match(result.trace.calls[0].output, /Noticed, to tell the person when I answer: Es gilt Vorkasse\.\nmemory\/company\/a\.md/);
});

test('q1d #7, q1b #43: a note about finding nothing shows nothing, also when the model says it twice', async () => {
  const t = world();
  const b = brain([search, { tool: 'done', args: { note: 'Nichts gefunden.' } }, { tool: 'done', args: { note: 'Nichts gefunden.' } }]);
  const result = await flow(t, b.runner, {});
  assert.deepEqual(result.trace.calls, []);
  assert.equal(result.end, 'done');
  const none = brain([{ tool: 'done', args: { note: 'Nichts.' } }]);
  assert.equal((await flow(t, none.runner, {})).steps, 1, 'without a search there is nothing to name: no second step');
});

test('q1d a1: an asked answer says what it rests on', async () => {
  const t = world();
  const looked = await flow(t, brain([search, { tool: 'done', args: { answer: 'Vorkasse.' } }]).runner, { kind: 'asked', task: 'Was ist bekannt?' });
  assert.match(looked.answer, /\(This answer used: vector\.search\.\)$/);
  const not = await flow(t, brain([{ tool: 'done', args: { answer: 'Nichts bekannt.' } }]).runner, { kind: 'asked', task: 'Was ist bekannt?' });
  assert.match(not.answer, /\(This answer used no tool, only the text it was given\.\)$/);
});

test('rule (j): a run begun earlier starts no model call while a tool call waits; the main AI\'s own call is exempt', async () => {
  let waiting = true;
  const t = world({ dispatcher: { activity: () => (waiting ? [{ agentId: 'ag_a', conversationId: 'ch_1', toolCalls: 1 }] : []) } });
  const b = brain([{ tool: 'done', args: {} }]);
  const running = flow(t, b.runner, { kind: 'after-turn' });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(b.prompts.length, 0, 'no model call during the wait');
  waiting = false;
  assert.equal((await running).end, 'done');
  assert.equal(b.prompts.length, 1);
  waiting = true;
  const asked = brain([{ tool: 'done', args: { answer: 'Ja.' } }]);
  assert.equal((await flow(t, asked.runner, { kind: 'asked', task: 'x' })).end, 'done');
  waiting = true;
  const cut = await flow(t, brain([]).runner, { kind: 'after-turn', budgetMs: 50 });
  assert.equal(cut.end, 'budget', 'the wait stays within the run\'s budget');
});

test('memory: a close title in the folder is shown once; written again it is another fact; no vector search happens', async () => {
  const searched: unknown[] = [];
  const t = world({ vectors: { available: () => true, search: async (input: unknown) => { searched.push(input); return { hits: [], searched: { places: [], embeddedFiles: 0 } }; } } });
  t.files.push({ path: 'company/kessler.md', title: 'Kessler Feinmechanik: Gutschriftverfahren', updated: 1 });
  const write = { tool: 'memory.write', args: { title: 'Kessler Feinmechanik rechnet im Gutschriftverfahren ab', text: 'Kessler Feinmechanik rechnet im Gutschriftverfahren ab.', folder: 'company' } };
  const b = brain([write, write, { tool: 'done', args: {} }]);
  await flow(t, b.runner, { kind: 'after-turn', context: 'The person: Kessler Feinmechanik rechnet im Gutschriftverfahren ab.' });
  assert.match(b.prompts[1], /Not written yet: company\/kessler\.md has a close title\. It says: Text von company\/kessler\.md/);
  assert.equal(t.written.length, 1);
  assert.deepEqual(searched, []);
});

test('a folder the person names in the workspace is a place to a brain; "memory" stays as it is; an unknown name stays a wrong place', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-place-'));
  mkdirSync(path.join(dir, 'hallenakte'));
  try {
    const seen: string[][] = [];
    const t = world({ paths: { workspace: dir }, vectors: { available: () => true, search: async (input: { in: string[] }) => { seen.push(input.in); return { hits: [], searched: { places: input.in, embeddedFiles: 0 } }; } } });
    const tool = FLOW_TOOLS.find((entry) => entry.name === 'vector.search')!;
    const run = { services: t.services, searches: [], hits: new Map() } as unknown as FlowRun;
    assert.equal(await tool.run({ query: 'q', in: ['hallenakte', 'memory/company', 'gibt-es-nicht'] }, run), 'No hits.');
    assert.deepEqual(seen[0], [path.join(dir, 'hallenakte'), 'memory/company', 'gibt-es-nicht']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('what stands before the person\'s line is marked as not new, and what the main AI saved itself is named', () => {
  const messages = [
    { seq: 5, kind: 'text', authorId: 'ag_a', authorKind: 'agent', body: 'Soll ich die Liste kürzen?' },
    { seq: 6, kind: 'text', authorId: 'human', authorKind: 'human', body: 'Ja, und Frau Yilmaz leitet den Einkauf.' },
  ];
  const services = {
    chats: { messages: () => messages },
    org: { get: () => ({ name: 'Mara' }) },
    ledger: { items: () => [
      { runId: 'run_1', kind: 'tool', title: 'knowledge.remember: Remember "Einkaufsleitung: Frau Yilmaz"' }, { runId: 'run_0', kind: 'tool', title: 'knowledge.remember: Remember "Alt"' },
      { runId: 'run_1', kind: 'file', title: 'File C:\\work\\akten\\03-ranftl.md' }, { runId: 'run_1', kind: 'tool', title: 'shell: Ran Get-Content akten\\03-ranftl.md' },
      { runId: 'run_1', kind: 'assistant', title: 'Erledigt.' }, { runId: 'run_0', kind: 'tool', title: 'shell: Ran alt' },
      { runId: 'run_1', kind: 'tool', title: 'subconscious: Subconscious: subconscious' },
    ] },
  } as unknown as RuntimeServices;
  const text = exchangeText(services, { agent: AGENT, conversationId: 'ch_1', fromSeq: 4, toSeq: 6, reply: 'Erledigt.', runId: 'run_1' });
  assert.match(text, /^Before this exchange, not new:\nMara: Soll ich die Liste kürzen\?\n\nThe exchange:\nThe person: Ja, und Frau Yilmaz/);
  // q-r1b2 #32: where the reply's facts came from (a file it read) stands beside it, not new.
  assert.match(text, /Mara replied: Erledigt\.\nWhat Mara's tools read or ran in this turn, not new:\nFile C:\\work\\akten\\03-ranftl\.md\nshell: Ran Get-Content akten\\03-ranftl\.md\nMara saved: "Einkaufsleitung: Frau Yilmaz"$/);
  assert.doesNotMatch(text, /Alt|Ran alt|Subconscious/, 'the subconscious\'s own calls are not the main AI\'s sources');
});

test('the day of a run comes with its weekday, in the person\'s zone', () => {
  assert.equal(weekdayText(Date.parse('2026-11-02T10:00:00Z'), 'Europe/Vienna'), 'Monday');
});

test('owner rules (f), (h): no prompt line orders a search, tells of the background or carries a test\'s words', () => {
  const text = prompt();
  for (const gone of ['one look can', 'asks only for a text', 'to do or leave', 'never hide', 'because it says so', 'your session may carry', '"Ja"', 'TIDY', 'You are here for', 'and what tools returned']) assert.ok(!text.includes(gone), gone);
  assert.ok(!rules().includes('in the background'));
  const tools = FLOW_TOOLS.map((tool) => tool.line).join('\n');
  for (const gone of ['look it up', 'you choose', 'finding nothing is no note']) assert.ok(!tools.includes(gone), gone);
});

test('rule (e): without an embedder a memory write says it is not embedded', async () => {
  const t = world({ vectors: { available: () => false } });
  const tool = FLOW_TOOLS.find((entry) => entry.name === 'memory.write')!;
  const run = { services: t.services, kind: 'after-turn', agent: AGENT, thread: 'ch_1', hits: new Map(), searches: [] } as unknown as FlowRun;
  assert.match(String(await tool.run({ title: 'Pichler Einkauf', text: 'Herr Pichler leitet ab Januar den Einkauf der Hartwig Gießerei.', folder: 'company' }, run)), /^created: company\/neu\.md \(No embedder is connected.*It is not embedded\.\)$/);
});
