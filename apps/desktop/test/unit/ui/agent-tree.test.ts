// AF-004 – the chat's agent view (ui/agents/agent-tree.ts, like Claude Code's agent list): the tree – one root per live
// main-lane run in start order, a waiting root for an agent whose parts still run after its turn, parts under the run
// that split (else the agent's first root), one level folded away for a single group and group rows for several – and
// the summaries – a part's one line, a parent's state from its parts, the counts and headline, a collapsed parent's
// line, steps, the compact run time – plus the static promises of the view (its tour name, the reserved Stop cell, the
// chat using it only for several agents).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LiveStep, Message } from '../../../src/shared/model/chat.ts';
import type { AgentActivity, RunItem } from '../../../src/shared/model/runs.ts';
import type { SplitGroupView, SplitStatus, SplitView } from '../../../src/shared/model/splits.ts';
import {
  buildAgentTree, collapsedActivity, combinedState, countStates, elapsedShort, headline, isMultiAgent, journalSteps, openByDefault,
  partsBelow, partsLine, runActivity, splitActivity, splitState, stepsLabel,
} from '../../../src/ui/agents/agent-tree.ts';
import type { AgentNode, TreeInput } from '../../../src/ui/agents/agent-tree.ts';

const T = 1_800_000_000_000;
const NAMES: Record<string, string> = { ag_mira: 'Mira', ag_quill: 'Quill' };

const step = (target: string, patch: Partial<LiveStep> = {}): LiveStep => ({ kind: 'command', verb: 'Ran', active: 'Running', target, ...patch });

function liveRow(runId: string, agentId: string, startedAt: number, patch: { note?: string; steps?: LiveStep[]; more?: number; body?: string } = {}): Message {
  return {
    id: `msg_${runId}`, conversationId: 'c1', seq: 10, authorKind: 'agent', authorId: agentId, runId, kind: 'text', state: 'streaming',
    body: patch.body ?? '', attachments: [], createdAt: startedAt,
    meta: { live: { note: patch.note, steps: patch.steps ?? [], more: patch.more ?? 0, startedAt, model: 'Claude Opus 5.5', effort: 'high' } },
  } as unknown as Message;
}

function part(idx: number, status: SplitStatus, patch: Partial<SplitView> = {}): SplitView {
  return {
    id: `sp_${idx}`, groupId: 'sg_1', agentId: 'ag_mira', idx, of: 3, title: `Part ${idx}`, brief: 'Do it', context: 'brief', after: [],
    worktree: false, status, attempts: 0, createdAt: T, runs: 0, ...patch,
  };
}

function group(id: string, splits: SplitView[], patch: Partial<SplitGroupView> = {}): SplitGroupView {
  return {
    id, agentId: 'ag_mira', parentRunId: 'run_split', conversationId: 'c1', thread: 'c1', goal: 'Write the landing page', ultra: false,
    status: 'running', parts: splits.length, createdAt: T, startedAt: T + 1_000, splits: splits.map((split) => ({ ...split, groupId: id })), ...patch,
  };
}

const live = (splitId: string, note: string, startedAt: number): AgentActivity => ({
  agentId: 'ag_mira', runId: `run_${splitId}`, conversationId: 'c1', note, startedAt, modelName: 'Claude Sonnet 5.5', effort: 'low',
  split: { id: splitId, groupId: 'sg_1', idx: 1, of: 3, parentRunId: 'run_split', title: 'Part' },
});

function input(patch: Partial<TreeInput>): TreeInput {
  return { runs: [], groups: [], activity: [], nameOf: (id) => NAMES[id] ?? id, ...patch };
}

const shape = (nodes: AgentNode[]): unknown => nodes.map((node) => ({ key: node.key, state: node.state, children: shape(node.children) }));

