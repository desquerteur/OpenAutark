// Codex takes no settings from the workspace (agents can write there): a thread opens read-only
// (so app-server's "writable sandbox trusts the cwd" never fires) with the cwd marked untrusted in
// its session config under every spelling and as the project root (no parent layers), no AGENTS.md
// as project instructions and the safe git env (I02) in every agent shell – on
// thread/start and on thread/resume after a restart; each agent turn runs with full access and no approvals
// (approvalPolicy 'never'); a tool-less helper run (decisions), a turn in the server's own folder and a reviewer
// agent's turn (X10 readOnly) read only; the server runs in the empty engine folder (registry: never temp) with
// the account's CODEX_HOME, no widening flag, the workspace-acting features (skill MCP installs, config imports)
// off and no parent project layers.
// Owns: nothing in production. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { SERVER_CONFIG, WORKSPACE_FEATURES, foldersOverlap, threadIsolation, trustKeys, turnAccess, turnPermissions } from '../../../src/runtime/engines/codex/isolation.ts';
import { agentLeanConfig } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { createEngineRegistry } from '../../../src/runtime/engines/registry.ts';
import { engineCwd } from '../../../src/runtime/system/paths.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, tick, turnInput } from './fakes.ts';

const WORKSPACE = '/fake-home/Workforce';
const REAL = '/real/Workforce';
const NEUTRAL = '/data/engine-cwd';
const TEMP = '/data/tmp'; // where runtime helper turns (decisions, compaction) work

/** A scripted app-server that records requests and completes every turn at once. */
function appServer() {
  const requests: any[] = [];
  const fake = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.id !== undefined && !msg.method) return;
      if (msg.method) requests.push(msg);
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
      else if (msg.method === 'thread/resume') child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'completed' } } });
      } else if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
  return { ...fake, requests, sent: (method: string) => requests.filter((r) => r.method === method) };
}

function engine(spawn: any, realpaths: string[] = []) {
  return new CodexEngine({
    supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: NEUTRAL, version: '0.2.0',
    env: { PATH: '/bin', CODEX_HOME: '/someone/else/.codex' },
    realpath: async (dir) => { realpaths.push(dir); return REAL; },
  });
}

/** Every spelling of the cwd (as given, resolved, real) is untrusted, and nothing is trusted. */
function assertUntrusted(params: any, label: string): void {
  assert.equal(params.cwd, WORKSPACE, `${label}: the thread still works in the workspace`);
  assert.equal(params.sandbox, 'read-only', `${label}: no writable sandbox on open (the auto-trust trigger)`);
  assert.equal(params.approvalPolicy, 'never', label);
  assert.equal(params.approvalsReviewer, 'user', `${label}: never Codex's auto-reviewer`);
  assert.equal(params.permissions, undefined, `${label}: no named permission profile`);
  const projects = params.config?.projects ?? {};
  const lower = process.platform === 'win32' ? [path.resolve(WORKSPACE).toLowerCase()] : []; // Codex's saved form on Windows
  for (const key of [WORKSPACE, path.resolve(WORKSPACE), REAL, ...lower]) assert.deepEqual(projects[key], { trust_level: 'untrusted' }, `${label}: ${key}`);
  assert.ok(Object.values(projects).every((p: any) => p.trust_level === 'untrusted'), `${label}: only untrusted marks`);
  assert.deepEqual(params.config.project_root_markers, [], `${label}: the cwd is the project root (no parent .codex/ layers)`);
  assert.equal(params.config.project_doc_max_bytes, 0, `${label}: no AGENTS.md of the workspace becomes project instructions`);
  // B-049 F1: beside the isolation only the lean agent config (helper-thread.ts), never replacing an isolation key.
  const lean = agentLeanConfig();
  assert.deepEqual(Object.keys(params.config).sort(), ['project_doc_max_bytes', 'project_root_markers', 'projects', 'shell_environment_policy', ...Object.keys(lean)].sort(), `${label}: no other session override`);
  for (const [key, value] of Object.entries(lean)) assert.deepEqual(params.config[key], value, `${label}: lean ${key}`);
  assert.deepEqual(Object.keys(params.config.shell_environment_policy), ['set'], `${label}: only the variables to set (never ignore_default_excludes)`);
}

function assertTurn(params: any, label: string, sandboxPolicy: unknown = { type: 'dangerFullAccess' }): void {
  assert.deepEqual(params.sandboxPolicy, sandboxPolicy, label);
  assert.equal(params.approvalPolicy, 'never', label);
  assert.equal(params.approvalsReviewer, 'user', label);
  assert.equal(params.cwd, undefined, `${label}: the turn does not move the thread to another folder`);
}

