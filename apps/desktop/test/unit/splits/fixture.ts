// Test world of the split core (B-057 track A): the real SplitServiceImpl on an in-memory database with the real run
// journal and wake queue, a fake org, chat, catalog and budget, fake git worktree helpers, and FakeLanes – a dispatcher
// whose startSplit answers 'started' (or a scripted 'busy' / 'refused'), builds the turn from turnFor/inputFor, starts
// the split's run like a lane would, and ends it on demand (answer journaled, run finished, onSplitRunEnd, onLaneFree) –
// like agents/dispatch-lanes.ts: a split still on its lane answers 'started', an agent has at most runningPerAgent lanes,
// and a run's end is reported while its lane is still held (freed right after).
// Owns: fixtures only. Never: imported by src/; no engine, no timers.

import { newId } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { SplitCreateContext, SplitLane } from '../../../src/runtime/contracts/splits.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import { SplitServiceImpl } from '../../../src/runtime/splits/service.ts';
import { splitAnswer } from '../../../src/runtime/agents/publishing.ts';
import { SplitRepo } from '../../../src/runtime/store/splits.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { ModelInfo } from '../../../src/shared/model/providers.ts';
import { SPLIT_LIMITS, type SplitPartInput, type SplitTurn } from '../../../src/shared/model/splits.ts';
import { FakeOrg, agent } from '../chat/harness.ts';
import { memoryDb, recordingBus } from '../store/helpers.ts';