test('a main agent with two parallel parts and one waiting part: one root, its parts below it in part order', () => {
  const tree = buildAgentTree(input({
    runs: [liveRow('run_main', 'ag_mira', T + 5_000, { note: 'Building the site', steps: [step('npm run build', { running: true })], more: 3 })],
    groups: [group('sg_1', [
      part(2, 'running', { startedAt: T + 2_000 }), part(1, 'running', { startedAt: T + 2_000 }), part(3, 'pending', { after: [1] }),
    ])],
    activity: [live('sp_1', 'Reading the brief\nand more', T + 2_100), live('sp_2', 'Collecting screenshots', T + 2_200)],
  }));
  assert.deepEqual(shape(tree), [{ key: 'run:run_main', state: 'running', children: [
    { key: 'split:sp_1', state: 'running', children: [] },
    { key: 'split:sp_2', state: 'running', children: [] },
    { key: 'split:sp_3', state: 'waiting', children: [] },
  ] }]);
  const [root] = tree;
  assert.equal(root.title, 'Mira');
  assert.equal(root.activity, 'Building the site');
  assert.equal(root.steps, 4, 'the row\'s steps and the earlier ones it only counts');
  assert.equal(root.model, 'Opus 5.5 · High');
  assert.deepEqual(root.stop, { kind: 'run', runId: 'run_main' });
  const [one, two, three] = root.children;
  assert.equal(one.title, '#1 Part 1');
  assert.equal(one.activity, 'Reading the brief', 'one line');
  assert.equal(one.runId, 'run_sp_1', 'a running part opens the run of its live activity');
  assert.equal(one.model, 'Sonnet 5.5 · Low');
  assert.equal(two.activity, 'Collecting screenshots');
  assert.equal(three.activity, 'Waiting for #1');
  assert.equal(three.startedAt, undefined, 'a part that has not started has no run time');
  assert.deepEqual(three.stop, { kind: 'split', splitId: 'sp_3' });
  assert.ok(isMultiAgent(tree));
});

test('an agent whose turn ended while its parts run waits for them; finished parts have no Stop', () => {
  const tree = buildAgentTree(input({
    groups: [group('sg_1', [part(1, 'done', { startedAt: T + 1_000, endedAt: T + 9_000, run: { id: 'run_a', status: 'done', summary: 'Wrote the hero text\nmore' } as SplitView['run'] }), part(2, 'running')])],
  }));
  assert.equal(tree.length, 1);
  const [root] = tree;
  assert.equal(root.key, 'agent:ag_mira');
  assert.equal(root.state, 'waiting');
  assert.equal(root.activity, 'Waiting for its parts · Write the landing page');
  assert.equal(root.startedAt, T + 1_000, 'it waits since its group started');
  assert.equal(root.runId, undefined, 'no steps of its own to open');
  assert.deepEqual(root.stop, { kind: 'groups', groupIds: ['sg_1'] });
  assert.equal(root.children[0].activity, 'Done · Wrote the hero text');
  assert.equal(root.children[0].endedAt, T + 9_000);
  assert.equal(root.children[0].stop, undefined);
});

test('several groups of one agent get one group row each; parts go under the run that split', () => {
  const g1 = group('sg_1', [part(1, 'done'), part(2, 'failed', { error: 'The model could not complete this turn.' })], { startedAt: T + 1_000, parentRunId: 'run_b' });
  const g2 = group('sg_2', [part(1, 'running'), part(2, 'queued')], { goal: 'Check the links\nsecond line', startedAt: T + 3_000, parentRunId: 'run_b' });
  const tree = buildAgentTree(input({
    runs: [liveRow('run_a', 'ag_mira', T), liveRow('run_b', 'ag_mira', T + 500), liveRow('run_q', 'ag_quill', T + 200)],
    groups: [g2, g1],
  }));
  assert.deepEqual(tree.map((node) => node.key), ['run:run_a', 'run:run_q', 'run:run_b'], 'roots in start order');
  assert.equal(tree[0].children.length, 0);
  const parent = tree[2];
  assert.deepEqual(parent.children.map((node) => `${node.key} ${node.state}`), ['group:sg_1 failed', 'group:sg_2 running']);
  assert.equal(parent.children[0].activity, '1 of 2 parts done · 1 failed');
  assert.equal(parent.children[0].stop, undefined, 'a settled group has nothing to stop');
  assert.equal(parent.children[1].title, 'Check the links');
  assert.equal(parent.children[1].activity, '1 of 2 parts running');
  assert.deepEqual(parent.children[1].stop, { kind: 'groups', groupIds: ['sg_2'] });
  assert.equal(parent.children[0].children[1].activity, 'The model could not complete this turn.');
  assert.equal(partsBelow(parent).length, 4, 'group rows are looked through');
  const counts = countStates(tree);
  assert.deepEqual(counts, { total: 7, running: 4, waiting: 1, done: 1, failed: 1, stopped: 0 }, 'group rows are no agents');
  assert.equal(headline(counts), '7 agents · 4 running · 1 waiting · 1 done · 1 failed');
});

