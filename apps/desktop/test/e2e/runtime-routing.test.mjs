// End-to-end (RT10, the P14 scenario): automatic model routing over the real headless runtime
// (built app/runtime-cli.mjs) with real WebSocket RPC. The deterministic fake engine lists real
// model ids (WORKFORCE_FAKE_MODELS), so the catalog merges them with the shipped priors – real
// names, tiers, efforts and strengths – and every turn goes through the real router.
// Covers: a coding text runs on GPT-6.1 Sol; a Remotion animation in the same chat switches to
// Claude Opus 5.5 at high effort with a quiet model_switched line that says why; the agent's own
// model.set {effort: max} holds for its next turn only, then the previous effort returns – both
// switches with their quiet line (RT2); routing.preview names the model a chat's first turn runs on.
// Every turn here answers a line of the person, so it runs as a person's request (routing/person-turn.ts,
// E1): the strongest model for the work at effort high or above; the preview has no such line yet.
// (Escalating stuck work to a stronger model went – Umbau Einfachheit.)
// The same expectations without a person's line are pinned in test/unit/routing/p14-routing.test.ts.
// Run: npm run build && node --test test/e2e/runtime-routing.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEndedAfter, startRuntime, waitForNew, waitModels } from './lib/runtime-client.mjs';

/** No fake-1: a strong-tier fake-1 would be the "stronger" model above Haiku. */
const MODELS = 'gpt-6.1-sol,claude-opus-5-5,claude-haiku-5-5';
const SOL = 'compatible:gpt-6.1-sol';
const OPUS = 'compatible:claude-opus-5-5';
const HAIKU = 'compatible:claude-haiku-5-5';
const CODING = 'Fix the TypeScript bug in the parser and add a unit test.';
const REMOTION = 'Now build a Remotion animation of the parser results with smooth keyframes.';
/** routing/person-turn.ts PERSON_TEXT: the route reason's part for a turn that answers a person's line. */
const PERSON = "a person's request · strongest model";

const isSwitch = (conversationId) => (message) => message.conversationId === conversationId && message.kind === 'status' && message.meta?.status?.type === 'model_switched';

