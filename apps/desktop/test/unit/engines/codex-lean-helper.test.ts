// LEAN (23.10.): a Codex helper turn (no tools, no hub, no session) starts a lean thread – no environment,
// Codex's built-in tool features off for that thread, no permission/app/collaboration/environment blocks,
// web search disabled, no empty developer message – on top of the workspace isolation; an agent turn's thread is
// lean too since B-049 F1 but keeps its environment, the shell and its developer instructions (codex-lean-agent.test.ts).
// warm() says whether an account's app-server is up; prewarm() starts it with one lean
// thread and no turn (no model call), shares a running start and leaves a running server alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { HELPER_NOTE, HELPER_FEATURES_OFF, helperThread } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { account, fakeSpawn, fakeFinder, testSupervisor, turnInput, tick } from './fakes.ts';

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await tick();
}

function appServer() {
  const requests: any[] = [];
  let threads = 0;
  const { spawn, calls } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'fake' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/unsubscribe': child.send({ id: msg.id, result: { status: 'unsubscribed' } }); break;
        case 'turn/start': {
          const threadId = msg.params.threadId;
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          child.send({ method: 'item/completed', params: { threadId, turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: '{"ok":true}' } } });
          child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
          break;
        }
        default: if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, calls, requests };
}

const engineWith = (fake: ReturnType<typeof appServer>) =>
  new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0' });

test('helperThread: lean config merged on top of the isolation, environments empty, ephemeral, no empty developer message', () => {
  const lean = helperThread({ cwd: '/w', developerInstructions: '  ', config: { projects: { '/w': { trust_level: 'untrusted' } }, project_doc_max_bytes: 0 } });
  assert.equal(lean.developerInstructions, HELPER_NOTE, 'no empty developer message: only the note');
  assert.equal((lean.config.agents as { enabled: boolean }).enabled, false, 'no agents and no role text');
  assert.deepEqual(lean.config.skills, { include_instructions: false, bundled: { enabled: false } }, 'no skill list');
  assert.deepEqual(lean.environments, []);
  assert.equal(lean.ephemeral, true);
  assert.deepEqual(lean.config.projects, { '/w': { trust_level: 'untrusted' } }, 'the isolation stays');
  assert.equal(lean.config.project_doc_max_bytes, 0);
  assert.equal(lean.config.web_search, 'disabled');
  for (const key of ['include_permissions_instructions', 'include_apps_instructions', 'include_collaboration_mode_instructions', 'include_environment_context']) {
    assert.equal(lean.config[key], false, key);
  }
  const features = lean.config.features as Record<string, boolean>;
  for (const name of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'hooks', 'shell_snapshot']) assert.equal(features[name], false, name);
  assert.equal(Object.keys(features).length, HELPER_FEATURES_OFF.length);
  assert.equal(helperThread({ developerInstructions: 'Now: …' }).developerInstructions, `Now: …\n\n${HELPER_NOTE}`, 'a real developer message stays');
});

test('a helper turn starts the lean thread; an agent turn keeps its environment, the shell and its developer instructions', async () => {
  const fake = appServer();
  const engine = engineWith(fake);
  const helper = await engine.run(turnInput({ runId: 'run_h', agentId: 'system', tools: [], system: { stable: 'Decide.', volatile: '' }, outputSchema: { type: 'object' } }).input);
  assert.equal(helper.stop, 'done');
  assert.deepEqual(helper.structured, { ok: true });
  const [helperStart] = fake.requests.filter((r) => r.method === 'thread/start');
  assert.deepEqual(helperStart.params.environments, [], 'no shell/exec/patch environment');
  assert.equal(helperStart.params.ephemeral, true);
  assert.equal(helperStart.params.config.features.shell_tool, false);
  assert.equal(helperStart.params.config.include_environment_context, false);
  assert.equal(helperStart.params.config.project_doc_max_bytes, 0, 'workspace isolation kept');
  assert.equal(helperStart.params.sandbox, 'read-only');
  assert.equal(helperStart.params.baseInstructions, 'Decide.');
  assert.equal(helperStart.params.developerInstructions, HELPER_NOTE);
  assert.deepEqual(helperStart.params.dynamicTools, []);

  await engine.run(turnInput({ runId: 'run_a' }).input);
  const agentStart = fake.requests.filter((r) => r.method === 'thread/start')[1];
  assert.equal(agentStart.params.environments, undefined, 'an agent keeps its environment');
  assert.equal(agentStart.params.ephemeral, undefined, 'and its history');
  // B-049 F1: lean, but the shell stays (the helper turns it off).
  for (const name of ['shell_tool', 'unified_exec', 'shell_snapshot']) assert.equal(agentStart.params.config.features[name], undefined, name);
  assert.equal(agentStart.params.config.features.plugins, false);
  assert.equal(agentStart.params.config.include_permissions_instructions, false);
  assert.equal(agentStart.params.developerInstructions, 'VOLATILE');
  assert.equal(agentStart.params.dynamicTools.length, 1);
  await engine.dispose();
});

