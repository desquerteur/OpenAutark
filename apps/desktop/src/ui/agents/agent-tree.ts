// AF-004 – the agent view's tree (like Claude Code's agent list): every agent at work in a chat as one compact row –
// name, state (running · waiting · done · failed · stopped), what it does right now in one line and how long it runs –
// with its parts (B-057 splits, the "sub-agents") indented below the agent that split, one row each. An agent with one
// running group gets its parts right under its row; an agent with several gets one group row per goal in between
// (folding a single level away is the first "summary" rule). Collapsed rows summarise what they hide: a parent's parts
// ("2 of 3 parts running"), the steps of a run ("4 steps", its tool calls stay folded until the row opens) and the whole
// view in its headline ("4 agents · 2 running · 1 waiting · 1 done").
// Sources: the chat's live rows (B-075 meta.live – the main lanes), its live split groups and the live activity (a part's
// note and start while it runs). An agent whose turn ended while its parts still run is the root too, waiting for them.
// Owns: the node shape, the tree rules, the state and summary words and the elapsed format (unit-tested in
// test/unit/ui/agent-tree.test.ts). Never: imports the store, rpc or the DOM, or invents a step or a state.

import type { LiveStep, Message } from '../../shared/model/chat.ts';
import type { AgentActivity, RunItem } from '../../shared/model/runs.ts';
import type { SplitGroupView, SplitStatus, SplitView } from '../../shared/model/splits.ts';
import { stepText } from '../../shared/text/step-label.ts';
import { workingLine } from '../chat/run-line.ts';
import { liveStart } from '../chat/message-rows.ts';
import { modelLine } from '../chat/live-text.ts';
import { groupStart, isSettled, liveOfSplit, partLabel } from '../splits/split-text.ts';
import { runEntries } from '../team/model.ts';
import { shownEntry } from '../team/step-view.ts';

/** The five states a row can show (a skipped part counts as done – it had nothing left to do). */
export type AgentState = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export const STATE_LABEL: Record<AgentState, string> = {
  running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', stopped: 'Stopped',
};

/** What the row's Stop ends: a main-lane run (runs.cancel), one part, or every part of these groups (splits.stop). */
export type StopTarget = { kind: 'run'; runId: string } | { kind: 'split'; splitId: string } | { kind: 'groups'; groupIds: string[] };

export interface AgentNode {
  /** Stable across updates: `run:<id>`, `agent:<agentId>`, `group:<id>`, `split:<id>`. */
  key: string;
  kind: 'agent' | 'group' | 'split';
  agentId: string;
  title: string;
  state: AgentState;
  /** One line: the newest words, the running step, what it waits for, or how it ended. */
  activity: string;
  startedAt?: number;
  endedAt?: number;
  /** The run whose steps the row opens (a waiting root has none). */
  runId?: string;
  /** The run still works: its steps stay live. */
  live: boolean;
  /** Steps the row knows without the journal (a main run's row); undefined until a part's items are read. */
  steps?: number;
  /** A main run's newest steps from its row (meta.live.steps), the list it shows before the journal is read. */
  liveSteps?: LiveStep[];
  more?: number;
  /** "Opus 5.5 · High" for the row's tooltip ('' while routing). */
  model: string;
  stop?: StopTarget;
  /** A part's split (its menu: Open · Stop). */
  split?: SplitView;
  children: AgentNode[];
}

export interface TreeInput {
  /** The chat's live rows (message-rows.ts liveWork), oldest start first. */
  runs: readonly Message[];
  /** The chat's live split groups (split-text.ts chatGroups). */
  groups: readonly SplitGroupView[];
  activity: readonly AgentActivity[];
  nameOf: (agentId: string) => string;
  modelOf?: (id: string) => string | undefined;
}

/** A part's state from its split status. */
export function splitState(status: SplitStatus): AgentState {
  switch (status) {
    case 'running': return 'running';
    case 'pending': case 'queued': return 'waiting';
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    default: return 'done';
  }
}

/** A parent's state from its children: running before waiting before failed; all stopped is stopped, else done. */
export function combinedState(states: readonly AgentState[]): AgentState {
  if (!states.length) return 'done';
  for (const state of ['running', 'waiting', 'failed'] as const) if (states.includes(state)) return state;
  return states.every((state) => state === 'stopped') ? 'stopped' : 'done';
}

const firstLine = (text: string | undefined): string => text?.split('\n').map((line) => line.trim()).find(Boolean) ?? '';

