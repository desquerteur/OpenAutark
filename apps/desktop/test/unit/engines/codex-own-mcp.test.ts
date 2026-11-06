// B-052 M1 (engines/codex/own-mcp.ts): agents' Codex app-server never loads the person's own MCP servers. Every
// configured [mcp_servers.<name>] with a transport is named in ONE inline-table override that merges
// `enabled = false` into it (the form checked with codex-cli 0.164: `mcp_servers={}` changes nothing, and a dotted
// key path splits names at dots); names that are not configured are never named (Codex would refuse the config);
// the home's config.toml is read again at every server start, only for those names.
// Owns: these assertions. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexConfigFile, configuredServers, ownMcpOff, serversOff } from '../../../src/runtime/engines/codex/own-mcp.ts';
import { CodexServer } from '../../../src/runtime/engines/codex/server.ts';
import type { Executable } from '../../../src/runtime/accounts/executables.ts';
import { fakeSpawn, testSupervisor } from './fakes.ts';

const CONFIG = `model = "gpt-5"
[projects.'c:\\work']
trust_level = "trusted"

[mcp_servers]
inline = { command = "node", args = ["server.js"] }

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
[mcp_servers.github.env]
GITHUB_TOKEN = "ghp_secret"

[mcp_servers."dot.srv"]
url = "https://example.invalid/mcp"
bearer_token_env_var = "DOT_TOKEN"

[mcp_servers.half]
enabled = false
`;
const OFF = 'mcp_servers={"inline"={enabled=false},"github"={enabled=false},"dot.srv"={enabled=false}}';

test('own MCP servers: the configured names with a transport, in file order; nothing else of the file', () => {
  assert.deepEqual(configuredServers(CONFIG), ['inline', 'github', 'dot.srv'], 'an entry without command/url is no server Codex loads');
  assert.deepEqual(configuredServers('model = "x"\n'), []);
  assert.deepEqual(configuredServers('mcp_servers = "odd"\n'), []);
  assert.deepEqual(configuredServers('[[[ not toml'), []);
});

test('own MCP servers: one inline-table override, every name quoted (dots, quotes, control characters escaped)', () => {
  assert.equal(serversOff(['github', 'dot.srv']), 'mcp_servers={"github"={enabled=false},"dot.srv"={enabled=false}}');
  assert.equal(serversOff(['a"b\\c\u0001']), 'mcp_servers={"a\\"b\\\\c\\u0001"={enabled=false}}');
  assert.equal(serversOff([]), undefined, 'no server: no override (an unknown name would break the config)');
  const none = serversOff(['github'])!;
  assert.ok(!none.includes('ghp_secret') && !none.includes('npx'), 'nothing but the names');
});

test('own MCP servers: the home of the account, else $CODEX_HOME, else ~/.codex; a missing or unreadable file is no override', async () => {
  assert.equal(codexConfigFile('/homes/acc_1', { CODEX_HOME: '/other' }, '/u'), path.join('/homes/acc_1', 'config.toml'));
  assert.equal(codexConfigFile(undefined, { CODEX_HOME: '/other' }, '/u'), path.join('/other', 'config.toml'));
  assert.equal(codexConfigFile(undefined, {}, '/u'), path.join('/u', '.codex', 'config.toml'));
  const read: string[] = [];
  assert.deepEqual(await ownMcpOff('/homes/acc_1', {}, async (file) => { read.push(file); return CONFIG; }), [OFF]);
  assert.deepEqual(read, [path.join('/homes/acc_1', 'config.toml')]);
  assert.deepEqual(await ownMcpOff('/homes/acc_1', {}, async () => undefined), []);
  assert.deepEqual(await ownMcpOff('/homes/acc_1', {}, async () => { throw new Error('EACCES'); }), []);
});

/** A scripted app-server that answers initialize. */
function appServer() {
  return fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'codex_cli_rs/0.164.0' } });
    };
  });
}

async function startArgs(home: string): Promise<string[]> {
  const fake = appServer();
  const server = new CodexServer({
    key: 'acc_test', home, executable: { command: '/bin/codex', prefixArgs: [], path: '/bin/codex' } as unknown as Executable,
    supervisor: testSupervisor(fake.spawn), cwd: '/data/engine-cwd', version: '0.2.0', env: { PATH: '/bin' },
  });
  try {
    await server.rpc();
    return fake.calls[0].args;
  } finally {
    await server.dispose();
  }
}