test('a run-less agent without groups is no row; two main lanes alone are several agents', () => {
  assert.deepEqual(buildAgentTree(input({})), []);
  const two = buildAgentTree(input({ runs: [liveRow('run_q', 'ag_quill', T + 9), liveRow('run_m', 'ag_mira', T)] }));
  assert.deepEqual(two.map((node) => node.title), ['Mira', 'Quill']);
  assert.ok(isMultiAgent(two));
  assert.ok(!isMultiAgent(buildAgentTree(input({ runs: [liveRow('run_m', 'ag_mira', T)] }))), 'one agent alone keeps its live block');
});

test('a main lane\'s one line: its newest words, its note, else the running step instead of a bare "Working"', () => {
  const running = step('npm run build', { running: true });
  assert.equal(runActivity({ steps: [running], body: 'First paragraph.\n\nNow I check the build' }), 'Now I check the build');
  assert.equal(runActivity({ steps: [running], note: 'Waiting for the reviewer' }), 'Waiting for the reviewer');
  assert.equal(runActivity({ steps: [running], note: 'Running npm run build' }), 'Running npm run build', 'a note that repeats the step: the step');
  assert.equal(runActivity({ steps: [step('npm test')] }), 'Ran npm test');
  assert.equal(runActivity({ steps: [{ kind: 'tool', verb: 'Thought', active: 'Thinking', target: 'Planning the page', thought: true }] }), 'Planning the page');
  assert.equal(runActivity({ steps: [] }), 'Working');
});

test('a part\'s one line and state', () => {
  assert.equal(splitActivity(part(1, 'running'), '  '), 'Working');
  assert.equal(splitActivity(part(1, 'queued')), 'Queued');
  assert.equal(splitActivity(part(3, 'pending', { after: [1, 2] })), 'Waiting for #1, #2');
  assert.equal(splitActivity(part(1, 'failed')), 'Failed');
  assert.equal(splitActivity(part(1, 'failed', { run: { error: 'Timed out\ntrace' } as SplitView['run'] })), 'Timed out');
  assert.equal(splitActivity(part(1, 'done')), 'Done');
  assert.equal(splitActivity(part(1, 'skipped')), 'Skipped');
  assert.equal(splitActivity(part(1, 'stopped')), 'Stopped');
  assert.deepEqual((['pending', 'queued', 'running', 'done', 'failed', 'stopped', 'skipped'] as SplitStatus[]).map(splitState),
    ['waiting', 'waiting', 'running', 'done', 'failed', 'stopped', 'done']);
});

test('a parent\'s state sums up its parts: running, then waiting, then failed; all stopped is stopped', () => {
  assert.equal(combinedState(['done', 'running', 'failed']), 'running');
  assert.equal(combinedState(['done', 'waiting', 'failed']), 'waiting');
  assert.equal(combinedState(['done', 'failed', 'stopped']), 'failed');
  assert.equal(combinedState(['stopped', 'stopped']), 'stopped');
  assert.equal(combinedState(['done', 'stopped']), 'done');
  assert.equal(combinedState([]), 'done');
});