/** A part's one line: its live note while it runs, whom it waits for, how it ended (its summary or error). */
export function splitActivity(split: Pick<SplitView, 'status' | 'after' | 'error' | 'run'>, note?: string): string {
  const state = splitState(split.status);
  if (state === 'running') return firstLine(note) || 'Working';
  if (state === 'waiting') return split.after.length ? `Waiting for ${split.after.map((idx) => `#${idx}`).join(', ')}` : 'Queued';
  if (state === 'failed') return firstLine(split.error ?? split.run?.error) || 'Failed';
  if (split.status === 'skipped') return 'Skipped';
  if (state === 'stopped') return 'Stopped';
  const summary = firstLine(split.run?.summary);
  return summary ? `Done · ${summary}` : 'Done';
}

function splitNode(split: SplitView, agentId: string, input: TreeInput): AgentNode {
  const live = split.status === 'running' ? liveOfSplit(input.activity, split.id) : undefined;
  const run = split.run;
  const model = run?.model ? modelLine({ modelName: input.modelOf?.(run.model) ?? run.model, effort: run.effort })
    : modelLine(live ? { model: live.model, modelName: live.modelName, effort: live.effort } : undefined);
  return {
    key: `split:${split.id}`, kind: 'split', agentId, title: partLabel(split), state: splitState(split.status),
    activity: splitActivity(split, live?.note),
    startedAt: split.startedAt ?? run?.startedAt ?? live?.startedAt,
    endedAt: isSettled(split.status) ? split.endedAt ?? run?.endedAt : undefined,
    runId: run?.id ?? live?.runId, live: split.status === 'running', model,
    ...(isSettled(split.status) ? {} : { stop: { kind: 'split', splitId: split.id } as StopTarget }),
    split, children: [],
  };
}

/** One group's parts in part order. */
function partsOf(group: SplitGroupView, input: TreeInput): AgentNode[] {
  return group.splits.slice().sort((a, b) => a.idx - b.idx).map((split) => splitNode(split, group.agentId, input));
}

/** A group's row (only where an agent has several running groups): its goal and how far its parts are. */
function groupNode(group: SplitGroupView, input: TreeInput): AgentNode {
  const children = partsOf(group, input);
  const open = group.splits.filter((split) => !isSettled(split.status)).map((split) => split.id);
  return {
    key: `group:${group.id}`, kind: 'group', agentId: group.agentId, title: firstLine(group.goal) || 'Parts',
    state: combinedState(children.map((child) => child.state)), activity: partsLine(children),
    startedAt: groupStart(group), live: open.length > 0, model: '',
    ...(open.length ? { stop: { kind: 'groups', groupIds: [group.id] } as StopTarget } : {}),
    children,
  };
}

/**
 * A main lane's one line: the live block's line (its newest words, else its note) – where that would only say "Working"
 * because the note repeats the newest step, the step itself ("Running npm run build", a thought's headline).
 */
export function runActivity(input: { steps: readonly LiveStep[]; body?: string; note?: string }): string {
  const line = workingLine(input);
  const newest = input.steps.at(-1);
  if (line !== 'Working' || !newest) return line;
  return (newest.thought ? newest.target : stepText(newest, newest.running === true)).trim() || line;
}

/** A main lane's row from its live row (B-075 meta.live). */
function runNode(message: Message, input: TreeInput): AgentNode {
  const live = message.meta.live;
  const steps = live?.steps ?? [];
  const runId = message.runId ?? message.id;
  return {
    key: `run:${runId}`, kind: 'agent', agentId: message.authorId, title: input.nameOf(message.authorId), state: 'running',
    activity: runActivity({ steps, body: message.body, note: live?.note }), startedAt: liveStart(message),
    runId, live: true, steps: steps.length + (live?.more ?? 0), liveSteps: steps, more: live?.more ?? 0,
    model: modelLine(live ? { modelName: live.model, effort: live.effort } : undefined, message.meta),
    stop: { kind: 'run', runId }, children: [],
  };
}

/** The root of an agent whose own turn ended while its parts still run: it waits for them. */
function waitingRoot(agentId: string, groups: readonly SplitGroupView[], input: TreeInput): AgentNode {
  const goal = groups.length === 1 ? firstLine(groups[0].goal) : '';
  const open = groups.filter((group) => group.splits.some((split) => !isSettled(split.status))).map((group) => group.id);
  return {
    key: `agent:${agentId}`, kind: 'agent', agentId, title: input.nameOf(agentId), state: 'waiting',
    activity: goal ? `Waiting for its parts · ${goal}` : 'Waiting for its parts',
    startedAt: Math.min(...groups.map(groupStart)), live: false, model: '',
    ...(open.length ? { stop: { kind: 'groups', groupIds: open } as StopTarget } : {}),
    children: [],
  };
}

