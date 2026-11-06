// ACP turns open their session in the turn's folder like every engine (31.10.2026: no refusal for launches that may
// read project settings there). The agent process and the probe session (account check, model offer) use the neutral
// folder – in production the empty engine folder, never temp – with the launch's own args and env.
// Owns: nothing in production. Never starts a real binary (scripted agent over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpEngine, type AcpLaunch } from '../../../src/runtime/engines/acp/engine.ts';
import { createEngineRegistry } from '../../../src/runtime/engines/registry.ts';
import { engineCwd } from '../../../src/runtime/system/paths.ts';
import { account, acpAgent, fakeFinder, testSupervisor, turnInput } from './fakes.ts';

const NEUTRAL = '/data/engine-cwd';
const WORKSPACE = '/fake-home/Workforce';
const LAUNCH: AcpLaunch = { name: 'Fake Agent', command: '/bin/fake-agent', args: ['--acp'], env: { FAKE_HOME: '/homes/a' } };

function setup(launch: AcpLaunch) {
  const agent = acpAgent();
  const engine = new AcpEngine({ supervisor: testSupervisor(agent.spawn), cwd: NEUTRAL, version: '0.2.0', launch: async () => launch, env: { PATH: '/bin' } });
  const sent = (method: string) => agent.state.requests.filter((r: any) => r.method === method);
  return { agent, engine, sent };
}

const turn = (patch: Record<string, unknown> = {}) => turnInput({ account: account({ id: 'acc_acp', provider: 'gemini' }), model: 'default', cwd: WORKSPACE, ...patch }).input;

test('acp turns: the session runs in the workspace; the process and the probe stay neutral', async () => {
  const { agent, engine, sent } = setup({ ...LAUNCH, args: ['--acp', '--no-project-settings'], env: { FAKE_HOME: '/homes/a', FAKE_PROJECT: '0' } });
  const result = await engine.run(turn());
  assert.equal(result.stop, 'done');
  assert.deepEqual(sent('session/new').map((r: any) => r.params.cwd), [WORKSPACE]);
  const [spawn] = agent.calls;
  assert.equal(spawn.options.cwd, NEUTRAL);
  assert.deepEqual(spawn.args, ['--acp', '--no-project-settings'], 'the launch args reach the agent unchanged');
  assert.equal(spawn.options.env?.FAKE_PROJECT, '0');
  assert.equal(spawn.options.env?.FAKE_HOME, '/homes/a');
  await engine.dispose();
});

test('acp project settings: the registry runs agent processes and probe sessions in the empty engine folder, not in temp', async () => {
  const agent = acpAgent();
  const paths = { temp: '/data/tmp', data: '/data' };
  const registry = createEngineRegistry({
    supervisor: testSupervisor(agent.spawn), finder: fakeFinder({}), paths, version: '1', apiKey: async () => undefined,
    acp: async () => LAUNCH,
  });
  const engine = registry.get('acp');
  assert.equal((await engine.checkAccount(account({ id: 'acc_acp', provider: 'gemini' }))).state, 'ok');
  const folder = engineCwd(paths);
  assert.equal(agent.calls[0].options.cwd, folder);
  assert.deepEqual(agent.state.requests.filter((r: any) => r.method === 'session/new').map((r: any) => r.params.cwd), [folder]);
  assert.notEqual(folder, paths.temp, 'helper turns (decisions) work in temp; the probe folder is not theirs');
  await registry.dispose();
});
