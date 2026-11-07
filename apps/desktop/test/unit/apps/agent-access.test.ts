// AF-005: which agents may use a connector – the "agents" list of its entry. Read from mcp.json (ids or names, missing =
// every agent), left out of the fingerprint (a changed list connects nothing again but applies at once), shown in apps.list
// and status.json, and enforced by the tool registry: the tools are offered to and callable by those agents only.
// Owns: these assertions. Never: a real server or network (connect, OAuth and the vault are fakes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentsOf, connectorAllows, sameAgents } from '../../../src/runtime/apps/agent-access.ts';
import { readConnectors } from '../../../src/runtime/apps/connectors.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { appsFixture, dataFolder } from './service-fakes.ts';

const settle = async (f: ReturnType<typeof appsFixture>) => { await f.apps.idle(); f.timers.fireAll(); await f.apps.idle(); };
const agent = (id: string, name: string) => ({ id, name }) as Agent;
const ANNA = agent('agt_anna', 'Anna');
const BEN = agent('agt_ben', 'Ben');
const MODE = { key: 'general', name: 'General', tools: ['*'] } as unknown as ModeInfo;

test('the list: missing = every agent, [] = none, ids or names (any case), only texts kept', () => {
  assert.deepEqual(agentsOf({}), {});
  assert.deepEqual(agentsOf({ agents: 'all' }), {}, 'not a list: every agent');
  assert.deepEqual(agentsOf({ agents: [' agt_anna ', 3, '', 'agt_anna', 'Ben'] }), { agents: ['agt_anna', 'Ben'] });
  assert.equal(connectorAllows({}, ANNA), true);
  assert.equal(connectorAllows({ agents: [] }, ANNA), false);
  assert.equal(connectorAllows({ agents: ['agt_anna'] }, ANNA), true);
  assert.equal(connectorAllows({ agents: ['agt_anna'] }, BEN), false);
  assert.equal(connectorAllows({ agents: ['ben'] }, BEN), true, 'a name in any case');
  assert.equal(connectorAllows({ agents: ['ben'] }, { id: 'agt_ben' }), false, 'without its name only the id counts');
  assert.equal(sameAgents(undefined, undefined), true);
  assert.equal(sameAgents(undefined, []), false);
  assert.equal(sameAgents(['B', 'a'], ['a', 'b']), true);
});

test('files: "agents" is read from mcp.json and mail.json and is no part of the fingerprint', () => {
  const data = dataFolder();
  data.write('mcp.json', { mcpServers: { a: { url: 'https://a.example/mcp', agents: ['agt_anna'] }, b: { url: 'https://b.example/mcp' } } });
  data.write('mail.json', { mailboxes: { work: { address: 'me@example.com', password: 'secret://m', agents: ['Ben'] } } });
  const first = readConnectors(data.dir).connectors;
  assert.deepEqual(first.map((c) => c.agents), [['agt_anna'], undefined, ['Ben']]);
  data.write('mcp.json', { mcpServers: { a: { url: 'https://a.example/mcp', agents: ['agt_ben'] }, b: { url: 'https://b.example/mcp' } } });
  const second = readConnectors(data.dir).connectors;
  assert.equal(second[0].fingerprint, first[0].fingerprint, 'who may use it is not how it connects');
});

test('service: a changed agents list applies at once without connecting again; list, status.json and usableBy follow it', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { crm: { url: 'https://crm.example/mcp' } } });
  f.servers.add('https://crm.example/mcp', ['find_customer']);
  f.apps.start();
  await settle(f);
  const opened = f.servers.opened.length;
  assert.deepEqual(f.apps.usableBy(ANNA.id), ['crm']);
  assert.equal(f.apps.list()[0].agents, undefined);
  const def = f.tools.defs.get('app.crm.find_customer');
  assert.ok(def?.forAgent, 'connector tools carry the agent rule');
  assert.equal(def.forAgent(BEN), true);

  f.data.write('mcp.json', { mcpServers: { crm: { url: 'https://crm.example/mcp', agents: [ANNA.id] } } });
  f.changedFile();
  await settle(f);
  assert.equal(f.servers.opened.length, opened, 'no new connection');
  assert.equal(f.apps.list()[0].status, 'ok');
  assert.deepEqual(f.apps.list()[0].agents, [ANNA.id]);
  assert.deepEqual(f.apps.usableBy(ANNA.id), ['crm']);
  assert.deepEqual(f.apps.usableBy(BEN.id), []);
  assert.equal(f.tools.defs.get('app.crm.find_customer'), def, 'the same registered tool reads the new list');
  assert.equal(def.forAgent(ANNA), true);
  assert.equal(def.forAgent(BEN), false);
  const status = f.data.read('status.json') as { connectors: Record<string, { agents?: string[] }> };
  assert.deepEqual(status.connectors.crm.agents, [ANNA.id]);

  f.data.write('mcp.json', { mcpServers: { crm: { url: 'https://crm.example/mcp' } } });
  f.changedFile();
  await settle(f);
  assert.equal(def.forAgent(BEN), true, 'the key gone: every agent again');
  await f.apps.stop();
});

test('registry: a tool with an agent rule is offered to and callable by those agents only', async () => {
  const registry = new Registry({ services: () => ({}) as RuntimeServices });
  let ran = 0;
  registry.register({
    name: 'app.crm.find_customer', description: 'Finds a customer', inputSchema: { type: 'object' }, category: 'read', anyMode: true,
    forAgent: (who) => who.id === ANNA.id,
    run: async () => { ran += 1; return { content: [{ type: 'text', text: 'found' }] }; },
  });
  registry.register({ name: 'app.crm.broken', description: 'x', inputSchema: { type: 'object' }, category: 'read', anyMode: true, forAgent: () => { throw new Error('boom'); }, run: async () => ({ content: [] }) });
  assert.deepEqual(registry.specsFor(ANNA, MODE).map((spec) => spec.name), ['app.crm.find_customer']);
  assert.deepEqual(registry.specsFor(BEN, MODE).map((spec) => spec.name), [], 'a rule that throws offers nothing');
  const refused = await registry.call('app.crm.find_customer', {}, { agent: BEN, mode: 'general', runId: 'run_1' } as never, 'call_1');
  assert.equal(refused.isError, true);
  assert.match(String(refused.content[0] && 'text' in refused.content[0] ? refused.content[0].text : ''), /shares with other agents only/);
  assert.equal(ran, 0);
});
