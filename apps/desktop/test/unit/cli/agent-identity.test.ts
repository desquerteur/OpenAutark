// AF-001 – the agents' own identity for wf: the runtime issues AUTARK_AGENT_TOKEN per agent (HMAC under a key of this
// process) and puts it into every shell of that agent (shell.exec/secrets.run per call, Claude Code per turn, Codex per
// thread); wf hands it over beside the owner token, only to the agent's own app; the /ws handshake turns an owner Hello
// with a valid one into owner scope with the agent's id and refuses any other (4406 → forbidden, exit 3) – it never falls
// back to the person's name. An inherited token never reaches another process.
// Owns: these assertions only. Never: starts the real runtime or reads the person's app data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { inspect } from 'node:util';
import { fileTools, type ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { AGENT_TOKEN_ENV } from '../../../src/shared/api/protocol.ts';
import { actingAgent, agentIdentityEnv, agentOfToken, agentToken, agentTokenEnv } from '../../../src/runtime/engines/agent-token.ts';
import { withShim } from '../../../src/runtime/engines/wf-shim.ts';
import { threadIsolation } from '../../../src/runtime/engines/codex/isolation.ts';
import { connect } from '../../../src/runtime/wf-cli/client.ts';
import { Endpoint, agentIdentity, discover, type DiscoverEnv } from '../../../src/runtime/wf-cli/discover.ts';
import { exitCodeOf, type CliError } from '../../../src/runtime/wf-cli/errors.ts';
import { DEVICE_TOKEN, LAUNCH_TOKEN, fixture } from '../http/fixture.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const OWNER_TOKEN = 'owner-token-0123456789abcdef0123456789abcdef';
const org = (agents: Record<string, { archivedAt?: number }>) => ({
  org: { get: (id: string) => (Object.hasOwn(agents, id) ? { id, name: id, ...agents[id] } : undefined) },
}) as unknown as Pick<RuntimeServices, 'org'>;

test('agent tokens: issued per agent, checked by this process only; forged, swapped or malformed ones are refused', () => {
  const token = agentToken('ag_tom');
  assert.match(token, /^wfa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(agentToken('ag_tom'), token, 'stable for an agent within this runtime');
  assert.equal(agentOfToken(token), 'ag_tom');
  const [version, , sig] = token.split('.');
  assert.equal(agentOfToken(`${version}.${Buffer.from('ag_ava').toString('base64url')}.${sig}`), undefined, 'another agent\'s id under Tom\'s signature');
  assert.equal(agentOfToken(`${token.slice(0, -2)}AA`), undefined, 'a changed signature');
  for (const bad of ['', 'wfa1', 'wfa1..', 'wfa2.YWdfdG9t.x', `${token}.extra`, 'x'.repeat(600)]) assert.equal(agentOfToken(bad), undefined, JSON.stringify(bad.slice(0, 20)));

  const services = org({ ag_tom: {}, ag_old: { archivedAt: 1 } });
  assert.equal(actingAgent(services, token), 'ag_tom');
  assert.equal(actingAgent(services, agentToken('ag_old')), undefined, 'an archived agent writes nothing');
  assert.equal(actingAgent(services, agentToken('ag_gone')), undefined, 'an id that is no agent here');
  assert.deepEqual(agentTokenEnv(services, 'ag_tom'), { [AGENT_TOKEN_ENV]: token });
  assert.deepEqual(agentTokenEnv(services, 'ag_stand_in'), {}, 'a stand-in of another company gets none');
  assert.deepEqual(agentIdentityEnv(undefined), {});
});

test('the agents\' env: an inherited AUTARK_AGENT_TOKEN never passes on; a Codex thread\'s shells carry its agent\'s', () => {
  const env = withShim({ PATH: '/usr/bin', [AGENT_TOKEN_ENV]: 'wfa1.someone.else' }, '/data', '/data/bin', 'linux');
  assert.equal(env[AGENT_TOKEN_ENV], undefined);
  assert.equal(env.AUTARK_DATA, '/data');
  const thread = threadIsolation(['/work'], { GIT_CONFIG_COUNT: '1' }, 'ag_tom');
  assert.equal(thread.config.shell_environment_policy.set.GIT_CONFIG_COUNT, '1', 'the safe git env stays');
  assert.equal(agentOfToken(thread.config.shell_environment_policy.set[AGENT_TOKEN_ENV]!), 'ag_tom');
  assert.equal(threadIsolation(['/work'], {}).config.shell_environment_policy.set[AGENT_TOKEN_ENV], undefined, 'a probe thread has none');
});

test('shell.exec: the command of an agent of this runtime gets its identity, a stand-in none', async () => {
  const seen: Array<string | undefined> = [];
  const shell: ShellSpawn = (_command, options) => {
    seen.push(options.env?.[AGENT_TOKEN_ENV]);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: null, kill: () => true });
    setImmediate(() => child.emit('close', 0));
    return child as unknown as ReturnType<ShellSpawn>;
  };
  const exec = fileTools({ shell }).find((tool) => tool.name === 'shell.exec')!;
  const services = { ...org({ ag_tom: {} }), paths: { workspace: path.resolve('/wf-test/workspace') }, secrets: { redact: (value: string) => value } } as unknown as RuntimeServices;
  const ctx = (id: string): ToolContext => ({ agent: { id, name: id } as ToolContext['agent'], runId: 'run_1', mode: 'general', signal: new AbortController().signal, status() {}, services });
  await exec.run({ command: 'wf send chat_1 Done' }, ctx('ag_tom'));
  await exec.run({ command: 'wf send chat_1 Done' }, ctx('ag_other_company'));
  assert.equal(agentOfToken(seen[0]!), 'ag_tom');
  assert.equal(seen[1], undefined);
});