export const T = Date.UTC(2026, 9, 29, 9, 0, 0);
export const CHAT = 'ch_launch';
export const PARENT = 'run_parent';
const MODELS = [
  { id: 'codex:gpt-6.1-sol', model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', available: true },
  { id: 'claude:claude-opus-5-5', model: 'claude-opus-5-5', name: 'Claude Opus 5.5', available: false },
] as unknown as ModelInfo[];

type Answer = 'started' | 'busy' | 'refused';
type EndStatus = 'done' | 'failed' | 'stopped';

/** A dispatcher with split lanes only (contracts/splits.ts members). */
export class FakeLanes {
  answers: Answer[] = [];
  started: string[] = [];
  stopped: Array<{ splitId: string; why: string }> = [];
  turns: Array<{ turn: SplitTurn; notes: Array<{ text: string; at: number }> }> = [];
  readonly lanes = new Map<string, { runId: string; agentId: string }>();
  private readonly listeners = new Set<() => void>();
  private readonly w: () => { splits: SplitServiceImpl; runs: Journal; clock: ManualClock };

  constructor(w: () => { splits: SplitServiceImpl; runs: Journal; clock: ManualClock }) { this.w = w; }

  startSplit(input: { agentId: string; splitId: string }): Answer {
    const answer = this.answers.shift() ?? 'started';
    if (answer !== 'started') return answer;
    // Like agents/dispatch-lanes.ts: a split still on its lane counts as started; an agent's lanes are capped.
    if (this.lanes.has(input.splitId)) return 'started';
    if (this.splitLanes(input.agentId).length >= SPLIT_LIMITS.runningPerAgent) return 'busy';
    const { splits, runs } = this.w();
    const turn = splits.turnFor(input.splitId);
    if (!turn) return 'refused';
    this.turns.push({ turn, notes: splits.inputFor(input.splitId) });
    const runId = newId('run');
    runs.start({ id: runId, agentId: input.agentId, trigger: 'split', splitId: input.splitId });
    this.lanes.set(input.splitId, { runId, agentId: input.agentId });
    this.started.push(input.splitId);
    return 'started';
  }

  splitLanes(agentId?: string): SplitLane[] {
    return [...this.lanes].filter(([, lane]) => !agentId || lane.agentId === agentId).map(([splitId, lane]) => ({ splitId, ...lane }));
  }

  stopSplit(splitId: string, why: string): boolean {
    this.stopped.push({ splitId, why });
    return this.lanes.has(splitId);
  }

  onLaneFree(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activity(): [] { return []; }

  /**
   * The lane's turn ends: its answer journaled ('Answer', internal), its run finished, the service told – while the lane
   * is still the dispatcher's (agents/dispatch-runs.ts: turn-finish runs inside the lane, its entry goes in `finally`) –
   * then the lane freed and the lane-free listeners fired.
   */
  end(splitId: string, status: EndStatus, options: { answer?: string; retryable?: boolean; requeue?: boolean; wait?: boolean; error?: string; costUsd?: number } = {}): string {
    const lane = this.lanes.get(splitId);
    if (!lane) throw new Error(`no lane for ${splitId}`);
    const { splits, runs, clock } = this.w();
    // Like agents/publishing.ts journalAnswer: parts of ≤ 4,000 characters (the journal's string limit).
    const parts = options.answer ? splitAnswer(options.answer) : [];
    parts.forEach((text, index) => runs.item(lane.runId, {
      kind: 'note', name: 'Answer', effectStatus: 'none',
      data: { answer: true, text, visibility: 'internal', ...(parts.length > 1 ? { part: index + 1, parts: parts.length } : {}) },
    }));
    runs.finish(lane.runId, {
      status: status === 'done' ? 'done' : status === 'stopped' ? 'interrupted' : 'failed', endedAt: clock.now(), model: 'codex:gpt-6.1-sol', effort: 'low',
      ...(options.costUsd !== undefined ? { costUsd: options.costUsd } : {}), ...(options.error ? { error: options.error } : {}),
    });
    splits.onSplitRunEnd(splitId, {
      runId: lane.runId, status, ...(options.retryable ? { retryable: true } : {}), ...(options.requeue ? { requeue: true } : {}),
      ...(options.wait ? { wait: true } : {}), ...(options.error ? { error: options.error } : {}),
    });
    if (this.lanes.get(splitId) === lane) this.lanes.delete(splitId);
    for (const listener of this.listeners) listener();
    return lane.runId;
  }
}

/** `ultra`: the person's latest message in CHAT suggested Ultra (MessageMeta.ultra, owner 30.10.2026). */
export interface WorldOptions { budget?: number; ultra?: boolean; lanes?: boolean }

export function world(options: WorldOptions = {}) {
  const db = memoryDb();
  for (const id of ['ag_ava', 'ag_ben']) {
    db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES (?, ?, '{}', 'human', 0, 0)`, [id, id]);
  }
  const { bus, of } = recordingBus();
  const clock = new ManualClock(T);
  const runs = new Journal({ db, bus, clock });
  const wakes = new WakeQueueImpl({ db, clock });
  const org = new FakeOrg();
  org.add(agent('ag_ava', 'Ava'));
  org.add(agent('ag_ben', 'Ben'));
  const chats = {
    get: (id: string) => (id === CHAT ? { id, settings: {} } : undefined),
    messages: (id: string) => (id === CHAT ? [
      { authorKind: 'human', meta: { ultra: true } },
      { authorKind: 'agent', meta: {} },
      { authorKind: 'human', meta: options.ultra ? { ultra: true } : {} },
    ] : []),
  };
  const catalog = { get: (id: string) => MODELS.find((model) => model.id === id), list: () => MODELS };
  const permissions = { budgetLeft: () => ({ usd: options.budget, warn: false }) };
  const taint: Array<{ from: string[]; to: { runId?: string; taskId?: string } }> = [];
  const git = { refuse: undefined as string | undefined, openError: undefined as string | undefined, opened: [] as string[], finished: [] as string[], swept: 0 };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  let splits: SplitServiceImpl;
  const lanes = new FakeLanes(() => ({ splits, runs, clock }));
  const dispatcher = options.lanes === false ? { activity: () => [] } : lanes;
  const services = { db, bus, clock, log, runs, wakes, org, chats, catalog, permissions, dispatcher } as unknown as RuntimeServices;
  const deps = {
    db, bus, clock, log, repo: new SplitRepo(db), runs, wakes, org: org as unknown as RuntimeServices['org'],
    dispatcher: () => services.dispatcher, services: () => services,
    worktrees: {
      canIsolate: async () => git.refuse,
      open: async (_s: RuntimeServices, _group: unknown, split: { id: string; idx: number }) => {
        if (git.openError) throw new Error(git.openError);
        git.opened.push(split.id);
        return { cwd: `C:/work/.worktrees/repo-${split.idx}`, branch: `wf/split-part-${split.idx}` };
      },
      finish: async (_s: RuntimeServices, split: { id: string }) => { git.finished.push(split.id); return { stat: '2 files changed, +10 -1' }; },
      merge: async () => ({ outcome: 'merged' as const }),
      sweep: async () => { git.swept++; },
    },
    carryTaint: (_s: RuntimeServices, from: string[], to: { runId?: string; taskId?: string }) => { taint.push({ from, to }); },
  };
  splits = new SplitServiceImpl(deps);
  services.splits = splits;
  lanes.onLaneFree(() => splits.pump());
  splits.watch();
  runs.start({ id: PARENT, agentId: 'ag_ava', conversationId: CHAT, trigger: 'message' });
  const ctx = (over: Partial<SplitCreateContext> = {}): SplitCreateContext => ({
    agentId: 'ag_ava', runId: PARENT, conversationId: CHAT, thread: CHAT, modeKey: 'general', cwd: 'C:/work/repo', ...over,
  });
  /** A new service on the same database (a restart): a fresh dispatcher with no lanes. */
  const restart = () => {
    const fresh = new FakeLanes(() => ({ splits: again, runs, clock }));
    const again: SplitServiceImpl = new SplitServiceImpl({ ...deps, dispatcher: () => fresh as unknown as RuntimeServices['dispatcher'] });
    fresh.onLaneFree(() => again.pump());
    return { splits: again, lanes: fresh };
  };
  return { db, bus, of, clock, runs, wakes, org, lanes, splits, taint, git, services, deps, ctx, restart };
}

export type World = ReturnType<typeof world>;

export const part = (title: string, over: Partial<SplitPartInput> = {}): SplitPartInput => ({ title, brief: `Do ${title.toLowerCase()}.`, ...over });

/** Parent turn ends 'done' after creating a group of these parts; the group's id. */
export function splitAndEnd(w: World, parts: SplitPartInput[], goal = 'Review the release'): string {
  const group = w.splits.create(w.ctx(), { goal, parts });
  w.runs.finish(PARENT, { status: 'done', endedAt: w.clock.now() });
  w.splits.afterParentTurn(PARENT, 'done');
  return group.id;
}

/** Lets the fake git helpers' promises settle. */
export const settleGit = () => new Promise<void>((resolve) => setImmediate(resolve));
