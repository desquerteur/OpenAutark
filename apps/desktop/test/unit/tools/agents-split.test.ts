// B-057 – the split tools through the real tool registry (fake split service):
// - agents.split validates its schema (goal, 1–12 parts, the exact context / effort enums, after, worktree), hands the
//   service the calling turn's facts (agent, run, chat, task, origin, thread = the turn's threadKey, mode, working
//   folder) and answers {ok, groupId, parts, next} with the "I end my turn now" line; a refusal of the service says
//   nothing was split; a split's own call is refused at the gate (split lock) and by the tool itself;
// - agents.split_results reads the thread's results (a split: its parent's thread); agents.split_stop stops only the
//   agent's own groups, a part by its number, or every active group of this thread;
// - agents.split is lean (≤ 900 characters of description: it is offered on every turn), found by tools.find, and its
//   step reads "Split into N parts"; agents.split_merge's reads "Merged / Discarded split part #k" (the offer in every
//   shipped mode: agents-split-offer.test.ts).
// Owns: these assertions only. Never: real engines, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { splitTools, nextText } from '../../../src/runtime/tools/builtin/agents-split.ts';
import { rankTools } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { stepLabel, stepText } from '../../../src/shared/text/step-label.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { agent } from '../chat/harness.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { SplitCreateContext, SplitService } from '../../../src/runtime/contracts/splits.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { SplitGroupView, SplitPartInput, SplitTurn } from '../../../src/shared/model/splits.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';

const MODE = { key: 'general', name: 'General', tools: ['*'] } as unknown as ModeInfo;
const WORKSPACE = 'C:/ws';

function group(id: string, agentId: string, thread: string, titles: string[]): SplitGroupView {
  return {
    id, agentId, parentRunId: 'run_1', thread, goal: 'g', ultra: false, status: 'pending', parts: titles.length, createdAt: 1,
    splits: titles.map((title, index) => ({ id: `spl_${id}_${index + 1}`, groupId: id, agentId, idx: index + 1, of: titles.length, title, brief: 'b', context: 'fork', after: [], worktree: false, status: 'pending', attempts: 0, createdAt: 1, runs: 0 })),
  };
}

function rig(options: { refuse?: string; noService?: boolean; groups?: SplitGroupView[] } = {}) {
  const created: Array<{ ctx: SplitCreateContext; input: { goal: string; parts: SplitPartInput[] } }> = [];
  const asked: Array<{ agentId: string; q: Record<string, unknown> }> = [];
  const stopped: Array<{ q: Record<string, unknown>; by: string }> = [];
  const groups = options.groups ?? [];
  const splits = {
    create(ctx: SplitCreateContext, input: { goal: string; parts: SplitPartInput[] }) {
      if (options.refuse) throw new WorkforceError('bad_request', options.refuse);
      created.push({ ctx, input });
      return group('sgr_1', ctx.agentId, ctx.thread, input.parts.map((part) => part.title));
    },
    results(agentId: string, q: Record<string, unknown>) { asked.push({ agentId, q }); return 'Split results: #1 done.'; },
    list(q: { groupId?: string; agentId?: string; active?: boolean }) {
      return groups.filter((item) => (!q.groupId || item.id === q.groupId) && (!q.agentId || item.agentId === q.agentId));
    },
    stop(q: Record<string, unknown>, by: string) { stopped.push({ q, by }); return q.splitId ? 1 : 2; },
  } as unknown as SplitService;
  const services = {
    modes: { get: () => MODE },
    runs: { item: () => ({ id: 'ri_1' }), updateItem: () => undefined },
    db: { get: () => undefined },
    tasks: { get: () => undefined },
    paths: { workspace: WORKSPACE },
    secrets: { redact: (value: string) => value },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...(options.noService ? {} : { splits }),
  } as unknown as RuntimeServices;
  const registry = new Registry({ services: () => services });
  for (const tool of splitTools) registry.register(tool);
  const tom = agent('ag_tom', 'Tom');
  let n = 0;
  const call = async (name: string, args: unknown, extra: Partial<ToolContext> = {}) => {
    const out = await registry.call(name, args, { agent: tom, runId: 'run_1', conversationId: 'conv_1', mode: 'general', signal: new AbortController().signal, status: () => {}, ...extra }, `call_${++n}`);
    const text = out.content.map((part) => ('text' in part ? part.text : '')).join('\n');
    let data: Record<string, any> | undefined;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { failed: Boolean(out.isError), text, data };
  };
  return { call, created, asked, stopped };
}

const TWO = [{ title: 'Search the docs', brief: 'Find every mention of X.' }, { title: 'Check #1', brief: 'Try to refute part #1.', context: 'brief', model: 'cheap', effort: 'low', after: [1] }];