test('warm/prewarm: one start with a lean thread and no turn; a running server is left alone; concurrent calls share the start', async () => {
  const fake = appServer();
  const engine = engineWith(fake);
  const acc = account();
  assert.equal(engine.warm(acc), false, 'nothing started yet');

  await Promise.all([engine.prewarm(acc), engine.prewarm(acc)]);
  assert.equal(fake.calls.length, 1, 'one process for both calls');
  assert.equal(engine.warm(acc), true);
  const methods = fake.requests.map((r) => r.method);
  assert.deepEqual(methods.filter((m) => m !== 'initialized'), ['initialize', 'thread/start', 'thread/unsubscribe']);
  assert.equal(methods.includes('turn/start'), false, 'no model call');
  const start = fake.requests.find((r) => r.method === 'thread/start');
  assert.equal(start.params.cwd, '/engine-cwd', "the server's own empty folder");
  assert.equal(start.params.ephemeral, true);
  assert.deepEqual(start.params.environments, []);
  assert.equal(start.params.sandbox, 'read-only');
  assert.ok(start.params.config.projects['/engine-cwd'], 'the folder is marked untrusted');

  const before = fake.requests.length;
  await engine.prewarm(acc);
  assert.equal(fake.requests.length, before, 'a warm server gets nothing');

  // The next helper turn uses the warm server: no second process.
  await engine.run(turnInput({ runId: 'run_h2', tools: [], system: { stable: 'Decide.', volatile: '' } }).input);
  assert.equal(fake.calls.length, 1);
  await engine.dispose();
  await until(() => !engine.warm(acc));
  assert.equal(engine.warm(acc), false, 'disposed: cold again');
});

test('prewarm failure: Codex missing rejects, nothing stays warm', async () => {
  const fake = appServer();
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: null }), cwd: '/engine-cwd', version: '0.2.0' });
  await assert.rejects(engine.prewarm(account()), /not installed/);
  assert.equal(engine.warm(account()), false);
  assert.equal(fake.calls.length, 0);
});

test('a server that refuses the lean thread (an older or stricter Codex) gets the plain ephemeral helper thread from then on', async () => {
  const requests: any[] = [];
  let threads = 0;
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (msg.method === 'initialize') child.send({ id: msg.id, result: {} });
      else if (msg.method === 'thread/start') {
        if (msg.params.environments) child.send({ id: msg.id, error: { code: -32602, message: 'unknown field `environments`' } });
        else child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } });
      } else if (msg.method === 'thread/unsubscribe') child.send({ id: msg.id, result: {} });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1' } } });
        child.send({ method: 'item/completed', params: { threadId: msg.params.threadId, turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: 'ok' } } });
        child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'completed' } } });
      }
    };
  });
  const engine = new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0' });
  const first = await engine.run(turnInput({ runId: 'run_1', tools: [], system: { stable: 'Decide.', volatile: '' } }).input);
  assert.equal(first.stop, 'done');
  const starts = () => requests.filter((r) => r.method === 'thread/start');
  assert.equal(starts().length, 2, 'lean refused, then the plain thread');
  assert.equal(starts()[1].params.ephemeral, true, 'still nothing in the history');
  assert.equal(starts()[1].params.environments, undefined);
  await engine.run(turnInput({ runId: 'run_2', tools: [], system: { stable: 'Decide.', volatile: '' } }).input);
  assert.equal(starts().length, 3, 'the next helper call goes straight to the plain thread');
  assert.equal(starts()[2].params.environments, undefined);
  await engine.dispose();
});