test('routing: the model by task, the switch line, model.set for one step, the preview', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime({ env: { WORKFORCE_FAKE_MODELS: MODELS } });
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const models = new Map((await waitModels(client, [SOL, OPUS, HAIKU])).map((model) => [model.id, model]));
  assert.equal(models.get(OPUS).name, 'Claude Opus 5.5', 'the catalog merged the listing with the shipped priors');
  assert.equal(models.get(HAIKU).tier, 'small');
  assert.ok(!models.has('compatible:fake-1'), 'only the listed models');

  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const vera = await client.call('agents.create', { name: 'Vera', managerId: manager.id, mode: 'general' });
  await client.call('events.subscribe', { topics: [`runs:${vera.id}`] });

  /** Sends a message as the person and resolves with Vera's turn on it once it ended. */
  const say = (conversationId, body) => runEndedAfter(client,
    (run) => run.agentId === vera.id && run.conversationId === conversationId && run.trigger === 'message',
    () => client.call('messages.send', { conversationId, body }));
  const chat = await client.call('chats.create', { title: 'Parser', agentIds: [vera.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });

  await t.test('a coding text runs on GPT-6.1 Sol', async () => {
    const run = await say(chat.id, CODING);
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.model, SOL);
    assert.equal(run.effort, 'high', "a person's request runs at effort high or above");
    assert.equal(run.route.category, 'coding');
    assert.equal(run.route.by, 'rules');
    assert.equal(run.route.reason, `coding · ${PERSON}`);
  });

  await t.test('a Remotion animation switches to Claude Opus 5.5 at high effort, and a quiet line says why', async () => {
    const line = waitForNew(client, 'message.created', isSwitch(chat.id), 90_000);
    line.catch(() => undefined);
    const run = await say(chat.id, REMOTION);
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.model, OPUS);
    assert.equal(run.effort, 'high');
    assert.equal(run.route.category, 'video-animation');
    assert.equal(run.route.reason, `GPT-6.1 Sol is weak at video animation · video animation · ${PERSON}`);
    const status = await line;
    assert.equal(status.authorId, vera.id, 'the agent\'s own quiet line');
    assert.equal(status.silent, true);
    assert.equal(status.body, 'Switched to Claude Opus 5.5 · high — GPT-6.1 Sol is weak at video animation');
    const { details } = status.meta.status;
    assert.deepEqual([details.from, details.to, details.effort], [SOL, OPUS, 'high']);
    assert.equal(details.reason, run.route.reason);
  });

  await t.test('model.set {effort: max} holds for the next turn only, then the previous effort returns', async () => {
    const reply = waitForNew(client, 'message.updated', (message) => message.conversationId === chat.id && message.authorId === vera.id
      && message.state === 'final' && message.body.includes('model.set → '), 90_000);
    reply.catch(() => undefined);
    const asking = await say(chat.id, 'The Remotion animation timing is tricky. [[tool:model.set {"effort":"max","reason":"tricky timing"}]]');
    assert.equal(asking.status, 'done', asking.error);
    assert.deepEqual([asking.model, asking.effort], [OPUS, 'high'], 'the asking turn itself keeps its route');
    assert.match((await reply).body, /"appliesTo":"next turn"/);

    // Both the requested turn and the return after it are switches with a quiet line (RT2).
    const switchLine = () => { const line = waitForNew(client, 'message.created', isSwitch(chat.id), 90_000); line.catch(() => undefined); return line; };
    const liftedLine = switchLine();
    const lifted = await say(chat.id, 'Continue the Remotion animation.');
    assert.equal(lifted.status, 'done', lifted.error);
    assert.deepEqual([lifted.model, lifted.effort, lifted.route.by], [OPUS, 'max', 'request']);
    const liftedStatus = await liftedLine;
    assert.equal(liftedStatus.body, 'Switched to Claude Opus 5.5 · max — effort requested by the agent');
    assert.deepEqual(['from', 'to', 'effort', 'by'].map((key) => liftedStatus.meta.status.details[key]), [OPUS, OPUS, 'max', 'request']);

    const backLine = switchLine();
    const back = await say(chat.id, 'Polish the Remotion animation.');
    assert.equal(back.status, 'done', back.error);
    assert.deepEqual([back.model, back.effort], [OPUS, 'high'], 'back to the effort before the request');
    assert.notEqual(back.route.by, 'request');
    const backStatus = await backLine;
    assert.match(backStatus.body, /^Switched to Claude Opus 5\.5 · high — /);
    if (back.route.by === 'previous') assert.equal(backStatus.body, 'Switched to Claude Opus 5.5 · high — back to the choice before the agent\'s request');
    assert.deepEqual(['from', 'to', 'effort'].map((key) => backStatus.meta.status.details[key]), [OPUS, OPUS, 'high']);
  });

  await t.test('routing.preview names the model and work of a chat\'s first turn; the person\'s line lifts its effort to high', async () => {
    for (const [text, model, effort, work] of [[CODING, SOL, 'medium', 'coding'], [REMOTION, OPUS, 'high', 'video animation']]) {
      const fresh = await client.call('chats.create', { title: `Preview ${effort}`, agentIds: [vera.id] });
      await client.call('events.subscribe', { topics: [`chat:${fresh.id}`] });
      const preview = await client.call('routing.preview', { agentId: vera.id, conversationId: fresh.id, text });
      assert.deepEqual([preview.modelId, preview.effort], [model, effort]);
      const run = await say(fresh.id, text);
      assert.equal(run.status, 'done', run.error);
      // the preview has no line of the person yet; the turn answers one (routing/person-turn.ts)
      assert.deepEqual(
        { modelId: run.model, effort: run.effort, category: run.route.category, by: run.route.by, reason: run.route.reason },
        { modelId: preview.modelId, effort: 'high', category: preview.category, by: preview.by, reason: `${work} · ${PERSON}` },
      );
    }
  });
});