test('codex isolation: thread/start opens read-only with the workspace untrusted; the turn runs with full access', async () => {
  const fake = appServer();
  const realpaths: string[] = [];
  const e = engine(fake.spawn, realpaths);
  const result = await e.run(turnInput({ cwd: WORKSPACE, account: account({ home: '/data/accounts/codex/acc_test' }) }).input);
  assert.equal(result.stop, 'done');
  assert.deepEqual(realpaths, [WORKSPACE]);
  assertUntrusted(fake.sent('thread/start')[0].params, 'thread/start');
  assertTurn(fake.sent('turn/start')[0].params, 'turn/start');

  const [spawn] = fake.calls;
  assert.equal(spawn.options.cwd, NEUTRAL, 'the server process never starts in the workspace');
  assert.equal(spawn.options.env?.CODEX_HOME, '/data/accounts/codex/acc_test', 'the account home replaces the parent env value');
  const args = spawn.args;
  for (const name of ['computer_use', 'browser_use', ...WORKSPACE_FEATURES]) {
    const at = args.indexOf(`features.${name}=false`);
    assert.ok(at > 0 && args[at - 1] === '-c', `features.${name} off`);
  }
  assert.deepEqual(SERVER_CONFIG, ['project_root_markers=[]']);
  const markers = args.indexOf('project_root_markers=[]');
  assert.ok(markers > 0 && args[markers - 1] === '-c', 'the server takes no .codex/ layer from a parent of its folder');
  for (const flag of ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--approve-for-me', '--add-dir', '-C', '--cd', '-p', '--profile', '--enable', '-s', '--sandbox', '-a']) {
    assert.ok(!args.includes(flag), `no ${flag}`);
  }
  assert.ok(!args.some((arg) => /^(projects|sandbox|approval|mcp_servers|hooks)/.test(arg)), 'no server-wide override that trusts or widens anything');
  await e.dispose();
});

test('codex isolation: a resumed thread is marked the same way and every turn re-sends its sandbox', async () => {
  const fake = appServer();
  const e = engine(fake.spawn);
  const first = await e.run(turnInput({ cwd: WORKSPACE, session: { ref: 'thr_9', generation: 2 } }).input);
  assert.equal(first.stop, 'done');
  assert.equal(fake.sent('thread/start').length, 0);
  assertUntrusted(fake.sent('thread/resume')[0].params, 'thread/resume');
  await e.run(turnInput({ cwd: WORKSPACE, session: { ref: 'thr_9', generation: 2 } }).input);
  assert.equal(fake.sent('thread/resume').length, 1, 'the loaded thread is reused');
  for (const [i, turn] of fake.sent('turn/start').entries()) assertTurn(turn.params, `turn ${i + 1}`);
  await e.dispose();
});

test('codex isolation: a failing realpath leaves the given and resolved spellings', async () => {
  const fake = appServer();
  const e = new CodexEngine({
    supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: NEUTRAL, version: '0.2.0',
    realpath: async () => { throw new Error('ENOENT'); },
  });
  assert.equal((await e.run(turnInput({ cwd: WORKSPACE }).input)).stop, 'done');
  const projects = fake.sent('thread/start')[0].params.config.projects;
  assert.deepEqual(Object.keys(projects).sort(), trustKeys(WORKSPACE).sort());
  assert.ok(!(REAL in projects));
  await e.dispose();
});