/**
 * The chat's agents at work as a tree, in start order: one root per live main-lane run; an agent with running groups
 * but no live run gets a waiting root. Parts go under the root of the run that split (else the agent's first root);
 * one group per agent puts its parts right under the root, several insert one group row each.
 */
export function buildAgentTree(input: TreeInput): AgentNode[] {
  const roots = input.runs.map((message) => ({ at: liveStart(message), node: runNode(message, input) }));
  const byAgent = new Map<string, SplitGroupView[]>();
  for (const group of input.groups) {
    const list = byAgent.get(group.agentId);
    if (list) list.push(group); else byAgent.set(group.agentId, [group]);
  }
  for (const [agentId, groups] of byAgent) {
    const ordered = groups.slice().sort((a, b) => groupStart(a) - groupStart(b));
    let root = roots.find((entry) => entry.node.agentId === agentId && ordered.some((group) => group.parentRunId === entry.node.runId))?.node
      ?? roots.find((entry) => entry.node.agentId === agentId)?.node;
    if (!root) {
      root = waitingRoot(agentId, ordered, input);
      roots.push({ at: root.startedAt ?? 0, node: root });
    }
    root.children = ordered.length === 1 ? partsOf(ordered[0], input) : ordered.map((group) => groupNode(group, input));
  }
  return roots.sort((a, b) => a.at - b.at).map((entry) => entry.node);
}

// ---------------------------------------------------------------- summaries

export type StateCounts = Record<AgentState, number> & { total: number };

/** The states of every agent and part in these trees (group rows are a grouping, not an agent: not counted). */
export function countStates(nodes: readonly AgentNode[]): StateCounts {
  const counts: StateCounts = { total: 0, running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 };
  const walk = (node: AgentNode) => {
    if (node.kind !== 'group') { counts.total++; counts[node.state]++; }
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return counts;
}

/** The parts below a node (through group rows), flat. */
export function partsBelow(node: AgentNode): AgentNode[] {
  return node.children.flatMap((child) => (child.kind === 'group' ? child.children : [child]));
}

/** "2 of 3 parts running", else "1 of 3 parts waiting", else "3 parts done" / "2 of 3 parts done · 1 failed". */
export function partsLine(parts: readonly AgentNode[]): string {
  const total = parts.length;
  const noun = total === 1 ? 'part' : 'parts';
  if (!total) return '';
  const count = (state: AgentState) => parts.filter((part) => part.state === state).length;
  for (const state of ['running', 'waiting'] as const) if (count(state)) return `${count(state)} of ${total} ${noun} ${state}`;
  const done = count('done');
  const extra = (['failed', 'stopped'] as const).filter((state) => count(state)).map((state) => `${count(state)} ${state}`);
  return done === total ? `${total} ${noun} done` : [`${done} of ${total} ${noun} done`, ...extra].join(' · ');
}

/** A collapsed parent's one line: its own activity, then what its hidden parts do. */
export function collapsedActivity(node: AgentNode): string {
  const parts = partsLine(partsBelow(node));
  return parts && node.kind !== 'group' ? `${node.activity} · ${parts}` : node.activity || parts;
}

/** The view's headline: "4 agents · 2 running · 1 waiting · 1 done" (states without a row are left out). */
export function headline(counts: StateCounts): string {
  const states = (['running', 'waiting', 'done', 'failed', 'stopped'] as const).filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${state}`);
  return [`${counts.total} ${counts.total === 1 ? 'agent' : 'agents'}`, ...states].join(' · ');
}

/** "4 steps" / "1 step"; '' for none or unknown. */
export function stepsLabel(steps: number | undefined): string {
  return steps ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : '';
}

/** The steps a run's journal shows as lines (a call with its result is one). */
export function journalSteps(items: readonly RunItem[]): number {
  return runEntries(items.slice()).filter(shownEntry).length;
}

/** The view is for several agents: more than one root, or any parts. */
export function isMultiAgent(nodes: readonly AgentNode[]): boolean {
  return nodes.length > 1 || nodes.some((node) => node.children.length > 0);
}

/** Compact run time like Claude Code: "8s", "1m 05s", "1h 03m"; '' before it started. */
export function elapsedShort(startedAt: number | undefined, endedAt: number | undefined, now: number): string {
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** Keys of the rows open at first: every parent with parts (the parallel work is visible without a click). */
export function openByDefault(nodes: readonly AgentNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (node: AgentNode) => { if (node.children.length) out.add(node.key); node.children.forEach(walk); };
  nodes.forEach(walk);
  return out;
}