test('summaries: the parts line, a collapsed parent, the headline, steps', () => {
  const node = (state: AgentNode['state']): AgentNode => ({ key: state, kind: 'split', agentId: 'a', title: '', state, activity: '', live: false, model: '', children: [] });
  assert.equal(partsLine([]), '');
  assert.equal(partsLine([node('running'), node('running'), node('done')]), '2 of 3 parts running');
  assert.equal(partsLine([node('waiting'), node('done')]), '1 of 2 parts waiting');
  assert.equal(partsLine([node('done'), node('done')]), '2 parts done');
  assert.equal(partsLine([node('done')]), '1 part done');
  assert.equal(partsLine([node('done'), node('stopped'), node('failed')]), '1 of 3 parts done · 1 failed · 1 stopped');
  const parent: AgentNode = { ...node('running'), kind: 'agent', activity: 'Building the site', children: [node('running'), node('done')] };
  assert.equal(collapsedActivity(parent), 'Building the site · 1 of 2 parts running');
  assert.equal(collapsedActivity({ ...parent, children: [] }), 'Building the site');
  assert.equal(headline({ total: 1, running: 1, waiting: 0, done: 0, failed: 0, stopped: 0 }), '1 agent · 1 running');
  assert.equal(stepsLabel(undefined), '');
  assert.equal(stepsLabel(0), '');
  assert.equal(stepsLabel(1), '1 step');
  assert.equal(stepsLabel(12), '12 steps');
  const item = (seq: number, kind: RunItem['kind'], data: Record<string, unknown> = {}, name?: string): RunItem => ({ id: `i${seq}`, runId: 'r', seq, kind, name, data, createdAt: T + seq });
  assert.equal(journalSteps([
    item(1, 'tool_call', { callId: 'c1', args: '{}' }, 'files.read'), item(2, 'tool_result', { callId: 'c1', ok: true }),
    item(3, 'reasoning', { summary: '' }), item(4, 'reasoning', { summary: '**Plan** the page' }), item(5, 'tool_call', { callId: 'c2' }, 'shell.exec'),
  ]), 3, 'a call with its result is one step; an empty thought is none');
});

test('parents start open; the compact run time', () => {
  const tree = buildAgentTree(input({ runs: [liveRow('run_main', 'ag_mira', T)], groups: [group('sg_1', [part(1, 'running')]), group('sg_2', [part(1, 'running')], { startedAt: T + 5_000 })] }));
  assert.deepEqual([...openByDefault(tree)], ['run:run_main', 'group:sg_1', 'group:sg_2']);
  assert.equal(elapsedShort(undefined, undefined, T), '');
  assert.equal(elapsedShort(T, undefined, T + 8_400), '8s');
  assert.equal(elapsedShort(T, undefined, T + 65_000), '1m 05s');
  assert.equal(elapsedShort(T, T + 3_780_000, T + 9_999_999), '1h 03m', 'an ended row keeps its time');
  assert.equal(elapsedShort(T + 5_000, undefined, T), '0s', 'never negative');
});

test('the view: its tour name, a reserved Stop cell per row, and the chat uses it only for several agents', () => {
  const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
  const view = readFileSync(path.join(ui, 'agents', 'AgentView.tsx'), 'utf8');
  assert.match(view, /data-tour="agent-view"/);
  assert.match(view, /<span class="agents-row-stop">\s*\{stop && /, 'the cell is always there; the button only where a stop exists');
  const stop = readFileSync(path.join(ui, 'agents', 'agent-stop.ts'), 'utf8');
  assert.match(stop, /can\('runs\.cancel'\)/);
  assert.match(stop, /can\('splits\.stop'\)/);
  const working = readFileSync(path.join(ui, 'chat', 'WorkingMessage.tsx'), 'utf8');
  assert.match(working, /if \(live\.length > 1 \|\| liveGroups\.length\) return <AgentView /);
  const css = readFileSync(path.join(ui, 'styles', 'index.css'), 'utf8');
  assert.match(css, /@import "\.\/agent-view\.css";/);
});