test('codex isolation: trustKeys covers the all-lower-case form Codex saves on Windows, drive-letter case and trailing separators; helpers build the documented shapes', () => {
  const keys = trustKeys('C:\\Users\\Ann\\Workforce\\', 'c:\\Users\\ann\\Workforce', 'win32');
  for (const key of ['C:\\Users\\Ann\\Workforce', 'c:\\users\\ann\\workforce', 'c:\\Users\\Ann\\Workforce', 'c:\\Users\\ann\\Workforce', 'C:\\Users\\ann\\Workforce']) assert.ok(keys.includes(key), key);
  assert.ok(!keys.some((key) => /[\\/]$/.test(key)), 'no trailing separator');
  assert.deepEqual(trustKeys('C:\\', undefined, 'win32').filter((key) => /^[a-z]:\\$/i.test(key)).sort(), ['C:\\', 'c:\\'], 'a drive root keeps its separator');
  assert.deepEqual(trustKeys('/srv/Ws/', '/srv/Ws', 'linux'), ['/srv/Ws'], 'case-sensitive elsewhere: no lower-case form');
  assert.deepEqual(threadIsolation(['/a']), { sandbox: 'read-only', approvalsReviewer: 'user', config: { projects: { '/a': { trust_level: 'untrusted' } }, project_root_markers: [], project_doc_max_bytes: 0, shell_environment_policy: { set: {} } } });
  assert.deepEqual(threadIsolation(['/a'], { GIT_PAGER: 'cat' }).config.shell_environment_policy, { set: { GIT_PAGER: 'cat' } });
  assert.deepEqual(turnPermissions(), { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } });
  assert.deepEqual(turnPermissions('read'), { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
});

test('codex isolation: a tool-less helper run (decisions, compaction) reads only, so it plants nothing in the folder it runs in', async () => {
  const fake = appServer();
  const e = engine(fake.spawn);
  // decision/engine-runner: no Workforce tools, no MCP hub, cwd = temp.
  const helper = turnInput({ cwd: TEMP, tools: [], outputSchema: { type: 'object' } }).input;
  assert.equal((await e.run(helper)).stop, 'done');
  const start = fake.sent('thread/start')[0].params;
  assert.equal(start.cwd, TEMP);
  assert.equal(start.sandbox, 'read-only');
  assert.deepEqual(start.config.projects[TEMP], { trust_level: 'untrusted' });
  assertTurn(fake.sent('turn/start')[0].params, 'helper turn', { type: 'readOnly', networkAccess: false });
  // An agent turn with only the MCP hub (no dynamic tools) still writes its workspace.
  assert.equal((await e.run(turnInput({ runId: 'run_2', cwd: WORKSPACE, tools: [], mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' } }).input)).stop, 'done');
  assertTurn(fake.sent('turn/start')[1].params, 'mcp-only agent turn');
  // A turn in the server's own folder never writes there.
  assert.equal((await e.run(turnInput({ runId: 'run_3', cwd: NEUTRAL }).input)).stop, 'done');
  assertTurn(fake.sent('turn/start')[2].params, 'turn in the server folder', { type: 'readOnly', networkAccess: false });
  await e.dispose();
});

test('codex isolation: turnAccess and foldersOverlap', () => {
  const tool = [{ name: 'tasks.create', description: '', inputSchema: {} }] as any;
  assert.equal(turnAccess({ tools: tool, cwd: '/ws' }, '/data/engine-cwd', 'linux'), 'full');
  assert.equal(turnAccess({ tools: [], cwd: '/ws' }, '/data/engine-cwd', 'linux'), 'read');
  assert.equal(turnAccess({ tools: [], mcp: { url: 'u', token: 't' }, cwd: '/ws' }, '/data/engine-cwd', 'linux'), 'full');
  assert.equal(turnAccess({ tools: tool, cwd: '/data' }, '/data/engine-cwd', 'linux'), 'read', 'a cwd around the server folder could write into it');
  assert.equal(turnAccess({ tools: tool, cwd: '/data/engine-cwd/sub' }, '/data/engine-cwd', 'linux'), 'read');
  assert.ok(foldersOverlap('C:\\Data\\Engine-Cwd\\', 'c:\\data\\engine-cwd', 'win32'), 'case and trailing separator do not matter on Windows');
  assert.ok(!foldersOverlap('C:\\Users\\Ann\\Workforce', 'C:\\Users\\Ann\\AppData\\Workforce\\engine-cwd', 'win32'));
  assert.ok(!foldersOverlap('/data/engine-cwd2', '/data/engine-cwd', 'linux'), 'a sibling with the same prefix is apart');
  assert.ok(!foldersOverlap('/Data/x', '/data/x', 'linux'), 'case-sensitive elsewhere');
});

test('codex isolation: the registry starts the app-server in the empty engine folder, not in temp where helper turns work', async () => {
  const fake = appServer();
  const paths = { temp: TEMP, data: '/data' };
  const registry = createEngineRegistry({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), paths, version: '1', apiKey: async () => undefined });
  assert.equal((await registry.get('codex').run(turnInput({ cwd: TEMP, tools: [] }).input)).stop, 'done');
  assert.equal(fake.calls[0].options.cwd, engineCwd(paths));
  assert.notEqual(fake.calls[0].options.cwd, TEMP);
  assert.equal(fake.sent('turn/start')[0].params.sandboxPolicy.type, 'readOnly');
  await registry.dispose();
});


test('codex isolation: a reviewer agent\'s turn (X10 readOnly) reads only, also with tools in its own workspace', async () => {
  const tool = [{ name: 'files.read', description: '', inputSchema: {} }] as any;
  assert.equal(turnAccess({ tools: tool, cwd: WORKSPACE, readOnly: true }, NEUTRAL), 'read');
  assert.equal(turnAccess({ tools: [], mcp: { url: 'u', token: 't' }, cwd: WORKSPACE, readOnly: true }, NEUTRAL), 'read');
  const fake = appServer();
  const e = engine(fake.spawn);
  assert.equal((await e.run({ ...turnInput({ cwd: WORKSPACE }).input, readOnly: true })).stop, 'done');
  assertTurn(fake.sent('turn/start')[0].params, 'reviewer turn', { type: 'readOnly', networkAccess: false });
  await e.dispose();
});

