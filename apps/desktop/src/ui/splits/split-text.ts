// Splits as the person reads them (B-057 S18, shared/model/splits.ts): the words and pure rules of every split row –
// the parent's step line "Split · 3 of 5 done", a group's live line "3 of 5 parts working", a part "#3 title", its
// model · effort slot (the run's when it ran, else what the agent asked for), its status icon kind and duration – and
// the selectors the views share: the groups under an agent in the team sidebar (active and recently finished), the
// groups of one parent run (which one belongs to which agents.split call), the running groups of a chat (one live
// block each) and the running splits per agent from the live activity (never the agent's main ring).
// Owns: these rules (unit-tested in test/unit/ui/splits-model.test.ts). Never: imports the store, rpc or the DOM.

import type { Effort } from '../../shared/model/providers.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import { SPLIT_TERMINAL } from '../../shared/model/splits.ts';
import type { SplitGroupView, SplitStatus, SplitView } from '../../shared/model/splits.ts';
import { EFFORT_LABEL, partsWorking } from '../chat/live-text.ts';

/** The parent's tool call that splits its work (runtime/tools/builtin/agents-split.ts). */
export const SPLIT_TOOL = 'agents.split';

export const SPLIT_STATUS_LABEL: Record<SplitStatus, string> = {
  pending: 'Waiting', queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped',
};

/** The 16 px icon slot of a split row: a spinner while it runs, one icon per other state. */
export type SplitIconKind = 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';

export function splitIconKind(status: SplitStatus): SplitIconKind {
  return status === 'pending' || status === 'queued' ? 'waiting' : status;
}

export function isSettled(status: SplitStatus): boolean {
  return SPLIT_TERMINAL.includes(status);
}

export interface GroupCounts { total: number; done: number; running: number; waiting: number; failed: number; settled: number }

/** How far a group is: parts in total (the group's count, at least its listed splits), done, running, waiting, failed. */
export function groupCounts(group: Pick<SplitGroupView, 'parts' | 'splits'>): GroupCounts {
  const counts: GroupCounts = { total: Math.max(group.parts, group.splits.length), done: 0, running: 0, waiting: 0, failed: 0, settled: 0 };
  for (const split of group.splits) {
    if (split.status === 'done') counts.done++;
    else if (split.status === 'running') counts.running++;
    else if (split.status === 'pending' || split.status === 'queued') counts.waiting++;
    else if (split.status === 'failed') counts.failed++;
    if (isSettled(split.status)) counts.settled++;
  }
  return counts;
}

/** The step line's target after "Split": "3 of 5 done". */
export function groupDone(group: Pick<SplitGroupView, 'parts' | 'splits'>): string {
  const counts = groupCounts(group);
  return `${counts.done} of ${counts.total} done`;
}

/** A running group's line: "3 of 5 parts working" while parts run, else how many are done. */
export function groupWorking(group: Pick<SplitGroupView, 'parts' | 'splits'>): string {
  const counts = groupCounts(group);
  return counts.running ? partsWorking(counts.running, counts.total) : `${counts.done} of ${counts.total} done`;
}

/** A group still at work: started and not every part settled (pending = the parent's turn has not ended yet). */
export function isLiveGroup(group: Pick<SplitGroupView, 'status' | 'splits'>): boolean {
  return group.status === 'running' && group.splits.some((split) => !isSettled(split.status));
}

/** A group whose results have not gone back yet (the RPC's `active`): not gathered or stopped. */
export function isActiveGroup(group: Pick<SplitGroupView, 'status'>): boolean {
  return group.status === 'pending' || group.status === 'running' || group.status === 'settled';
}

/** "#3 Check the invoices" */
export function partLabel(split: Pick<SplitView, 'idx' | 'title'>): string {
  return `#${split.idx} ${split.title}`;
}

/** "Part 3 of 5" */
export function partOf(split: Pick<SplitView, 'idx' | 'of'>): string {
  return `Part ${split.idx} of ${split.of}`;
}

const isEffort = (value: unknown): value is Effort => typeof value === 'string' && Object.prototype.hasOwnProperty.call(EFFORT_LABEL, value);
const REQUESTED: Record<string, string> = { cheap: 'Cheaper model', strong: 'Stronger model' };

/**
 * The model · effort slot: what the split's run ran on ("Claude Opus 5.5 · High"), else – while it runs (its run row
 * gets the model only when it ends) – what the live activity says it runs on, else what the agent asked for ("Cheaper
 * model · Low", an explicit model's name); '' for the parent's own model before it ran.
 */
export function splitModelText(split: Pick<SplitView, 'model' | 'effort' | 'run'>, nameOf: (id: string) => string | undefined,
  live?: Pick<AgentActivity, 'model' | 'modelName' | 'effort'>): string {
  const parts = splitModelParts(split, nameOf, live);
  return [parts.name, parts.effort].filter(Boolean).join(' · ');
}

/** The two words of the model · effort slot ('' when unknown) – a narrow row shows the effort alone (splits.css). */
export function splitModelParts(split: Pick<SplitView, 'model' | 'effort' | 'run'>, nameOf: (id: string) => string | undefined,
  live?: Pick<AgentActivity, 'model' | 'modelName' | 'effort'>): { name: string; effort: string } {
  const run = split.run;
  const ran = run?.model ? { name: nameOf(run.model) ?? run.model, effort: run.effort ?? split.effort }
    : live?.model ? { name: live.modelName?.trim() || (nameOf(live.model) ?? live.model), effort: live.effort ?? split.effort } : undefined;
  const name = ran ? ran.name : !split.model || split.model === 'same' ? '' : REQUESTED[split.model] ?? nameOf(split.model) ?? split.model;
  const effort = ran ? ran.effort : split.effort;
  return { name, effort: isEffort(effort) ? EFFORT_LABEL[effort] : '' };
}

