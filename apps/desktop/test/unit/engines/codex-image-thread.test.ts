// B-058 i1: the plan-image turn (media/codex-image.ts, EngineTurnInput.nativeTools 'image') opens a Codex thread whose
// one native tool is image_generation: shell, exec, patch, view_image, web search, browser and computer use off, no
// environment, isolation as for every thread. A Codex that refuses these settings never gets a plainer thread.
// Owns: nothing in production. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { HELPER_FEATURES_OFF, agentLeanConfig, imageThread } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { WORKSPACE_FEATURES, threadIsolation } from '../../../src/runtime/engines/codex/isolation.ts';
import { fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';

const SHUT = ['shell_tool', 'unified_exec', 'shell_snapshot', 'view_image', 'computer_use', 'browser_use', 'apps', 'plugins', 'multi_agent', 'skill_search', 'tool_suggest', 'memories'];

function assertImageOnly(params: any, label: string): void {
  const features = params.config.features as Record<string, boolean>;
  assert.equal(features.image_generation, true, `${label}: image_generation on`);
  for (const name of SHUT) assert.equal(features[name], false, `${label}: ${name} off`);
  for (const name of WORKSPACE_FEATURES) assert.equal(features[name], false, `${label}: ${name} off`);
  assert.equal(params.config.web_search, 'disabled', `${label}: no web search`);
  assert.deepEqual(params.environments, [], `${label}: no environment (no shell, exec or patch tool)`);
}

test('imageThread: image_generation on, every other helper feature off, no environment; isolation keys kept', () => {
  const isolation = threadIsolation(['/w'], { GIT_PAGER: 'cat' });
  const out = imageThread({ model: 'gpt-test', cwd: '/w', sandbox: isolation.sandbox, config: isolation.config });
  assertImageOnly(out, 'imageThread');
  const features = out.config.features as Record<string, boolean>;
  assert.deepEqual(Object.keys(features).filter((name) => features[name]), ['image_generation'], 'the one native tool');
  for (const name of HELPER_FEATURES_OFF) if (name !== 'image_generation') assert.equal(features[name], false, name);
  for (const [key, value] of Object.entries(isolation.config)) assert.deepEqual((out.config as any)[key], value, `isolation ${key}`);
  assert.equal(out.sandbox, 'read-only');
  assert.equal(out.model, 'gpt-test');
});

/** A scripted app-server; `refuse(msg)` answers a thread/start with an error. */
function appServer(refuse: (msg: any) => boolean = () => false) {
  const requests: any[] = [];
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (msg.id === undefined) return;
      if (msg.method === 'thread/start' && refuse(msg)) { child.send({ id: msg.id, error: { code: -32602, message: 'unknown feature' } }); return; }
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'fake' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${requests.length}` } } }); break;
        case 'turn/start':
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'completed' } } });
          break;
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, starts: () => requests.filter((r) => r.method === 'thread/start') };
}

const engineOf = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });

test('a turn with nativeTools "image" opens the image-only thread; an ordinary agent turn keeps the lean agent thread', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  assert.equal((await e.run(turnInput({ runId: 'img_1', nativeTools: 'image', readOnly: true }).input)).stop, 'done');
  const [image] = fake.starts();
  assertImageOnly(image.params, 'image turn');
  assert.equal(image.params.sandbox, 'read-only', 'isolation as for every thread');
  assert.equal(image.params.dynamicTools.length, 1, 'our one tool (image.unable in codex-image.ts)');
  assert.equal((await e.run(turnInput({ runId: 'run_2' }).input)).stop, 'done');
  const agent = fake.starts()[1].params;
  assert.deepEqual(agent.config.features, agentLeanConfig().features, 'an agent thread is unchanged');
  assert.equal(agent.environments, undefined);
  await e.dispose();
});

test('a Codex that refuses the image-only settings gets no plainer thread: the image turn fails', async () => {
  const fake = appServer((msg) => msg.params?.config?.features?.view_image === false);
  const e = engineOf(fake.spawn);
  const result = await e.run(turnInput({ runId: 'img_1', nativeTools: 'image', readOnly: true }).input);
  assert.equal(result.stop, 'error');
  assert.ok(fake.starts().length >= 1);
  for (const [i, start] of fake.starts().entries()) assertImageOnly(start.params, `thread/start ${i + 1}`);
  await e.dispose();
});