test('the app-server starts with the home\'s own MCP servers off, read again at each start', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-home-'));
  try {
    assert.ok(!(await startArgs(home)).some((arg) => arg.startsWith('mcp_servers')), 'no config.toml: no override');
    writeFileSync(path.join(home, 'config.toml'), CONFIG);
    const args = await startArgs(home);
    const at = args.indexOf(OFF);
    assert.ok(at > 0 && args[at - 1] === '-c', args.join(' '));
    assert.ok(args.indexOf('project_root_markers=[]') < at, 'after the server-wide isolation config');
    assert.ok(!args.join(' ').includes('ghp_secret'), 'no value of the file reaches the command line');
    writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.only]\ncommand = "x"\n');
    assert.ok((await startArgs(home)).includes('mcp_servers={"only"={enabled=false}}'), 'the next start reads the file again');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A scripted app-server that refuses (exits at once) whenever it is started with an mcp_servers override. */
function refusingServer(refuseAlways = false) {
  return fakeSpawn(({ args, child }) => {
    const override = args.some((arg) => arg.startsWith('mcp_servers='));
    if (refuseAlways || override) { setImmediate(() => child.exit(1)); return; }
    child.onLine = (msg) => {
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'codex_cli_rs/0.164.0' } });
    };
  });
}

function codexServer(home: string, fake: ReturnType<typeof fakeSpawn>, warnings: string[]): CodexServer {
  return new CodexServer({
    key: 'acc_test', home, executable: { command: '/bin/codex', prefixArgs: [], path: '/bin/codex' } as unknown as Executable,
    supervisor: testSupervisor(fake.spawn), cwd: '/data/engine-cwd', version: '0.2.0', env: { PATH: '/bin' },
    log: { warn: (message) => { warnings.push(message); } },
  });
}

const hasOverride = (args: string[]) => args.some((arg) => arg.startsWith('mcp_servers='));

test('Codex never breaks over the override: a refused start runs once more without it, remembered until config.toml changes', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-home-'));
  try {
    writeFileSync(path.join(home, 'config.toml'), CONFIG);
    const fake = refusingServer();
    const warnings: string[] = [];
    const first = codexServer(home, fake, warnings);
    await first.rpc();
    assert.equal(fake.calls.length, 2, 'once with the override, once without');
    assert.ok(hasOverride(fake.calls[0].args) && !hasOverride(fake.calls[1].args));
    assert.equal(warnings.length, 1, 'one short note');
    assert.ok(!warnings[0].includes('github') && !warnings[0].includes('ghp_secret'), 'no server name or value in the note');
    await first.dispose();

    const again = codexServer(home, fake, warnings);
    await again.rpc();
    assert.equal(fake.calls.length, 3, 'the same file: started without the override at once');
    assert.ok(!hasOverride(fake.calls[2].args));
    await again.dispose();

    writeFileSync(path.join(home, 'config.toml'), `${CONFIG}\n# edited\n`);
    const changed = codexServer(home, fake, warnings);
    await changed.rpc();
    assert.equal(fake.calls.length, 5, 'a changed file: the override is tried again (and refused again)');
    assert.ok(hasOverride(fake.calls[3].args) && !hasOverride(fake.calls[4].args));
    await changed.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Codex override fallback: when the start without it fails too, the first error stands and nothing is remembered', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-home-'));
  try {
    writeFileSync(path.join(home, 'config.toml'), CONFIG);
    const broken = refusingServer(true);
    const warnings: string[] = [];
    const server = codexServer(home, broken, warnings);
    await assert.rejects(server.rpc(), /codex connection closed/);
    assert.equal(broken.calls.length, 2);
    assert.deepEqual(warnings, [], 'not the override\'s fault: no note');
    await server.dispose();
    const fine = appServer();
    const next = codexServer(home, fine, warnings);
    await next.rpc();
    assert.ok(hasOverride(fine.calls[0].args), 'the next start still turns the servers off');
    await next.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a running app-server restarts between turns when config.toml\'s server names change, never during a turn', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-home-'));
  try {
    writeFileSync(path.join(home, 'config.toml'), CONFIG);
    const fake = appServer();
    const server = codexServer(home, fake, []);
    const first = await server.rpc();
    assert.equal(await server.rpc(), first, 'nothing changed: the same process');
    writeFileSync(path.join(home, 'config.toml'), `${CONFIG}\n[projects.'d:\\other']\ntrust_level = "trusted"\n`);
    assert.equal(await server.rpc(), first, 'an edit that keeps the server names: no restart');
    const end = server.beginTurn();
    writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.only]\ncommand = "x"\n');
    assert.equal(await server.rpc(), first, 'a turn runs: never cut');
    end();
    const fresh = await server.rpc();
    assert.notEqual(fresh, first, 'between turns: restarted');
    assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls[1].args.includes('mcp_servers={"only"={enabled=false}}'), 'with the names config.toml has now');
    await server.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
