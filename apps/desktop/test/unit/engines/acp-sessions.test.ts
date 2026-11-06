// Generic ACP engine sessions and processes against the scripted agent: session reuse and
// session/load after a restart (replay dropped), session/resume, rebase when an agent cannot
// reopen, models/efforts from the agent's offer, images and files, account checks, one process
// per account, idle shutdown, launch failures and the registry wiring; "Stop all work" ends the agent processes (C4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpEngine } from '../../../src/runtime/engines/acp/engine.ts';
import { createEngineRegistry } from '../../../src/runtime/engines/registry.ts';
import { acpAgent, account, fakeFinder, testSupervisor, tick, turnInput } from './fakes.ts';
import { setup, until } from './acp-fixture.ts';

test('acp: resume after a restart uses session/load (replay dropped, context block only); live sessions are reused', async () => {
  const { agent, engine, requests } = setup({
    handle: (msg, reply, child) => {
      if (msg.method !== 'session/load') return false;
      child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } } } });
      reply.result(null);
      return true;
    },
  });
  const { input, events } = turnInput({ session: { ref: 'sess_old', generation: 3 }, mcp: { url: 'http://127.0.0.1:9/mcp/leasetoken_leasetoken_4', token: 'leasetoken_leasetoken_4' } });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Echo: hello');
  assert.deepEqual(result.session, { ref: 'sess_old', generation: 3 });
  const load = requests('session/load')[0];
  assert.equal(load.params.sessionId, 'sess_old');
  assert.equal(load.params.cwd, '/work');
  assert.equal(load.params.mcpServers[0].type, 'http');
  assert.ok(!events.some((e: any) => e.type === 'text' && e.delta.includes('OLD HISTORY')));
  const prompt = requests('session/prompt')[0].params.prompt;
  assert.equal(prompt[0].text, '<workforce-context>\nVOLATILE\n</workforce-context>');
  assert.equal(requests('session/new').length, 0);
  // Same process: the session is live, no second load.
  await engine.run(turnInput({ session: { ref: 'sess_old', generation: 3 } }).input);
  assert.equal(requests('session/load').length, 1);
  // The process dies: the next turn starts a new one and loads the session again.
  agent.calls[0].child.exit(1);
  await tick();
  const after = await engine.run(turnInput({ session: { ref: 'sess_old', generation: 3 } }).input);
  assert.equal(after.stop, 'done');
  assert.equal(agent.calls.length, 2);
  assert.equal(requests('session/load').length, 2);
  await engine.dispose();
});

test('acp: session/resume is preferred when offered; an agent that cannot reopen reports a rebase', async () => {
  const resumable = setup({ init: { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } } } });
  assert.equal((await resumable.engine.run(turnInput({ session: { ref: 'sess_r', generation: 1 } }).input)).stop, 'done');
  assert.equal(resumable.requests('session/resume').length, 1);
  assert.equal(resumable.requests('session/load').length, 0);
  await resumable.engine.dispose();

  const stateless = setup({ init: { agentCapabilities: { loadSession: false } } });
  const result = await stateless.engine.run(turnInput({ session: { ref: 'sess_x', generation: 1 } }).input);
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.code, 'conflict');
  assert.equal(result.error?.details?.rebase, true);
  assert.equal(stateless.requests('session/prompt').length, 0);
  await stateless.engine.dispose();

  const refusing = setup({ handle: (msg, reply) => (msg.method === 'session/load' ? (reply.error(-32602, 'Session not found'), true) : false) });
  const refused = await refusing.engine.run(turnInput({ session: { ref: 'sess_y', generation: 1 } }).input);
  assert.equal(refused.error?.details?.rebase, true);
  await refusing.engine.dispose();
});

test('acp: models and efforts from configOptions; the turn sets model and thought level', async () => {
  const configOptions = [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'pro', options: [{ value: 'pro', name: 'Pro' }, { value: 'flash', name: 'Flash' }] },
    { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ group: 'all', name: 'All', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }] },
  ];
  const { engine, requests } = setup({ session: { configOptions } });
  const models = await engine.listModels(account());
  assert.deepEqual(models.map((m) => [m.model, m.name]), [['pro', 'Pro'], ['flash', 'Flash']]);
  assert.deepEqual(models[0].efforts, ['low', 'medium', 'high']);
  assert.equal(models[0].defaultEffort, 'medium');
  assert.equal(models[0].vision, true);
  const result = await engine.run(turnInput({ model: 'flash', effort: 'xhigh' }).input);
  assert.equal(result.stop, 'done');
  assert.deepEqual(requests('session/set_config_option').map((r: any) => [r.params.configId, r.params.value]), [['model', 'flash'], ['thinking', 'high']]);
  await engine.dispose();
});

test('acp: legacy models field uses session/set_model; no offer gives one default model', async () => {
  const legacy = setup({ session: { models: { availableModels: [{ modelId: 'm-1', name: 'M1' }, { modelId: 'm-2', name: 'M2' }], currentModelId: 'm-1' } } });
  await legacy.engine.run(turnInput({ model: 'm-2' }).input);
  assert.deepEqual(legacy.requests('session/set_model').map((r: any) => r.params.modelId), ['m-2']);
  await legacy.engine.dispose();
  const plain = setup();
  const models = await plain.engine.listModels(account());
  assert.deepEqual(models.map((m) => [m.model, m.efforts]), [['default', ['none']]]);
  await plain.engine.run(turnInput({ model: 'default' }).input);
  assert.equal(plain.requests('session/set_model').length + plain.requests('session/set_config_option').length, 0);
  await plain.engine.dispose();
});