test('the schema: goal and 1–12 parts with the exact enums; nothing reaches the service when it fails', async () => {
  const r = rig();
  const bad = [
    {}, { goal: 'x' }, { goal: '', parts: TWO }, { goal: 'x', parts: [] },
    { goal: 'x', parts: Array.from({ length: 13 }, (_, i) => ({ title: `p${i}`, brief: 'b' })) },
    { goal: 'x', parts: [{ title: 'a' }] }, { goal: 'x', parts: [{ title: 'a', brief: 'b', context: 'full' }] },
    { goal: 'x', parts: [{ title: 'a', brief: 'b', effort: 'minimal' }] }, { goal: 'x', parts: [{ title: 'a', brief: 'b', after: [0] }] },
    { goal: 'x', parts: [{ title: 'a', brief: 'b', worktree: 'yes' }] }, { goal: 'x', parts: [{ title: 'a', brief: 'b', mode: 'web' }] },
    { goal: 'x'.repeat(401), parts: TWO }, { goal: 'x', parts: [{ title: 't'.repeat(81), brief: 'b' }] },
    { goal: 'x', parts: [{ title: 'a', brief: 'b'.repeat(4001) }] }, { goal: 'x', parts: TWO, extra: 1 },
  ];
  for (const args of bad) {
    const out = await r.call('agents.split', args);
    assert.ok(out.failed && /Invalid arguments for agents\.split/.test(out.text), JSON.stringify(args).slice(0, 80));
  }
  assert.equal(r.created.length, 0);
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal((await r.call('agents.split', { goal: 'x', parts: [{ title: 'a', brief: 'b', effort, context: 'fork', worktree: true, returns: 'a list' }] })).failed, false, effort);
  }
});

test('create gets the calling turn\'s facts; the result lists the parts and tells the agent to end its turn', async () => {
  const r = rig();
  const origin = { source: 'news', label: 'Task news' };
  const out = await r.call('agents.split', { goal: 'Audit the docs', parts: TWO }, { taskId: 'task_1', origin, mode: 'research' });
  assert.equal(out.failed, false, out.text);
  const [{ ctx, input }] = r.created;
  assert.deepEqual(ctx, { agentId: 'ag_tom', runId: 'run_1', thread: 'conv_1', modeKey: 'research', conversationId: 'conv_1', taskId: 'task_1', origin, cwd: WORKSPACE });
  assert.equal(input.goal, 'Audit the docs');
  assert.deepEqual(input.parts, TWO);
  assert.deepEqual(out.data, {
    ok: true, groupId: 'sgr_1',
    parts: [{ idx: 1, title: 'Search the docs', id: 'spl_sgr_1_1' }, { idx: 2, title: 'Check #1', id: 'spl_sgr_1_2' }],
    next: 'My 2 splits start as soon as this turn ends. I end my turn now (a short line to the person fits). Their results come back to me in one block.',
  });
  assert.equal(nextText(1), 'My split starts as soon as this turn ends. I end my turn now (a short line to the person fits). Their results come back to me in one block.');

  await r.call('agents.split', { goal: 'g', parts: TWO }, { conversationId: undefined, taskId: 'task_9' });
  assert.equal(r.created[1].ctx.thread, 'task:task_9', 'a chat-free task: its thread');
  assert.ok(!('conversationId' in r.created[1].ctx));
});

test('a refusal of the service says nothing was split; without a split service the agent does the parts itself', async () => {
  const refused = await rig({ refuse: 'You already have 3 active split groups.' }).call('agents.split', { goal: 'g', parts: TWO });
  assert.ok(refused.failed);
  assert.equal(refused.text, 'You already have 3 active split groups. Nothing was split.');
  const missing = await rig({ noService: true }).call('agents.split', { goal: 'g', parts: TWO });
  assert.ok(missing.failed && /not available here/.test(missing.text));
});

const SPLIT: SplitTurn = { splitId: 'spl_x', groupId: 'sgr_x', idx: 1, of: 2, title: 't', parentRunId: 'run_p', parentThread: 'conv_parent', parentConversationId: 'conv_parent', context: 'fork', firstTurn: true };

test('agents.split_results reads the thread\'s results – a split reads its parent\'s thread', async () => {
  const r = rig();
  const out = await r.call('agents.split_results', { groupId: 'sgr_1', idx: 2 });
  assert.equal(out.text, 'Split results: #1 done.');
  assert.deepEqual(r.asked[0], { agentId: 'ag_tom', q: { groupId: 'sgr_1', idx: 2, thread: 'conv_1' } });
  await r.call('agents.split_results', {}, { conversationId: undefined, split: SPLIT });
  assert.deepEqual(r.asked[1].q, { thread: 'conv_parent' });
  assert.ok((await r.call('agents.split_results', { idx: 13 })).failed, 'idx ≤ 12');
});

