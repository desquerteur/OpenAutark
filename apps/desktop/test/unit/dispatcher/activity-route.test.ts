// B-048 E4.5: the dispatcher's activity rows carry what a running turn runs on. The turn's route
// report (TurnRequest.onRoute, agents/turn.ts bindTurn) sets model, modelName, effort and engine on
// its row and re-emits agent.activity at once – only on a change (a renewal on the same route emits
// nothing) and never for a turn that already ended; a row without a route yet has none of the fields.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunningTurns } from '../../../src/runtime/agents/dispatch-runs.ts';
import { groupWakes } from '../../../src/runtime/agents/dispatch-groups.ts';
import type { LiveStatus } from '../../../src/runtime/agents/dispatch-live.ts';
import type { TurnOutcome, TurnRequest } from '../../../src/runtime/agents/turn-types.ts';
import type { RuntimeServices, Wake } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const OPUS = { model: 'claude:claude-opus-5-5', modelName: 'Claude Opus 5.5', effort: 'high', engine: 'claude' } as const;
const SOL = { model: 'codex:gpt-6.1-sol', modelName: 'GPT-6.1 Sol', effort: 'medium', engine: 'codex' } as const;

function rig() {
  const emits: number[] = [];
  const services = {
    clock: { now: () => 1_000 },
    tasks: { get: () => undefined },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    wakes: { done() {}, release() {} },
    runs: { get: () => ({ status: 'running' }), finish() {} },
  } as unknown as RuntimeServices;
  let turns!: RunningTurns;
  const live = { awake() {}, status() {}, emit: () => emits.push(turns.activity().length) } as unknown as LiveStatus;
  let request!: TurnRequest;
  let release!: (outcome: TurnOutcome) => void;
  const execute = (next: TurnRequest) => { request = next; return new Promise<TurnOutcome>((resolve) => { release = resolve; }); };
  turns = new RunningTurns({ services: () => services, executor: { execute }, supervisor: { admit: async () => () => {} } }, live, () => {});
  const wake: Wake = { id: 'wk_1', agentId: 'ag_tom', reason: 'message', conversationId: 'cv_a', dueAt: 10, createdAt: 10, attempts: 0 };
  turns.start(services, { id: 'ag_tom' } as Agent, groupWakes([wake])[0]!);
  return { turns, emits, request: () => request, release: (status: TurnOutcome['status'] = 'done') => release({ runId: request.runId, status }) };
}

test('a row has no model while the turn routes; the route report fills it and re-emits the activity', async () => {
  const r = rig();
  await flush();
  const row = r.turns.activity()[0]!;
  for (const key of ['model', 'modelName', 'effort', 'engine'] as const) assert.equal(key in row, false, `no ${key} before routing`);
  r.request().onRoute?.(OPUS);
  assert.deepEqual(r.emits, [1], 'emitted at once');
  const routed = r.turns.activity()[0]!;
  assert.deepEqual({ model: routed.model, modelName: routed.modelName, effort: routed.effort, engine: routed.engine }, OPUS);
  assert.equal(routed.conversationId, 'cv_a', 'the rest of the row stays');
});

test('only a change re-emits: the same route after a renewal is quiet, a failover to another model is not', async () => {
  const r = rig();
  await flush();
  r.request().onRoute?.(OPUS);
  r.request().onRoute?.({ ...OPUS });
  assert.equal(r.emits.length, 1, 'the same route again changes nothing');
  r.request().onRoute?.(SOL);
  assert.equal(r.emits.length, 2);
  assert.equal(r.turns.activity()[0]!.modelName, 'GPT-6.1 Sol');
  r.request().onRoute?.({ ...SOL, effort: 'high' });
  assert.equal(r.emits.length, 3, 'an effort change alone is a change');
  assert.equal(r.turns.activity()[0]!.effort, 'high');
});

test('a report after the turn ended changes nothing', async () => {
  const r = rig();
  await flush();
  const request = r.request();
  r.release();
  await flush();
  assert.equal(r.turns.size, 0);
  request.onRoute?.(OPUS);
  assert.deepEqual(r.emits, [], 'no activity for an ended run');
});
