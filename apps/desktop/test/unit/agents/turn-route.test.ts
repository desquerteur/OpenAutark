// B-048 E4.5: a turn reports what it runs on (TurnRequest.onRoute → the activity's model, modelName,
// effort, engine) at route time – before the engine runs – and again after every rebuild of the turn:
// a session renewal and a failover to another account or model. bindTurn also hands the engine and
// the input's cursor to the dispatcher, and a failing listener never breaks the turn.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor, bindTurn } from '../../../src/runtime/agents/turn.ts';
import type { TurnRoute } from '../../../src/runtime/agents/turn-types.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';
import { account } from '../models/harness.ts';
import { model } from '../context/fixture.ts';
import { setup } from './fixture.ts';

const LIMIT: EngineTurnResult = { text: '', stop: 'limit', error: { code: 'rate_limited', message: 'The usage limit of this account was reached.' } };
const ENDED: EngineTurnResult = { text: '', stop: 'error', error: { code: 'conflict', message: 'The conversation is too long for this session.', details: { rebase: true } } };

/** The agents fixture with display names in the catalog and a recorded route listener. */
function rig(caps: Parameters<typeof setup>[0] = {}) {
  const h = setup(caps);
  const names = new Map<string, ModelInfo>([
    ['claude:claude-opus-5-5', { ...model('claude:claude-opus-5-5', 'frontier', 'Claude Opus 5.5'), provider: 'claude', engine: 'claude' }],
    ['claude:claude-sonnet-5', { ...model('claude:claude-sonnet-5', 'strong', 'Claude Sonnet 5'), provider: 'claude', engine: 'claude' }],
  ]);
  Object.assign(h.services.catalog, { get: (id: string) => names.get(id) });
  Object.assign(h.services.runs, { get: () => undefined });
  const routes: TurnRoute[] = [];
  const atRun: number[] = []; // how many routes were reported when the engine ran
  const run = (script: (call: number) => EngineTurnResult) => {
    let calls = 0;
    h.state.script = async () => { atRun.push(routes.length); return script(++calls); };
    return new TurnExecutor(() => h.services).execute(h.request({ onRoute: (route) => routes.push(route) }));
  };
  return { ...h, routes, atRun, run };
}

test('bindTurn hands the engine and the cursor over and reports the route; a failing listener changes nothing', () => {
  const h = setup();
  const routes: TurnRoute[] = [];
  const request = h.request({ onRoute: (route) => routes.push(route) });
  const turn = { ...h.routed(), lastSeq: 7 };
  bindTurn(request, turn);
  assert.equal(request.control.engine, h.engine);
  assert.equal(request.control.lastSeq, 7);
  assert.deepEqual(routes, [{ model: 'claude:claude-opus-5-5', modelName: 'Claude Opus 5.5', effort: 'medium', engine: 'claude' }]);
  const failing = h.request({ onRoute: () => { throw new Error('the window is gone'); } });
  assert.doesNotThrow(() => bindTurn(failing, turn));
  assert.equal(failing.control.engine, h.engine, 'the handles are set before the report');
});

test('route time: the model is reported before the engine runs', async () => {
  const h = rig();
  Object.assign(h.services, { router: { route: async () => h.route } });
  const outcome = await h.run(() => ({ text: 'Hi', stop: 'done' }));
  assert.equal(outcome.status, 'done');
  assert.deepEqual(h.routes, [{ model: 'claude:claude-opus-5-5', modelName: 'Claude Opus 5.5', effort: 'medium', engine: 'claude' }]);
  assert.deepEqual(h.atRun, [1], 'known when the engine starts');
});

test('a failover reports the new account\'s model and effort before the second attempt runs', async () => {
  const h = rig();
  const backup = account('acc_backup', 'claude', { label: 'Claude Code 2' });
  const accounts = new Map([[h.account.id, h.account], [backup.id, backup]]);
  Object.assign(h.services.accounts, { get: (id: string) => accounts.get(id), markLimited: () => {} });
  const sonnet: RouteDecision = { ...h.route, modelId: 'claude:claude-sonnet-5', accountId: backup.id, effort: 'high' };
  Object.assign(h.services, { router: { route: async (request: RouteRequest) => (request.exclude?.includes(h.account.id) ? sonnet : h.route) } });
  const outcome = await h.run((call) => (call === 1 ? LIMIT : { text: 'Done on the backup.', stop: 'done' }));
  assert.equal(outcome.status, 'done');
  assert.deepEqual(h.routes, [
    { model: 'claude:claude-opus-5-5', modelName: 'Claude Opus 5.5', effort: 'medium', engine: 'claude' },
    { model: 'claude:claude-sonnet-5', modelName: 'Claude Sonnet 5', effort: 'high', engine: 'claude' },
  ]);
  assert.deepEqual(h.atRun, [1, 2], 'each attempt runs on the route reported last');
});

test('a session renewal rebuilds the turn and reports its route again', async () => {
  const h = rig({ sessions: true, rebase: true });
  Object.assign(h.services, { router: { route: async () => h.route } });
  const outcome = await h.run((call) => (call === 1 ? ENDED : { text: 'Continued.', stop: 'done' }));
  assert.equal(outcome.status, 'done');
  assert.ok(h.items.some((item) => (item.data as { sessionRenewed?: string } | undefined)?.sessionRenewed === 'overflow'), 'the session was renewed');
  assert.equal(h.routes.length, 2);
  assert.deepEqual(h.routes[1], h.routes[0], 'the same route, reported after the rebuild');
  assert.deepEqual(h.atRun, [1, 2]);
});