test('agents.split_stop stops only the agent\'s own groups: a part by number, a group, or every active group of this thread', async () => {
  const mine = group('sgr_a', 'ag_tom', 'conv_1', ['a', 'b']);
  const elsewhere = group('sgr_b', 'ag_tom', 'conv_other', ['c']);
  const foreign = group('sgr_c', 'ag_ann', 'conv_1', ['d']);
  const r = rig({ groups: [mine, elsewhere, foreign] });
  const part = await r.call('agents.split_stop', { groupId: 'sgr_a', idx: 2 });
  assert.deepEqual(part.data, { ok: true, stopped: 1 });
  assert.deepEqual(r.stopped[0], { q: { splitId: 'spl_sgr_a_2' }, by: 'ag_tom' });
  assert.deepEqual((await r.call('agents.split_stop', { groupId: 'sgr_a' })).data, { ok: true, stopped: 2 });
  assert.deepEqual(r.stopped[1].q, { groupId: 'sgr_a' });
  const theirs = await r.call('agents.split_stop', { groupId: 'sgr_c' });
  assert.ok(theirs.failed && /no split group sgr_c/.test(theirs.text), 'another agent\'s group');
  assert.ok((await r.call('agents.split_stop', { groupId: 'sgr_a', idx: 5 })).failed, 'no such part');
  assert.ok((await r.call('agents.split_stop', { idx: 1 })).failed, 'a part needs its group');
  const before = r.stopped.length;
  await r.call('agents.split_stop', {});
  assert.deepEqual(r.stopped.slice(before).map((entry) => entry.q), [{ groupId: 'sgr_a' }], 'only this thread\'s own groups');
});

test('lean, teaching when and how, found by tools.find, and its steps read "Split into N parts"', () => {
  const split = splitTools.find((tool) => tool.name === 'agents.split')!;
  const spec = JSON.stringify({ name: split.name, description: split.description, inputSchema: split.inputSchema });
  // Offered on every turn of every agent (BASE_CORE): the description stays ≤ 900 characters, the spec under ~425 tokens.
  assert.ok(split.description.length <= 900, `${split.description.length} characters of description`);
  assert.ok(spec.length / 4 < 425, `${spec.length} characters of spec`);
  assert.doesNotMatch(JSON.stringify(split.inputSchema), /"description"/, 'no property descriptions: the description says it once');
  for (const word of [
    'code changes on separate files', 'broad searches', 'many analyses', 'collating data', 'independent checks', 'when this turn ends', 'end my turn',
    'fork (default: knows this conversation)', 'brief (fresh, cheaper, independent)', 'same|cheap|strong|<id>', 'effort', 'after = parts it runs after, getting their results',
    'pipelines', 'worktree: true = own git branch from my last commit', 'commit first', 'agents.split_merge', 'separate files',
    'browser work goes to one part only', 'never split, talk to people or remember',
  ]) {
    assert.ok(split.description.includes(word), word);
  }
  const specs = [...splitTools, ...['agents.delegate', 'agents.list', 'tasks.create'].map((name) => ({ name, description: 'Give work to a colleague.', inputSchema: {} }))]
    .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  assert.equal(rankTools(specs, 'parallel workers fan-out', 3)[0]?.name, 'agents.split');

  assert.equal(stepText(stepLabel('agents.split', { goal: 'g', parts: TWO })), 'Split into 2 parts');
  assert.equal(stepText(stepLabel('agents.split', { goal: 'g', parts: TWO }), true), 'Splitting into 2 parts');
  assert.equal(stepText(stepLabel('agents.split', undefined, { summary: 'Split into 3 parts: a, b, c' })), 'Split into 3 parts');
  assert.equal(stepText(stepLabel('agents.split', { parts: [TWO[0]] })), 'Split into 1 part');
  assert.equal(stepText(stepLabel('agents.split_results', { groupId: 'sgr_1' })), 'Read split results');
  assert.equal(stepText(stepLabel('agents.split_stop', {})), 'Stopped splits');
  assert.equal(stepLabel('agents.split', {}).kind, 'agent');
  // agents.split_merge by its action (agents-split-merge.ts), else by its summary ("Discard part #2 …").
  assert.equal(stepText(stepLabel('agents.split_merge', { groupId: 'sgr_1', idx: 2, action: 'merge' })), 'Merged split part #2');
  assert.equal(stepText(stepLabel('agents.split_merge', { groupId: 'sgr_1', idx: 2, action: 'merge' }), true), 'Merging split part #2');
  assert.equal(stepText(stepLabel('agents.split_merge', { groupId: 'sgr_1', idx: 3, action: 'discard' })), 'Discarded split part #3');
  assert.equal(stepText(stepLabel('agents.split_merge', { action: 'discard' }), true), 'Discarding split part');
  assert.equal(stepText(stepLabel('agents.split_merge', {})), 'Merged split part');
  assert.equal(stepText(stepLabel('agents.split_merge', undefined, { summary: 'Discard part #1 "Docs" (wf/split-docs-abc123, 2 files): delete its branch and folder' })), 'Discarded split part');
  assert.equal(stepLabel('agents.split_merge', {}).kind, 'agent');
});