function discoverEnv(vars: Record<string, string>): DiscoverEnv {
  const runtime = JSON.stringify({ port: 47811, token: OWNER_TOKEN });
  return {
    platform: 'win32', env: vars, home: 'C:\\Users\\Ann', cwd: 'C:\\work',
    readFile: (file) => { if (file.endsWith('runtime.json')) return runtime; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    alive: () => true,
  };
}

test('wf run by an agent: the Hello carries its identity for its own app only; output never shows it', () => {
  const token = agentToken('ag_tom');
  const own = discover({}, discoverEnv({ AUTARK_DATA: 'C:\\Data\\Autark', [AGENT_TOKEN_ENV]: token }));
  assert.ok(own.ok);
  assert.equal(own.endpoint.asAgent, true);
  assert.deepEqual(own.endpoint.hello(), { protocol: 1, token: OWNER_TOKEN, client: 'cli', agent: token });
  assert.equal(own.endpoint.redact(`a ${token} b ${OWNER_TOKEN}`), 'a [token] b [token]');
  assert.ok(!inspect(own.endpoint).includes(token) && !JSON.stringify(own.endpoint).includes(token), 'never serialised');

  const same = discover({ data: 'c:\\data\\autark' }, discoverEnv({ AUTARK_DATA: 'C:\\Data\\Autark', [AGENT_TOKEN_ENV]: token }));
  assert.ok(same.ok && same.endpoint.asAgent, '--data naming the same folder (case-insensitive on Windows)');
  const other = discover({ data: 'D:\\Other company' }, discoverEnv({ AUTARK_DATA: 'C:\\Data\\Autark', [AGENT_TOKEN_ENV]: token }));
  assert.ok(other.ok && !other.endpoint.asAgent, 'another company does not know the agent');
  assert.equal(other.ok && other.endpoint.hello().agent, undefined);
  const person = discover({}, discoverEnv({ APPDATA: 'C:\\Users\\Ann\\AppData\\Roaming' }));
  assert.ok(person.ok && !person.endpoint.asAgent, 'the person\'s own wf');
  assert.equal(agentIdentity({ platform: 'linux', env: { [AGENT_TOKEN_ENV]: '  ' } }, '/data'), undefined, 'blank is none');
});

test('/ws: an owner Hello with a valid agent identity is the owner acting as that agent; any other identity is refused (exit 3)', async () => {
  const f = fixture();
  Object.assign(f.services, org({ ag_tom: {}, ag_old: { archivedAt: 1 } }));
  try {
    const { port } = await f.server.listen();
    const rpc = await connect(new Endpoint({ dataDir: f.root, port, token: LAUNCH_TOKEN, agent: agentToken('ag_tom') }));
    assert.deepEqual(await rpc.call('chats.list'), { method: 'chats.list', scope: 'owner' }, 'owner access stays');
    assert.deepEqual(f.rpc.attached.map((entry) => entry.scope), [{ kind: 'owner', agentId: 'ag_tom' }]);
    rpc.close();

    for (const [label, endpoint] of [
      ['an identity this process never issued', new Endpoint({ dataDir: f.root, port, token: LAUNCH_TOKEN, agent: 'wfa1.YWdfdG9t.forged' })],
      ['an archived agent', new Endpoint({ dataDir: f.root, port, token: LAUNCH_TOKEN, agent: agentToken('ag_old') })],
      ['a device token with an agent identity', new Endpoint({ dataDir: f.root, port, token: DEVICE_TOKEN, agent: agentToken('ag_tom') })],
    ] as const) {
      const refused = await connect(endpoint);
      await assert.rejects(refused.call('chats.list'), (error: CliError) => error.kind === 'forbidden' && exitCodeOf(error.kind) === 3 && /AUTARK_AGENT_TOKEN/.test(error.message), label);
    }
    assert.equal(f.rpc.attached.length, 1, 'no refused socket reached the RPC server');
  } finally {
    await f.close();
  }
});