/** The live activity entry of a running split's run (its model and effort while it runs). */
export function liveOfSplit(active: readonly AgentActivity[], splitId: string): AgentActivity | undefined {
  return active.find((entry) => entry.split?.id === splitId);
}

/** How long something took: "4 s", "2 min 5 s", "1 h 3 min"; '' before it started (the agent's run list says the same). */
export function elapsedText(startedAt: number | undefined, endedAt: number | undefined, now = Date.now()): string {
  if (!startedAt) return '';
  const s = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** A split's duration once it ended (a running one shows its spinner instead – no ticking clock). */
export function splitDuration(split: Pick<SplitView, 'status' | 'startedAt' | 'endedAt' | 'run'>): string {
  if (!isSettled(split.status)) return '';
  const started = split.startedAt ?? split.run?.startedAt;
  const ended = split.endedAt ?? split.run?.endedAt;
  return ended ? elapsedText(started, ended) : '';
}

/** "12.4k" for token counts. */
export function tokenCount(value: number): string {
  return value < 1000 ? String(value) : value < 100_000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(value / 1000)}k`;
}

/** "12.4k in · 2.1k out" from a run's tokens; '' without any. */
export function tokensText(run: { inputTokens?: number; outputTokens?: number } | undefined): string {
  if (!run || (!run.inputTokens && !run.outputTokens)) return '';
  return `${tokenCount(run.inputTokens ?? 0)} in · ${tokenCount(run.outputTokens ?? 0)} out`;
}

// ---------------------------------------------------------------- selectors

const newestFirst = (a: SplitGroupView, b: SplitGroupView) => b.createdAt - a.createdAt;

/** Finished groups stay under their agent in the sidebar this long. */
export const RECENT_MS = 6 * 60 * 60_000;
/** At most this many groups under one agent in the sidebar. */
export const SIDEBAR_GROUPS = 4;

/** The groups under an agent in the team sidebar: its active ones and those finished recently, newest first. */
export function sidebarGroups(groups: Iterable<SplitGroupView>, agentId: string, now = Date.now()): SplitGroupView[] {
  return [...groups]
    .filter((group) => group.agentId === agentId && group.splits.length > 0
      && (isActiveGroup(group) || now - (group.endedAt ?? group.gatheredAt ?? group.createdAt) < RECENT_MS))
    .sort(newestFirst)
    .slice(0, SIDEBAR_GROUPS);
}

/** The groups one parent run split into, in the order it made them. */
export function runGroups(groups: Iterable<SplitGroupView>, parentRunId: string): SplitGroupView[] {
  return [...groups].filter((group) => group.parentRunId === parentRunId).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The group one agents.split call made: the group its result names ("groupId", agents-split.ts – none while that one is
 * not read yet), else the first one made after the call started (calls of one run come one after another), else – once
 * the call has a result – the run's last one. A call still running never borrows an earlier call's group.
 */
export function groupForCall(ofRun: readonly SplitGroupView[], callAt: number, resultText?: string): SplitGroupView | undefined {
  const named = resultText ? /"groupId"\s*:\s*"([^"]+)"/.exec(resultText)?.[1] : undefined;
  if (named) return ofRun.find((group) => group.id === named);
  const after = ofRun.find((group) => group.createdAt >= callAt);
  return after ?? (resultText !== undefined ? ofRun[ofRun.length - 1] : undefined);
}

/** When a live block's group started (its place among the chat's live blocks, fixed once shown). */
export function groupStart(group: Pick<SplitGroupView, 'startedAt' | 'createdAt'>): number {
  return group.startedAt ?? group.createdAt;
}

/**
 * The running groups of a chat (one live block each), in start order: groups made in this chat, and groups whose
 * split runs report this chat in the live activity.
 */
export function chatGroups(groups: Iterable<SplitGroupView>, conversationId: string, active: readonly AgentActivity[] = []): SplitGroupView[] {
  const named = new Set(active.filter((entry) => entry.split && entry.conversationId === conversationId).map((entry) => entry.split!.groupId));
  return [...groups].filter((group) => isLiveGroup(group) && (group.conversationId === conversationId || named.has(group.id)))
    .sort((a, b) => groupStart(a) - groupStart(b));
}

/** Running split runs per agent (live activity entries with `split`); the agent's main turn is not counted. */
export function runningByAgent(active: readonly AgentActivity[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of active) if (entry.split) out.set(entry.agentId, (out.get(entry.agentId) ?? 0) + 1);
  return out;
}

/** Per agent, which split runs are live now (a key that changes when a split starts or ends – not with each step). */
export function splitRunKeys(active: readonly AgentActivity[]): Map<string, string> {
  const ids = new Map<string, string[]>();
  for (const entry of active) {
    if (!entry.split) continue;
    const list = ids.get(entry.agentId);
    if (list) list.push(entry.runId); else ids.set(entry.agentId, [entry.runId]);
  }
  return new Map([...ids].map(([agentId, list]) => [agentId, list.sort().join(',')]));
}

/** Agents whose live split runs differ between two `splitRunKeys` maps. */
export function changedAgents(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>();
  for (const [agentId, key] of after) if (before.get(agentId) !== key) out.add(agentId);
  for (const agentId of before.keys()) if (!after.has(agentId)) out.add(agentId);
  return [...out];
}
