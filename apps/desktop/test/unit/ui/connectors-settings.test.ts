// AF-005 Settings › Connectors: what the page hands on – the pasted JSON of Claude Desktop / Claude Code (valid and invalid,
// with errors that name the entry and the key), the own-server form (stdio: command, arguments, variables; HTTP: address,
// token, headers), the catalog's local servers (Google, Slack, Discord) – each turned into mcp.json entries the runtime reads,
// with every key as a secret:// handle and no value in the file – and switching an entry off and on and limiting its agents.
// Owns: these assertions. Never: a real window, runtime or file watcher.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readConnectors } from '../../../src/runtime/apps/connectors.ts';
import { APP_CATALOG, catalogConnected, catalogEntry } from '../../../src/ui/settings/apps-catalog.ts';
import { agentsPatch, agentsWord, appLine, namedAgents, patchedEntry, switchPatch, withEntries } from '../../../src/ui/settings/apps-files.ts';
import { NO_SERVER, serverDraft, splitArgs } from '../../../src/ui/settings/apps-server-entry.ts';
import { checkImport, importSummary, MAX_IMPORT, nameForServer, withHandles, type ImportedServer } from '../../../src/ui/settings/mcp-import.ts';
import { sectionById, searchSections } from '../../../src/ui/settings/sections.ts';
import { settingsPage } from '../../../src/ui/lib/router.ts';

