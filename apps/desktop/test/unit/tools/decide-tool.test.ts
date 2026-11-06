// RT9 – the decide tool through the real registry with a fake decision service: the three outcomes
// (choice / none_fit / unsure with the hint, also without a decision model), a read source whose output
// reaches only the decision context (never the result or the decide journal items), refused sources
// (write category, unknown, masked in the mode, invalid arguments – also without a decision model), a
// stopped turn, argument bounds (also
// options differing only in case), the core-tool offer, and the run note { decision } without
// context. Two cases run the real DecisionHub (a backend's confident "none" ends as none_fit; a
// stop aborts the backend call).
// Owns: these assertions only. Never: real engines, network or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tool } from './helpers.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { DECIDE_TIMEOUT_MS, STOPPED, UNSURE_HINT, UNSURE_SOURCE_HINT, decideTools } from '../../../src/runtime/tools/builtin/decide.ts';
import { DecisionHub } from '../../../src/runtime/decision/service.ts';
import type { DecisionRequest, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';

const LISTING = 'report-final.pdf\nreport-draft.pdf\nLISTING-MARKER';
const CONTEXT = 'The person wants the version they signed off. CONTEXT-MARKER';

const textOf = (out: ToolOutput) => out.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
const mode = (key: string, tools: string[]): ModeInfo => ({ key, name: key, description: key, skills: [], tools, category: 'chat', instructions: '' });

function rig() {
  const h = setup();
  const registry = new Registry({ services: () => h.services as RuntimeServices });
  const ran: Array<{ name: string; args: unknown }> = [];
  const reads = (name: string, text: string) => async (args: unknown) => { ran.push({ name, args }); return { content: [{ type: 'text' as const, text }] }; };
  for (const entry of decideTools) registry.register(entry);
  registry.register(tool('files.list', 'read', { run: reads('files.list', LISTING) }));
  registry.register(tool('files.write', 'write_local', { run: reads('files.write', 'written') }));
  registry.register(tool('web.broken', 'read', { run: async () => ({ content: [{ type: 'text', text: 'HTTP 500' }], isError: true }) }));
  registry.register(tool('files.find', 'read', { inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, run: reads('files.find', 'found') }));
  const services = h.services as RuntimeServices;
  services.tools = registry;
  const modes = { general: mode('general', ['*']), narrow: mode('narrow', ['chat.*']) } as Record<string, ModeInfo>;
  services.modes = { get: (key: string) => modes[key], list: () => Object.values(modes) } as unknown as RuntimeServices['modes'];
  const base = (extra: Partial<ToolContext> = {}): Omit<ToolContext, 'services'> => ({
    agent: h.org.require('ag_tom'), runId: 'run_1', conversationId: h.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {}, ...extra,
  });
  let seq = 0;
  const decide = (args: Record<string, unknown>, extra: Partial<ToolContext> = {}) => registry.call('decide', args, base(extra), `c${++seq}`);
  const reply = (out: ToolOutput) => { assert.equal(out.isError, undefined, textOf(out)); return JSON.parse(textOf(out)) as Record<string, unknown>; };
  const notes = () => h.runItems.filter((item) => item.kind === 'note').map((item) => item.data.decision as Record<string, unknown>);
  return { h, registry, ran, decide, reply, modes, notes };
}

const ask = { question: 'Which file is the final report?', options: ['report-final.pdf', 'report-draft.pdf'] };

test('a read source reaches only the decision: the result and the decide journal hold neither it nor the context', async () => {
  const { h, ran, decide, reply } = rig();
  h.decisions.answer({ choice: 'report-final.pdf', confidence: 0.9, by: 'fake', outcome: 'choice' });
  const out = await decide({ ...ask, context: CONTEXT, source: { tool: 'files.list', args: { path: 'reports' } } });
  assert.deepEqual(reply(out), { outcome: 'choice', choice: 'report-final.pdf', confidence: 0.9, by: 'fake' });
  assert.doesNotMatch(textOf(out), /LISTING-MARKER|CONTEXT-MARKER/);
  assert.deepEqual(ran, [{ name: 'files.list', args: { path: 'reports' } }], 'the source ran once through the registry');

  const [request] = h.decisions.calls as DecisionRequest[];
  assert.equal(h.decisions.calls.length, 1);
  assert.deepEqual([request.type, request.purpose, request.options, request.timeoutMs], ['choice', 'agent', ask.options, DECIDE_TIMEOUT_MS]);
  assert.ok(request.signal instanceof AbortSignal, 'the turn\'s stop goes with the request');
  assert.match(request.context ?? '', /CONTEXT-MARKER/);
  assert.match(request.context ?? '', /Output of files\.list:\nreport-final\.pdf\nreport-draft\.pdf\nLISTING-MARKER/);

  const notes = h.runItems.filter((item) => item.kind === 'note');
  assert.deepEqual(notes.map((item) => item.data), [{ decision: { question: ask.question, outcome: 'choice', by: 'fake', confidence: 0.9, choice: 'report-final.pdf', source: 'files.list' } }]);
  const decideItems = h.runItems.filter((item) => item.name === 'decide');
  assert.deepEqual(decideItems.map((item) => item.kind), ['tool_call', 'note', 'tool_result'], 'the note is named after the tool');
  assert.equal((decideItems[0].data.args as string).includes('[hidden]'), true, 'the context argument is hidden in the call item');
  for (const item of decideItems) assert.doesNotMatch(JSON.stringify(item.data), /LISTING-MARKER|CONTEXT-MARKER/);
  assert.doesNotMatch(JSON.stringify(h.runItems), /CONTEXT-MARKER/, 'the context is nowhere in the journal');
  assert.ok(h.runItems.some((item) => item.kind === 'tool_call' && item.name === 'files.list'), 'the source call itself is journaled like any read');
});

test('outcomes: none_fit, unsure with lean and hint, a service without outcome, and no decision model (source not run)', async () => {
  const { h, ran, decide, reply, notes } = rig();
  h.decisions.answer({ confidence: 0.8, by: 'fake', outcome: 'none_fit' });
  assert.deepEqual(reply(await decide(ask)), { outcome: 'none_fit', confidence: 0.8, by: 'fake' });

  h.decisions.answer({ choice: 'report-draft.pdf', confidence: 0.3, by: 'fake', outcome: 'unsure' });
  assert.deepEqual(reply(await decide(ask)), { outcome: 'unsure', confidence: 0.3, by: 'fake', leaning: 'report-draft.pdf', hint: UNSURE_HINT });
  assert.equal(UNSURE_HINT, 'I decide myself.', 'without a source there is nothing to read');

  h.decisions.answer({ choice: 'report-final.pdf', confidence: 0.4, by: 'old' }); // no outcome field: derived
  assert.equal(reply(await decide(ask)).outcome, 'unsure');
  h.decisions.answer({ confidence: 0, by: 'timeout' });
  assert.equal(reply(await decide(ask)).hint, `The decision model did not answer in time. ${UNSURE_HINT}`);

  h.decisions.up = false;
  const calls = h.decisions.calls.length;
  assert.deepEqual(reply(await decide({ ...ask, source: { tool: 'files.list' } })), { outcome: 'unsure', confidence: 0, by: 'none', hint: `No decision model answered. ${UNSURE_SOURCE_HINT}` });
  assert.equal(h.decisions.calls.length, calls, 'nothing asked');
  assert.deepEqual(ran, [], 'the source is not run for nothing');
  assert.deepEqual(notes().map((decision) => decision.outcome), ['none_fit', 'unsure', 'unsure', 'unsure', 'unsure']);
  assert.equal(notes().at(-1)?.source, undefined, 'a source that did not run is not in the note');
});

test('the real hub: a confident "none" from the backend ends as none_fit; the backend sees the source output', async () => {
  const { h, decide, reply } = rig();
  const seen: DecisionRequest[] = [];
  h.services.decisions = new DecisionHub({
    backends: [{ id: 'llm', available: () => true, decide: async (request) => { seen.push(request); return { choice: 'none', confidence: 0.8, by: 'llm:fake' }; } }],
  });
  assert.deepEqual(reply(await decide({ ...ask, source: { tool: 'files.list' } })), { outcome: 'none_fit', confidence: 0.8, by: 'llm:fake' });
  assert.deepEqual(seen[0].options, [...ask.options, 'none']);
  assert.match(seen[0].context ?? '', /LISTING-MARKER/);
});

test('numeric choices: seconds travel as labels to the real hub and return as numbers, including zero and an unsure lean', async () => {
  const { h, decide, reply, notes } = rig();
  const seen: DecisionRequest[] = [];
  let pick = '60';
  let confidence = 0.9;
  h.services.decisions = new DecisionHub({
    backends: [{ id: 'fake', available: () => true, decide: async (request) => { seen.push(request); return { choice: pick, confidence, by: 'fake' }; } }],
  });
  const seconds = { question: 'How many more seconds should the command run, or abort?', options: [0, 15, 60, 'abort'] };
  assert.deepEqual(reply(await decide(seconds)), { outcome: 'choice', choice: 60, confidence: 0.9, by: 'fake' });
  assert.deepEqual(seen[0].options, ['0', '15', '60', 'abort', 'none']);
  assert.equal(notes().at(-1)?.choice, 60);

  pick = '0';
  assert.equal(reply(await decide(seconds)).choice, 0);
  assert.equal(notes().at(-1)?.choice, 0);
  pick = '15';
  confidence = 0.3;
  assert.deepEqual(reply(await decide(seconds)), { outcome: 'unsure', confidence: 0.3, by: 'fake', leaning: 15, hint: UNSURE_HINT });
  pick = 'abort';
  confidence = 0.9;
  assert.equal(reply(await decide(seconds)).choice, 'abort');
});

test('numeric choices reject ambiguous text labels and non-finite or non-scalar options before a decision', async () => {
  const { h, decide } = rig();
  assert.match(textOf(await decide({ question: 'q', options: [30, '30'] })), /number 30 and text "30" have the same label/);
  assert.match(textOf(await decide({ question: 'q', options: [' 30 ', 30] })), /number 30 and text "30" have the same label/);
  assert.match(textOf(await decide({ question: 'q', options: [30, 30] })), /^Give at least two different options/);
  for (const value of [Infinity, NaN, true, { seconds: 30 }]) {
    assert.match(textOf(await decide({ question: 'q', options: [30, value] })), /^Invalid arguments for decide/);
  }
  assert.equal(h.decisions.calls.length, 0);
});

test('sources: a write tool, an unknown tool, decide itself, a masked tool and invalid arguments are refused; wire names resolve', async () => {
  const { h, ran, decide, reply } = rig();
  const write = await decide({ ...ask, source: { tool: 'files.write', args: { path: 'x', content: 'y' } } });
  assert.equal(write.isError, true);
  assert.match(textOf(write), /files\.write cannot be a source: a source only reads \(its category is write_local\)/);
  assert.match(textOf(await decide({ ...ask, source: { tool: 'files.nope' } })), /^Unknown source tool "files\.nope"/);
  assert.match(textOf(await decide({ ...ask, source: { tool: 'decide' } })), /decide cannot be a source/);
  const masked = await decide({ ...ask, source: { tool: 'files.list' } }, { mode: 'narrow' });
  assert.equal(masked.isError, true, 'decide itself runs in the narrow mode (core tool), its source does not');
  assert.match(textOf(masked), /not available in mode "narrow"/);
  assert.match(textOf(await decide({ ...ask, source: { tool: 'files.find', args: {} } })), /^Invalid arguments for the source files\.find:\nquery: required/);
  const broken = await decide({ ...ask, source: { tool: 'web.broken' } });
  assert.match(textOf(broken), /^The source web\.broken gave no output for the decision: HTTP 500/);
  assert.deepEqual(ran, [], 'no refused source ran');
  assert.equal(h.decisions.calls.length, 0, 'nothing reached the decision model');

  // The refusal does not depend on a decision model being up.
  h.decisions.up = false;
  assert.match(textOf(await decide({ ...ask, source: { tool: 'files.write' } })), /files\.write cannot be a source/);
  assert.match(textOf(await decide({ ...ask, source: { tool: 'files.list' } }, { mode: 'narrow' })), /not available in mode "narrow"/);
  assert.equal(h.runItems.filter((item) => item.kind === 'note').length, 0, 'a refused source leaves no decision note');
  h.decisions.up = true;

  h.decisions.answer({ choice: 'report-final.pdf', confidence: 0.9, by: 'fake', outcome: 'choice' }, { choice: 'report-final.pdf', confidence: 0.9, by: 'fake', outcome: 'choice' });
  assert.equal(reply(await decide({ ...ask, source: { tool: 'files__list' } })).outcome, 'choice');
  assert.equal(reply(await decide({ ...ask, source: { tool: 'mcp__workforce__files__list' } })).outcome, 'choice');
  assert.equal(ran.length, 2);
});

test('a stopped turn ends the decision: stopped during the source nothing is asked; stopped during the decision the backend call is aborted', async () => {
  const { h, registry, decide } = rig();
  const stop = new AbortController();
  registry.register(tool('files.peek', 'read', { run: async () => { stop.abort(); return { content: [{ type: 'text', text: 'peeked' }] }; } }));
  const early = await decide({ ...ask, source: { tool: 'files.peek' } }, { signal: stop.signal });
  assert.deepEqual([early.isError, textOf(early)], [true, STOPPED]);
  assert.equal(h.decisions.calls.length, 0, 'nothing reached the decision model');

  let reached!: (signal: AbortSignal) => void;
  const backendCall = new Promise<AbortSignal>((resolve) => { reached = resolve; });
  h.services.decisions = new DecisionHub({
    backends: [{ id: 'llm', available: () => true, decide: (_request, signal) => { reached(signal); return new Promise(() => {}); } }],
  });
  const turn = new AbortController();
  const pending = decide(ask, { signal: turn.signal });
  const backendSignal = await backendCall;
  turn.abort();
  const late = await pending;
  assert.deepEqual([late.isError, textOf(late)], [true, STOPPED]);
  assert.equal(backendSignal.aborted, true, 'the running backend call is aborted');
  assert.equal(h.runItems.filter((item) => item.kind === 'note').length, 0, 'a stopped call leaves no decision note');
});

test('arguments: 2..255 distinct options (also ignoring case), no "none" option, bounded context', async () => {
  const { h, decide } = rig();
  assert.match(textOf(await decide({ question: 'q', options: ['only'] })), /^Invalid arguments for decide/);
  assert.match(textOf(await decide({ question: 'q', options: Array.from({ length: 256 }, (_, i) => `o${i}`) })), /^Invalid arguments for decide/);
  assert.match(textOf(await decide({ ...ask, context: 'x'.repeat(4001) })), /^Invalid arguments for decide/);
  assert.match(textOf(await decide({ question: 'q', options: ['same', ' same '] })), /^Give at least two different options\./);
  assert.match(textOf(await decide({ question: 'q', options: ['A', 'a'] })), /^"A" and "a" differ only in case/);
  assert.match(textOf(await decide({ question: 'q', options: ['Report.pdf', 'notes.txt', 'report.pdf'] })), /^"Report\.pdf" and "report\.pdf" differ only in case/);
  assert.match(textOf(await decide({ question: 'q', options: ['a', 'None'] })), /^Leave out "none"/);
  assert.equal(h.decisions.calls.length, 0);
  h.decisions.answer({ choice: 'o254', confidence: 0.9, by: 'fake', outcome: 'choice' });
  const many = await decide({ question: 'q', options: Array.from({ length: 255 }, (_, i) => `o${i}`) });
  assert.equal(many.isError, undefined, '255 options are allowed (the hub chunks them)');
});

test('decide is a core think tool among the builtins, offered in a mode that masks everything else', () => {
  const { registry, h, modes } = rig();
  const entry = builtinTools().find((candidate) => candidate.name === 'decide');
  assert.equal(entry?.category, 'think');
  const offered = registry.specsFor(h.org.require('ag_tom'), modes.narrow).map((spec) => spec.name);
  assert.deepEqual(offered, ['decide']);
});
