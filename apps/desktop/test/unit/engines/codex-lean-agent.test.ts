// B-049 F1: every Codex agent thread opens lean – thread/start and thread/resume after a restart:
// Codex's own tools off except the shell (shell_tool, unified_exec, shell_snapshot) and view_image, isolation.ts's
// workspace features off again, the permission/app/collaboration/environment blocks off, Codex's live web search on (E1), apps
// off; its environment, history, developer instructions and isolation (read-only open, untrusted cwd, approvals to
// us, the turn's own sandbox) stay exactly as before. A Codex that refuses the lean settings but takes today's gets
// today's from then on (per server process); a refusal of both is the thread's own (resume → rebase) and is not
// remembered; a timeout never falls back.
// Owns: nothing in production. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { AGENT_FEATURES_KEPT, AGENT_FEATURES_OFF, HELPER_FEATURES_OFF, HIDDEN_THREAD, agentLeanConfig, agentThread, openAgentThread } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { WORKSPACE_FEATURES, threadIsolation } from '../../../src/runtime/engines/codex/isolation.ts';
import { RpcError } from '../../../src/runtime/engines/codex/rpc.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';

/** A scripted app-server; `refuse(msg)` answers a thread/start or thread/resume with an error. */
function appServer(refuse: (msg: any) => boolean = () => false) {
  const requests: any[] = [];
  let threads = 0;
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (msg.id === undefined) return;
      if ((msg.method === 'thread/start' || msg.method === 'thread/resume') && refuse(msg)) {
        child.send({ id: msg.id, error: { code: -32602, message: 'unknown variant `web_search`' } });
        return;
      }
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'fake' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/resume': child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } }); break;
        case 'thread/inject_items': case 'thread/unsubscribe': child.send({ id: msg.id, result: {} }); break;
        case 'turn/start':
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          child.send({ method: 'item/completed', params: { threadId: msg.params.threadId, turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: 'ok' } } });
          child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'completed' } } });
          break;
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, requests, sent: (method: string) => requests.filter((r) => r.method === method) };
}

const engineOf = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });
const lean = (params: any) => params.config?.include_environment_context === false;

function assertLeanAgent(params: any, label: string): void {
  assert.deepEqual(params.config.features, agentLeanConfig().features, `${label}: Codex's own tools off`);
  for (const name of AGENT_FEATURES_KEPT) assert.equal(params.config.features[name], undefined, `${label}: ${name} kept`);
  for (const key of ['include_permissions_instructions', 'include_apps_instructions', 'include_collaboration_mode_instructions', 'include_environment_context']) {
    assert.equal(params.config[key], false, `${label}: ${key}`);
  }
  assert.equal(params.config.web_search, 'live', `${label}: Codex's own live web search (E1)`);
  assert.deepEqual(params.config.apps, { _default: { enabled: false } }, label);
  assert.equal(params.environments, undefined, `${label}: the agent keeps its environment (shell, patch)`);
  assert.equal(params.ephemeral, undefined, `${label}: and its history`);
  // isolation.ts exactly as before
  assert.equal(params.sandbox, 'read-only', label);
  assert.equal(params.approvalPolicy, 'never', label);
  assert.equal(params.approvalsReviewer, 'user', label);
  assert.deepEqual(params.config.project_root_markers, [], label);
  assert.equal(params.config.project_doc_max_bytes, 0, label);
  assert.deepEqual(params.config.projects['/work'], { trust_level: 'untrusted' }, label);
}

test('agentLeanConfig: the helper\'s features off except the shell, view_image and image_generation; the workspace features off too; blocks off, web search disabled, apps off', () => {
  const config = agentLeanConfig();
  const features = config.features as Record<string, boolean>;
  for (const name of AGENT_FEATURES_KEPT) assert.equal(name in features, false, `${name} kept (not even set to true)`);
  assert.ok(AGENT_FEATURES_KEPT.includes('image_generation'), 'owner 29.10.: agent threads keep Codex image generation (portraits)');
  for (const name of ['computer_use', 'browser_use', 'apps', 'plugins', 'skill_search', 'tool_suggest', 'multi_agent', 'goals', 'memories', 'hooks', 'mentions_v2', 'remote_plugin']) {
    assert.equal(features[name], false, name);
  }
  for (const name of WORKSPACE_FEATURES) assert.equal(features[name], false, `${name}: a session features table never brings it back`);
  assert.ok(Object.values(features).every((value) => value === false), 'nothing is turned on');
  assert.equal(AGENT_FEATURES_OFF.length, Object.keys(features).length);
  assert.ok(HELPER_FEATURES_OFF.every((name) => AGENT_FEATURES_KEPT.includes(name) || features[name] === false), 'every other helper feature is off');
  assert.equal(config.web_search, 'live', "E1: the agent searches with Codex's own live search");
  assert.equal(config.include_environment_context, false);
});