/** What the runtime makes of this mcp.json text. */
function read(mcp: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'connectors-'));
  try {
    mkdirSync(path.join(dir, 'connectors'));
    writeFileSync(path.join(dir, 'connectors', 'mcp.json'), mcp);
    return readConnectors(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** saveServers without the RPC: each move gets the id "sec_<n>" (what secrets.save would answer). */
function written(servers: readonly ImportedServer[], start = ''): { text: string; names: string[] } {
  let n = 0;
  const ready = servers.map((server) => {
    const ids = new Map(server.moves.map((move) => [`${move.where}.${move.key}`, `sec_${++n}`]));
    return { name: server.name, entry: withHandles(server, ids) };
  });
  return withEntries('mcp.json', start, ready);
}

const CLAUDE_DESKTOP = JSON.stringify({
  mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_0123456789abcdefghij', NODE_ENV: 'production' } },
    files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/Docs'] },
  },
  globalShortcut: 'Ctrl+Space',
}, null, 2);

test('import: a Claude Desktop config – stdio servers, the token moves into Secrets, a plain setting stays', () => {
  const check = checkImport(CLAUDE_DESKTOP);
  assert.deepEqual(check.errors, []);
  assert.deepEqual(check.servers.map((server) => [server.name, server.kind]), [['github', 'stdio'], ['files', 'stdio']]);
  assert.deepEqual(check.servers[0].moves.map((move) => move.key), ['GITHUB_PERSONAL_ACCESS_TOKEN'], 'NODE_ENV is a plain setting');
  assert.deepEqual(importSummary(check), ['github: runs npx · GITHUB_PERSONAL_ACCESS_TOKEN into Secrets', 'files: runs npx']);

  const { text, names } = written(check.servers, JSON.stringify({ mcpServers: { github: { url: 'https://api.githubcopilot.com/mcp/' } } }));
  assert.deepEqual(names, ['github 2', 'files'], 'a taken name is never replaced');
  assert.doesNotMatch(text, /ghp_0123456789/, 'no token in the file');
  const { connectors, problems } = read(text);
  assert.deepEqual(problems, []);
  const imported = connectors.find((c) => c.name === 'github 2');
  assert.deepEqual(imported?.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret://sec_1', NODE_ENV: 'production' });
  assert.deepEqual(imported?.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.equal(connectors.find((c) => c.name === 'files')?.transport, 'stdio');
});

test('import: Claude Code (.mcp.json) – http with a Bearer header, sse with a note, "type" and "serverUrl" read', () => {
  const check = checkImport(JSON.stringify({
    mcpServers: {
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer lin_api_secretvalue123', 'X-Team': 'core' } },
      legacy: { type: 'sse', url: 'https://example.com/sse' },
      local: { type: 'stdio', command: 'node', args: ['server.js'], env: { API_KEY: '${MY_KEY}' } },
      cursor: { serverUrl: 'http://localhost:3000/mcp' },
    },
  }));
  assert.deepEqual(check.errors, []);
  const linear = check.servers[0];
  assert.deepEqual(linear.moves, [{ where: 'headers', key: 'Authorization', value: 'lin_api_secretvalue123', scheme: 'Bearer ' }]);
  assert.match(check.servers[1].notes.join(' '), /SSE address/);
  assert.match(check.servers[2].notes.join(' '), /\$\{MY_KEY\} stays as written/);
  assert.deepEqual(check.servers[2].moves, [], 'a variable is no value to move');
  const { text } = written(check.servers);
  const { connectors, problems } = read(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(connectors.map((c) => [c.name, c.transport]), [['linear', 'http'], ['legacy', 'http'], ['local', 'stdio'], ['cursor', 'http']]);
  assert.deepEqual(connectors[0].headers, { Authorization: 'Bearer secret://sec_1', 'X-Team': 'core' });
  assert.equal(connectors[3].url, 'http://localhost:3000/mcp');
  assert.doesNotMatch(text, /"type"|serverUrl|lin_api_secretvalue123/);
});

test('import: one server without a name, a bare map and VS Code "servers" are found too', () => {
  assert.deepEqual(checkImport('{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"]}').servers.map((s) => s.name), ['postgres']);
  assert.deepEqual(checkImport('{"a": {"url": "https://a.example/mcp"}, "b": {"command": "uvx", "args": ["mcp-server-git"]}}').servers.map((s) => s.name), ['a', 'b']);
  assert.deepEqual(checkImport('{"servers": {"x": {"url": "https://x.example/mcp"}}}').servers.map((s) => s.name), ['x']);
  assert.equal(nameForServer({ command: 'npx', args: ['-y', 'slack-mcp-server@latest', '--transport', 'stdio'] }), 'slack');
  assert.equal(nameForServer({ url: 'https://mcp.notion.com/mcp' }), 'notion');
});

test('import: invalid input gets one clear error per problem, naming the entry and the key; nothing goes in', () => {
  const errors = (text: string) => checkImport(text).errors;
  assert.deepEqual(errors('   '), ['Paste the JSON of one or more MCP servers.']);
  assert.match(errors('{"mcpServers": {"a": {"command": "npx",}}}')[0], /^Not valid JSON: .*line 1/);
  assert.match(errors('{\n  "mcpServers": {\n    "a": {"command": "npx"\n  }\n}')[0], /^Not valid JSON: .*line \d+/);
  assert.deepEqual(errors('[1, 2]'), ['The JSON must be an object: {"mcpServers": {…}}.']);
  assert.deepEqual(errors('{"mcpServers": []}'), ['"mcpServers" must be an object of servers by name.']);
  assert.deepEqual(errors('{"mcpServers": {}}'), ['There is no server in it yet.']);
  assert.match(errors('{"name": "x", "version": 2}')[0], /^No servers found/);
  const many = Object.fromEntries(Array.from({ length: MAX_IMPORT + 1 }, (_, i) => [`s${i}`, { url: 'https://a.example/mcp' }]));
  assert.match(errors(JSON.stringify({ mcpServers: many }))[0], /at most at a time/);

  const check = checkImport(JSON.stringify({
    mcpServers: {
      none: { args: ['x'] },
      badArgs: { command: 'npx', args: ['-y', 3] },
      badEnv: { command: 'npx', env: { TOKEN: 42 } },
      badName: { command: 'npx', env: { 'MY-KEY': 'x' } },
      ftp: { url: 'ftp://files.example.com' },
      plain: { url: 'http://example.com/mcp' },
      weird: { type: 'websocket', url: 'https://a.example/mcp' },
      text: 'npx -y something',
      ok: { command: 'npx' },
    },
  }));
  assert.deepEqual(check.servers, [], 'nothing goes in while anything is wrong');
  assert.deepEqual(check.errors, [
    '"none": needs "command" (a program on this PC) or "url" (a web address).',
    '"badArgs": "args" must be a list of texts, like ["-y", "<package>"].',
    '"badEnv": "env.TOKEN" must be text (put it in quotes).',
    '"badName": "MY-KEY" is no environment variable name (letters, digits and _).',
    '"ftp": "url" must be a web address that starts with https://.',
    '"plain": "url" must start with https:// (http:// only for this PC, like http://localhost:3000/mcp).',
    '"weird": "type" must be "stdio", "http" or "sse".',
    '"text": must be an object like {"command": "npx", "args": ["-y", "<package>"]}.',
  ]);
});

test('own server, stdio: command line, more arguments, folder and every variable as a handle', () => {
  const rows = [{ id: '1', name: 'API_TOKEN', value: 'tok_123' }, { id: '2', name: 'DEBUG', value: '1' }, { id: '3', name: 'DB', value: 'secret://db_url' }, { id: '4', name: '', value: '' }];
  const { blocked, server } = serverDraft({ ...NO_SERVER, kind: 'command', address: 'npx -y "my server"', args: '--read-only "C:/My files"', cwd: 'C:/work', rows });
  assert.equal(blocked, '');
  assert.ok(server);
  assert.deepEqual(server.entry.args, ['-y', 'my server', '--read-only', 'C:/My files']);
  assert.deepEqual(server.moves.map((move) => move.key), ['API_TOKEN', 'DEBUG'], 'every typed value goes into Secrets; a handle stays');
  const { text } = written([server]);
  assert.doesNotMatch(text, /tok_123/);
  const [connector] = read(text).connectors;
  assert.deepEqual([connector.name, connector.transport, connector.command, connector.cwd], ['my server', 'stdio', 'npx', 'C:/work']);
  assert.deepEqual(connector.env, { API_TOKEN: 'secret://sec_1', DEBUG: 'secret://sec_2', DB: 'secret://db_url' });
  assert.deepEqual(splitArgs(' a  "b c" '), ['a', 'b c']);
});

test('own server, HTTP: address, token as Bearer, headers as handles; and what blocks it', () => {
  const rows = [{ id: '1', name: 'X-Api-Key', value: 'k_1' }];
  const { server } = serverDraft({ ...NO_SERVER, address: 'https://tools.example.com/mcp', name: 'Tools', token: 'Bearer abc', rows });
  assert.ok(server);
  const [connector] = read(written([server]).text).connectors;
  assert.deepEqual([connector.name, connector.url], ['Tools', 'https://tools.example.com/mcp']);
  assert.deepEqual(connector.headers, { 'X-Api-Key': 'secret://sec_1', Authorization: 'Bearer secret://sec_2' });
  assert.equal(serverDraft({ ...NO_SERVER, address: 'http://localhost:8080/mcp' }).blocked, '', 'http on this PC is fine');

  const blocked = (fields: Partial<typeof NO_SERVER>) => serverDraft({ ...NO_SERVER, ...fields }).blocked;
  assert.match(blocked({}), /Enter the MCP address/);
  assert.match(blocked({ kind: 'command' }), /Enter the command/);
  assert.match(blocked({ address: 'ftp://x' }), /starts with https/);
  assert.match(blocked({ address: 'http://example.com/mcp' }), /only for a server on this PC/);
  assert.match(blocked({ kind: 'command', address: 'npx', rows: [{ id: '1', name: 'MY-VAR', value: 'x' }] }), /no variable name/);
  assert.match(blocked({ kind: 'command', address: 'npx', rows: [{ id: '1', name: 'A', value: '' }] }), /Enter a value for A/);
  assert.match(blocked({ kind: 'command', address: 'npx', rows: [{ id: '1', name: '', value: 'x' }] }), /Give every variable a name/);
  assert.match(blocked({ kind: 'command', address: 'npx', rows: [{ id: '1', name: 'A', value: '1' }, { id: '2', name: 'a', value: '2' }] }), /twice/);
  assert.match(blocked({ address: 'https://a.example/mcp', token: 't', rows: [{ id: '1', name: 'authorization', value: 'x' }] }), /Either the token/);
});

test('catalog: GitHub, Google, Notion, Slack and Discord connect with one click; local ones get their keys as handles', () => {
  const byName = new Map(APP_CATALOG.map((entry) => [entry.name, entry]));
  for (const name of ['GitHub', 'Google', 'Notion', 'Slack', 'Discord']) assert.ok(byName.has(name), name);
  assert.equal(byName.get('GitHub')?.auth, 'token');
  assert.ok(byName.get('GitHub')?.tokenHint?.createUrl.startsWith('https://github.com/'));
  for (const entry of APP_CATALOG) {
    assert.ok(entry.url || entry.command, `${entry.name} has an address or a command`);
    if (entry.auth === 'keys') assert.ok(entry.keys?.length && entry.tokenHint, `${entry.name} names its keys and where they come from`);
  }
  const google = byName.get('Google')!;
  const entry = catalogEntry(google, { GOOGLE_OAUTH_CLIENT_ID: 'secret://sec_1', GOOGLE_OAUTH_CLIENT_SECRET: 'secret://sec_2' });
  const text = withEntries('mcp.json', '', [{ name: 'Google', entry }]).text;
  const [connector] = read(text).connectors;
  assert.deepEqual([connector.transport, connector.command, connector.args], ['stdio', 'uvx', ['workspace-mcp', '--tools', 'gmail', 'calendar', 'drive']]);
  assert.equal(connector.env?.GOOGLE_OAUTH_CLIENT_SECRET, 'secret://sec_2');
  assert.deepEqual(catalogEntry(byName.get('Notion')!), { url: 'https://mcp.notion.com/mcp' });
  assert.equal(catalogConnected(byName.get('Slack')!, [], ['Slack 2']), true, 'a local one by its name');
  assert.equal(catalogConnected(byName.get('Slack')!, ['npx'], ['Slacker']), false);
  assert.equal(catalogConnected(byName.get('Notion')!, ['mcp.notion.com']), true);
});

test('per connector: off, on and the agents list – each one edit of the entry the runtime reads', () => {
  const start = withEntries('mcp.json', '', [{ name: 'crm', entry: { url: 'https://crm.example/mcp' } }]).text;
  const limited = patchedEntry('mcp.json', start, 'crm', agentsPatch(['agt_anna']));
  const off = patchedEntry('mcp.json', limited, 'crm', switchPatch(false));
  assert.deepEqual([read(off).connectors[0].enabled, read(off).connectors[0].agents], [false, ['agt_anna']]);
  const on = patchedEntry('mcp.json', off, 'crm', switchPatch(true));
  assert.deepEqual([read(on).connectors[0].enabled, read(on).connectors[0].agents], [true, ['agt_anna']], 'the list stays when switched');
  const everyone = patchedEntry('mcp.json', on, 'crm', agentsPatch(undefined));
  assert.equal(read(everyone).connectors[0].agents, undefined);
  assert.doesNotMatch(everyone, /"agents"/, 'every agent: the key goes');
  assert.deepEqual(read(patchedEntry('mcp.json', on, 'crm', agentsPatch([]))).connectors[0].agents, []);
  assert.deepEqual([agentsWord(undefined), agentsWord([]), agentsWord(['a']), agentsWord(['a', 'b'])], ['', 'no agent', '1 agent', '2 agents']);
  assert.equal(appLine({ address: 'crm.example', status: 'ok', tools: 2, agents: ['a'] }), 'crm.example · Connected · 2 tools · 1 agent');
  const team = [{ id: 'agt_anna', name: 'Anna' }, { id: 'agt_ben', name: 'Ben' }];
  assert.deepEqual([...namedAgents(['agt_anna', 'BEN'], team)].sort(), ['agt_anna', 'agt_ben'], 'ids and names are ticked');
});

test('the page: named Connectors, found by its words, reached by older names', () => {
  const page = sectionById('apps');
  assert.equal(page.title, 'Connectors');
  assert.equal(page.tour, 'connectors');
  for (const words of ['connectors', 'google drive', 'paste json', 'claude desktop', 'discord']) assert.ok(searchSections(words).some((section) => section.id === 'apps'), words);
  assert.equal(settingsPage('connectors'), 'apps');
  assert.equal(settingsPage('mcp'), 'apps');
});
