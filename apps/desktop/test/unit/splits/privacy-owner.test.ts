// B-057 × F-52: the owner sees every split (no owner hiding any more). runs.items judges a split's run by the rule of splits.get (the group's parent run), for the owner and a
// 'chat' phone alike; agents.runs lists the agent's own turns only; a person sees split work only in their own chats.
// Owns: these checks. Never: an engine, the real split lifecycle (a fake split service holds the groups).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleRig, settle } from '../people/rig.ts';
import { register as splitHandlers } from '../../../src/runtime/rpc/handlers/splits.ts';
import { splitPlace } from '../../../src/runtime/people/events.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { SplitService } from '../../../src/runtime/contracts/splits.ts';
import type { AgentActivity, Run, RunItem } from '../../../src/shared/model/runs.ts';
import type { SplitGroupView } from '../../../src/shared/model/splits.ts';

const AGENT = 'ag_research';

/** A group of one running part, split by `parentRunId` in `conversationId` (or on task `taskId`). */
function group(id: string, splitId: string, parentRunId: string, conversationId?: string, taskId?: string): SplitGroupView {
  return {
    id, agentId: AGENT, parentRunId, ...(conversationId ? { conversationId } : {}), ...(taskId ? { taskId } : {}),
    thread: conversationId ? `chat:${conversationId}` : `task:${taskId}`, goal: `Goal of ${id}`, ultra: false,
    status: 'running', parts: 1, createdAt: 1,
    splits: [{ id: splitId, groupId: id, agentId: AGENT, idx: 1, of: 1, title: `Part of ${id}`, brief: 'Look it up.', context: 'fork',
      after: [], worktree: false, status: 'running', attempts: 1, createdAt: 1, runs: 1 }],
  };
}

/** The split service's read side over fixed groups; counts its get() calls. */
class FakeSplits {
  gets = 0;
  readonly groups: SplitGroupView[];
  constructor(groups: SplitGroupView[]) { this.groups = groups; }
  get(splitId: string): { split: SplitGroupView['splits'][number]; group: SplitGroupView } | undefined {
    this.gets++;
    for (const item of this.groups) {
      const split = item.splits.find((entry) => entry.id === splitId);
      if (split) return { split, group: item };
    }
    return undefined;
  }
  list(q: { groupId?: string; agentId?: string }): SplitGroupView[] {
    return this.groups.filter((item) => (!q.groupId || item.id === q.groupId) && (!q.agentId || item.agentId === q.agentId));
  }
  stop(): number { return 0; }
}

const split = (splitId: string, item: SplitGroupView, conversationId?: string): AgentActivity => ({
  agentId: AGENT, runId: `run_${splitId}`, note: 'Reading', startedAt: 3, ...(conversationId ? { conversationId } : {}),
  split: { id: splitId, groupId: item.id, idx: 1, of: 1, parentRunId: item.parentRunId, title: item.splits[0].title },
});

/** Anna's own chat and an owner chat, each with a parent turn that split into one running part with its own run. */
async function scene(t: { after(fn: () => void): void }) {
  const r = peopleRig({ modules: [splitHandlers] });
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const theirs = await anna.client.call<{ id: string }>('chats.create', { title: 'Salary talk', agentIds: [AGENT], firstMessage: 'my private words' });
  const ours = r.chats.create({ title: 'Owner chat', agentIds: [AGENT], createdBy: 'human' });
  const runs = r.services.runs;
  runs.start({ id: 'run_people', agentId: AGENT, conversationId: theirs.id, trigger: 'message' } as Omit<Run, 'status' | 'startedAt'>);
  runs.start({ id: 'run_owner', agentId: AGENT, conversationId: ours.id, trigger: 'message' } as Omit<Run, 'status' | 'startedAt'>);
  const hidden = group('sgr_people', 'spl_people', 'run_people', theirs.id);
  const shown = group('sgr_owner', 'spl_owner', 'run_owner', ours.id);
  const splits = new FakeSplits([hidden, shown]);
  (r.services as RuntimeServices).splits = splits as unknown as SplitService;
  runs.start({ id: 'run_spl_people', agentId: AGENT, trigger: 'split', splitId: 'spl_people' } as Omit<Run, 'status' | 'startedAt'>);
  runs.start({ id: 'run_spl_owner', agentId: AGENT, trigger: 'split', splitId: 'spl_owner' } as Omit<Run, 'status' | 'startedAt'>);
  runs.start({ id: 'run_spl_gone', agentId: AGENT, trigger: 'split', splitId: 'spl_gone' } as Omit<Run, 'status' | 'startedAt'>);
  for (const id of ['run_spl_people', 'run_spl_owner']) runs.item(id, { kind: 'tool_call', name: 'files.read', data: { args: { path: `${id}.md` } } });
  await settle();
  return { r, anna, theirs: theirs.id, ours: ours.id, hidden, shown, splits, services: r.services as RuntimeServices };
}

test('a person sees split work only in their own chats', async (t) => {
  const { r, anna, theirs, ours, hidden, shown } = await scene(t);
  const mine = split('spl_people', hidden, theirs);
  r.dispatcher.active = [{ agentId: AGENT, runId: 'run_owner', conversationId: ours, note: 'Summing up', startedAt: 1 }, split('spl_owner', shown, ours), mine];
  const seen = await anna.client.call<AgentActivity[]>('agents.activity');
  assert.deepEqual(seen, [{ agentId: AGENT, runId: 'run_owner', note: '', startedAt: 1 }, mine]);
});

test('the owner sees every split and its run, the people\'s chats included', async (t) => {
  const { r } = await scene(t);
  for (const id of ['run_spl_people', 'run_spl_owner']) assert.equal((await r.owner.call<RunItem[]>('runs.items', { runId: id })).length, 1, id);
  assert.deepEqual((await r.owner.call<SplitGroupView[]>('splits.list', { agentId: AGENT })).map((item) => item.id).sort(), ['sgr_owner', 'sgr_people']);
});

test('splitPlace asks the split service once per split (run items stream)', async (t) => {
  const { services, splits, theirs } = await scene(t);
  const before = splits.gets;
  for (let i = 0; i < 5; i++) splitPlace(services, 'spl_people');
  assert.deepEqual(splitPlace(services, 'spl_people'), { parentRunId: 'run_people', conversationId: theirs });
  assert.ok(splits.gets - before <= 1, `get() called ${splits.gets - before} times`);
  assert.equal(splitPlace({}, 'spl_people'), undefined, 'no split service: unknown');
});