test('acp: images become image blocks only when the agent accepts them; files become resource links', async () => {
  const items = [{ type: 'text', text: 'look' }, { type: 'image', path: '/work/shot.png', mime: 'image/png' }, { type: 'file', path: '/work/notes.pdf', name: 'notes.pdf', mime: 'application/pdf' }];
  const withImages = setup();
  await withImages.engine.run(turnInput({ input: items }).input);
  const prompt = withImages.requests('session/prompt')[0].params.prompt;
  assert.deepEqual(prompt[2], { type: 'image', mimeType: 'image/png', data: 'AQID' });
  assert.equal(prompt[3].type, 'resource_link');
  assert.match(prompt[3].uri, /^file:\/\//);
  assert.equal(prompt[3].name, 'notes.pdf');
  await withImages.engine.dispose();
  const textOnly = setup({ init: { agentCapabilities: { loadSession: true } } });
  const { input, events } = turnInput({ input: items, mcp: { url: 'http://127.0.0.1:9/mcp/x', token: 'x' } });
  await textOnly.engine.run(input);
  const sent = textOnly.requests('session/prompt')[0].params.prompt;
  assert.deepEqual(sent[2], { type: 'text', text: '[image: /work/shot.png]' });
  assert.deepEqual(textOnly.requests('session/new')[0].params.mcpServers, []);
  assert.ok(events.some((e: any) => e.type === 'status' && /cannot use Autark tools/.test(e.note)));
  await textOnly.engine.dispose();
});

test('acp: one process per account, checkAccount ok, not installed, idle shutdown', async () => {
  const { agent, engine } = setup({}, { idleMs: 1000, now: () => clock });
  let clock = 0;
  assert.deepEqual(await engine.checkAccount(account()), { state: 'ok' });
  await engine.run(turnInput().input);
  await engine.run(turnInput({ account: account({ id: 'acc_two' }) }).input);
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls.filter((c) => c.child.exitCode === null).length, 2);
  clock = 5000;
  await engine.disposeIdle();
  await until(() => agent.calls.every((c) => c.child.exitCode !== null || c.child.killed));
  await engine.dispose();

  const missing = new AcpEngine({ supervisor: testSupervisor(acpAgent().spawn), cwd: '/tmp', version: '1', launch: async () => undefined });
  const result = await missing.run(turnInput({ account: account({ label: 'Gemini CLI' }) }).input);
  assert.equal(result.error?.code, 'unavailable');
  assert.equal(result.error?.message, 'Gemini CLI is not installed.');
  assert.deepEqual(await missing.checkAccount(account({ label: 'Gemini CLI' })), { state: 'error', message: 'Gemini CLI is not installed.' });
  await missing.dispose();

  const old = setup({ init: { protocolVersion: 2 } });
  const refused = await old.engine.run(turnInput().input);
  assert.equal(refused.error?.message, 'Fake Agent speaks an unsupported ACP version.');
  await old.engine.dispose();
});

test('acp: the registry builds the ACP engine; without a resolver its turns report the agent as not installed', async () => {
  const agent = acpAgent();
  const base = { supervisor: testSupervisor(agent.spawn), finder: fakeFinder({}), paths: { temp: '/tmp', data: '/data' }, version: '1', apiKey: async () => undefined };
  const bare = createEngineRegistry(base);
  const engine = bare.get('acp');
  assert.equal(engine.id, 'acp');
  assert.deepEqual(engine.caps, { sessions: true, dynamicTools: false, mcp: true, images: true, rebase: true, structured: false, ownTools: true });
  const result = await engine.run(turnInput({ account: account({ label: 'Some agent' }) }).input);
  assert.equal(result.error?.message, 'Some agent is not installed.');
  assert.equal(agent.calls.length, 0);
  await bare.dispose();
  const wired = createEngineRegistry({ ...base, acp: async () => ({ name: 'Wired Agent', command: '/bin/agent', args: ['acp'], projectSettings: 'ignored' as const }) });
  assert.equal((await wired.get('acp').run(turnInput().input)).text, 'Echo: hello');
  assert.deepEqual(agent.calls[0].args, ['acp']);
  await wired.dispose();
});

test('acp: "Stop all work" (stopBackground, live test C4) ends every started agent process with its tree; the next turn starts it again', async () => {
  const { agent, engine } = setup();
  assert.equal(await engine.stopBackground(), 0, 'nothing started: nothing to end, nothing started for it');
  assert.equal(agent.calls.length, 0);
  await engine.run(turnInput().input);
  await engine.run(turnInput({ account: account({ id: 'acc_two' }) }).input);
  assert.equal(await engine.stopBackground(), 2);
  await until(() => agent.calls.every((c) => c.child.exitCode !== null || c.child.killed));
  const again = await engine.run(turnInput().input);
  assert.equal(again.stop, 'done');
  assert.equal(agent.calls.length, 3, 'the agent starts again for the next turn');
  await engine.dispose();
});

test('acp: "Stop all work" while a stopped turn still opens its session ends it as a stop, not an account failure (C4)', async () => {
  const { agent, engine } = setup({ handle: (msg) => msg.method === 'session/new' }); // session/new is never answered
  const controller = new AbortController();
  const running = engine.run(turnInput({ signal: controller.signal }).input);
  await until(() => agent.state.requests.some((request: any) => request.method === 'session/new'));
  controller.abort();
  assert.equal(await engine.stopBackground(), 1);
  const result = await running;
  assert.equal(result.stop, 'interrupted');
  assert.equal(result.error?.code, 'cancelled');
  await engine.dispose();
});