test('agentThread: the lean config never replaces an isolation key; every other setting stays as given', () => {
  const isolation = threadIsolation(['/w'], { GIT_PAGER: 'cat' });
  const settings = { model: 'gpt-test', cwd: '/w', baseInstructions: 'S', developerInstructions: 'V', approvalPolicy: 'on-request', ...isolation };
  const out = agentThread(settings);
  for (const [key, value] of Object.entries(isolation.config)) assert.deepEqual((out.config as any)[key], value, key);
  assert.equal(out.sandbox, 'read-only');
  assert.equal(out.approvalsReviewer, 'user');
  assert.equal(out.developerInstructions, 'V', 'the volatile developer message stays');
  assert.equal(out.baseInstructions, 'S');
  assert.equal('environments' in out, false);
  assert.equal('ephemeral' in out, false);
  assert.deepEqual(settings.config, isolation.config, 'the given settings are not changed');
  // A clash (none today) would keep the isolation's value.
  assert.equal((agentThread({ config: { web_search: 'cached' } }).config as any).web_search, 'cached');
});

test('an agent thread opens lean on thread/start and on thread/resume; its turns keep their own sandbox', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  assert.equal((await e.run(turnInput({ runId: 'run_1' }).input)).stop, 'done');
  assertLeanAgent(fake.sent('thread/start')[0].params, 'thread/start');
  assert.equal(fake.sent('thread/start')[0].params.developerInstructions, 'VOLATILE');
  assert.equal(fake.sent('thread/start')[0].params.dynamicTools.length, 1);
  assert.deepEqual(fake.sent('turn/start')[0].params.sandboxPolicy, { type: 'dangerFullAccess' }, 'an agent turn works on the whole PC');

  assert.equal((await e.run(turnInput({ runId: 'run_2', session: { ref: 'thr_old', generation: 2 } }).input)).stop, 'done');
  assertLeanAgent(fake.sent('thread/resume')[0].params, 'thread/resume');
  assert.equal(fake.sent('thread/resume')[0].params.threadId, 'thr_old');
  assert.equal(fake.sent('thread/start').length + fake.sent('thread/resume').length, 2, 'one request each: nothing refused');
  await e.dispose();
});

test('a Codex that refuses the lean agent settings gets today\'s settings, remembered per server process; start and resume alike', async () => {
  const fake = appServer((msg) => lean(msg.params));
  const e = engineOf(fake.spawn);
  const first = await e.run(turnInput({ runId: 'run_1' }).input);
  assert.equal(first.stop, 'done', 'the turn still runs');
  const starts = () => fake.sent('thread/start');
  assert.equal(starts().length, 2, 'lean refused, then today\'s settings');
  assert.equal(starts()[1].params.config.web_search, undefined);
  assert.equal(starts()[1].params.config.features, undefined);
  assert.equal(starts()[1].params.sandbox, 'read-only', 'the isolation stays');
  assert.equal(starts()[1].params.config.project_doc_max_bytes, 0);

  await e.run(turnInput({ runId: 'run_2', input: [{ type: 'text', text: 'again' }] }).input);
  assert.equal(starts().length, 3, 'the next thread goes straight to today\'s settings');
  assert.equal(lean(starts()[2].params), false);
  assert.equal((await e.run(turnInput({ runId: 'run_3', session: { ref: 'thr_old', generation: 2 } }).input)).stop, 'done');
  assert.equal(fake.sent('thread/resume').length, 1, 'a resume too');
  assert.equal(lean(fake.sent('thread/resume')[0].params), false);
  await e.dispose();
});

test('a resume refused with and without the lean settings is the thread\'s own: rebase, and the server is not marked', async () => {
  const fake = appServer((msg) => msg.method === 'thread/resume');
  const e = engineOf(fake.spawn);
  const result = await e.run(turnInput({ session: { ref: 'thr_gone', generation: 2 } }).input);
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.details?.rebase, true);
  assert.equal(fake.sent('thread/resume').length, 2, 'lean, then today\'s settings');
  await e.run(turnInput({ runId: 'run_2' }).input);
  assert.equal(fake.sent('thread/start').length, 1, 'the next new thread opens lean at once');
  assert.ok(lean(fake.sent('thread/start')[0].params));
  await e.dispose();
});

test('openAgentThread: a timeout or a non-RPC failure never falls back; an accepted lean thread is one request', async () => {
  const refused = new Set<string>();
  const calls: any[] = [];
  const timeout = { request: async (method: string, params: unknown) => { calls.push({ method, params }); throw new RpcError(-32000, 'codex did not answer'); } };
  await assert.rejects(openAgentThread(timeout as any, 'thread/start', { cwd: '/w' }, refused, 'acc'), /did not answer/);
  assert.equal(calls.length, 1);
  assert.equal(refused.size, 0);

  const broken = { request: async () => { throw new Error('closed'); } };
  await assert.rejects(openAgentThread(broken as any, 'thread/start', { cwd: '/w' }, refused, 'acc'), /closed/);
  assert.equal(refused.size, 0);

  const sent: any[] = [];
  const ok = { request: async (method: string, params: any) => { sent.push(params); return { thread: { id: 't' } }; } };
  assert.deepEqual(await openAgentThread(ok as any, 'thread/start', { cwd: '/w' }, refused, 'acc'), { thread: { id: 't' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].config.web_search, 'live');
  refused.add('acc');
  await openAgentThread(ok as any, 'thread/start', { cwd: '/w' }, refused, 'acc');
  assert.deepEqual(sent[1], { cwd: '/w', ...HIDDEN_THREAD }, 'a marked server gets today\'s settings unchanged (B-075: a new thread is stored hidden)');
});
