// Connectors as files: the service applies <data>/connectors/mcp.json and mail.json – connect, list and register the
// tools, write status.json –, follows changes of the files (added, changed, disabled, removed), fills secret://<id>
// handles from the vault, starts the browser sign-in only for an entry that was just added or changed (or on
// apps.reconnect), registers cached tools at start without a connection, and moves the old kv records into the files.
// Owns: these assertions. Never: a real server or network (connect, OAuth and the vault are fakes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConnectors, migrateRecords, slug } from '../../../src/runtime/apps/connectors.ts';
import { McpAuthRequired } from '../../../src/runtime/apps/types.ts';
import { appsFixture, dataFolder, FakeKv } from './service-fakes.ts';

const settle = async (f: ReturnType<typeof appsFixture>) => { await f.apps.idle(); f.timers.fireAll(); await f.apps.idle(); };

test('files: mcp.json servers (http and stdio) and mail.json mailboxes become connectors; problems are named', () => {
  const data = dataFolder();
  data.write('mcp.json', { mcpServers: { Notion: { url: 'https://mcp.notion.com/mcp' }, files: { command: 'npx', args: ['-y', 'x'], env: { KEY: 'secret://k' } }, off: { url: 'https://a.example/mcp', disabled: true }, broken: { nothing: true } } });
  data.write('mail.json', { mailboxes: { work: { address: 'me@example.com', password: 'secret://mail', agent: 'Secretary' }, bad: { address: 'x' } } });
  const { connectors, problems } = readConnectors(data.dir);
  assert.deepEqual(connectors.map((c) => [c.id, c.transport, c.enabled]), [['notion', 'http', true], ['files', 'stdio', true], ['off', 'http', false], ['work', 'mail', true]]);
  assert.equal(connectors[1].env?.KEY, 'secret://k');
  assert.equal(connectors[3].mail?.agent, 'Secretary');
  assert.equal(problems.length, 2);
  assert.equal(slug('My GitHub!'), 'my-github');
  data.write('mcp.json', '{ not json');
  assert.match(readConnectors(data.dir).problems[0], /^mcp\.json:/);
});

test('start: creates the files, connects an entry, registers its tools for every agent and writes status.json', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } });
  f.servers.add('https://mcp.linear.app/mcp', ['list_issues', 'create_issue']);
  f.apps.start();
  await settle(f);
  assert.ok(f.data.exists('mail.json'));
  assert.deepEqual(f.tools.names(), ['app.linear.create_issue', 'app.linear.list_issues']);
  assert.deepEqual(f.apps.usableBy('anyone'), ['linear']);
  const status = f.data.read('status.json') as { connectors: Record<string, { status: string; tools: number }> };
  assert.equal(status.connectors.linear.status, 'ok');
  assert.equal(status.connectors.linear.tools, 2);
  await f.apps.stop();
});

test('a key: the secret://<id> handle in a header is filled from the vault when it connects; a bare token gets Bearer', async () => {
  const f = appsFixture();
  const saved = await f.secrets.save({ label: 'GitHub', kind: 'token', value: 'ghp_123' });
  f.data.write('mcp.json', { mcpServers: { github: { url: 'https://api.example.com/mcp', headers: { Authorization: `secret://${saved.id}` } } } });
  const server = f.servers.add('https://api.example.com/mcp', ['repos'], { requires: { header: 'Authorization', value: 'Bearer ghp_123' } });
  f.apps.start();
  await settle(f);
  assert.equal(server.seen?.Authorization, 'Bearer ghp_123');
  assert.equal(f.apps.list()[0].status, 'ok');
  await f.apps.stop();
});

test('changes of the files: added, disabled and removed entries; a removed one loses its sign-in and tools', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { a: { url: 'https://a.example/mcp' } } });
  f.servers.add('https://a.example/mcp', ['one']);
  f.servers.add('https://b.example/mcp', ['two']);
  f.apps.start();
  await settle(f);
  f.data.write('mcp.json', { mcpServers: { a: { url: 'https://a.example/mcp', disabled: true }, b: { url: 'https://b.example/mcp' } } });
  f.changedFile();
  await settle(f);
  assert.deepEqual(f.tools.names(), ['app.b.two']);
  assert.equal(f.apps.list().find((app) => app.id === 'a')?.status, 'off');
  f.data.write('mcp.json', { mcpServers: {} });
  f.changedFile();
  await settle(f);
  assert.deepEqual(f.tools.names(), []);
  assert.deepEqual(f.oauth.forgotten.sort(), ['a', 'b']);
  await f.apps.stop();
});

test('sign-in: a new entry that answers 401 opens the sign-in page; at start it only says how; reconnect opens it', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: {} });
  f.servers.add('https://mcp.notion.com/mcp', ['search'], { requires: { header: 'Authorization', value: 'Bearer oauth-access' } });
  f.apps.start();
  await settle(f);
  f.data.write('mcp.json', { mcpServers: { notion: { url: 'https://mcp.notion.com/mcp' } } });
  f.changedFile();
  await settle(f);
  assert.equal(f.apps.list()[0].status, 'waiting');
  assert.equal(f.browser.length, 1);
  f.oauth.complete('notion');
  await settle(f);
  assert.equal(f.apps.list()[0].status, 'ok');
  await f.apps.stop();

  const g = appsFixture();
  g.data.write('mcp.json', { mcpServers: { notion: { url: 'https://mcp.notion.com/mcp' } } });
  g.servers.add('https://mcp.notion.com/mcp', ['search'], { requires: { header: 'Authorization', value: 'Bearer oauth-access' } });
  g.apps.start();
  await settle(g);
  assert.equal(g.apps.list()[0].status, 'signin');
  assert.match(g.apps.list()[0].error ?? '', /apps\.reconnect/);
  assert.equal(g.browser.length, 0);
  assert.equal((await g.apps.reconnect('notion')).status, 'waiting');
  assert.equal(g.browser.length, 1);
  await g.apps.stop();
});

test('cached tools: at start an unchanged entry registers its tools without starting the server', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { files: { command: 'fake-server' } } });
  f.servers.add('fake-server', ['read_file']);
  f.apps.start();
  await settle(f);
  await f.apps.stop();
  const opened = f.servers.opened.length;
  const again = appsFixture({ kv: f.kv, dataDir: f.data.dir, connect: f.servers.connect });
  again.apps.start();
  await again.apps.idle();
  assert.deepEqual(again.tools.names(), ['app.files.read_file']);
  assert.equal(f.servers.opened.length, opened);
  await again.apps.stop();
});

test('the tool host: a call runs on the server; a 401 on a call turns the connector to signin', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } });
  const server = f.servers.add('https://mcp.linear.app/mcp', ['list_issues'], { callFailures: [new McpAuthRequired({ status: 401 })] });
  f.apps.start();
  await settle(f);
  await assert.rejects(f.apps.host.call('linear', 'list_issues', {}), McpAuthRequired);
  assert.equal(f.apps.list()[0].status, 'signin');
  const result = await f.apps.host.call('linear', 'list_issues', { q: 1 });
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(server.calls, [{ tool: 'list_issues', args: { q: 1 } }]);
  assert.equal(f.apps.list()[0].status, 'ok');
  await f.apps.stop();
});

test('migration: the old Settings › Apps records move into the files once (tokens as handles, tool lists as cache)', () => {
  const data = dataFolder();
  const kv = new FakeKv();
  kv.set('app:linear', { id: 'linear', name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/mcp', token: { secretId: 'tok', header: 'Authorization' }, enabled: true, tools: [{ name: 'x', inputSchema: {} }] });
  kv.set('app:fs', { id: 'fs', name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: { KEY: { secretId: 'k' }, PLAIN: 'v' }, enabled: false, tools: [] });
  kv.set('app:box', { id: 'box', name: 'box', transport: 'mail', mail: { address: 'me@example.com', user: 'me', imap: { host: 'i', port: 993, tls: 'implicit' }, smtp: { host: 's', port: 465, tls: 'implicit' }, agentId: 'ag_1' }, token: { secretId: 'pw', header: 'password' }, enabled: true, tools: [] });
  assert.equal(migrateRecords(data.dir, kv), 3);
  assert.deepEqual(data.read('mcp.json'), { mcpServers: {
    Linear: { url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'secret://tok' } },
    fs: { command: 'npx', args: ['-y', 'server'], env: { KEY: 'secret://k', PLAIN: 'v' }, disabled: true },
  } });
  assert.equal((data.read('mail.json') as { mailboxes: Record<string, { password: string; agent: string }> }).mailboxes.box.password, 'secret://pw');
  assert.deepEqual(kv.keys('app:'), []);
  assert.ok(kv.get('tools:linear'));
  assert.equal(migrateRecords(data.dir, kv), 0);
});

test('new mail wakes the mailbox\'s agent (by name or id, else the assistant) at most once a minute, merged', async () => {
  const { MailWaker, mailAgent } = await import('../../../src/runtime/apps/mail-wake.ts');
  const { ManualTimers } = await import('./service-fakes.ts');
  const box = { id: 'work', name: 'work', transport: 'mail' as const, enabled: true, fingerprint: 'f', mail: { address: 'me@example.com', password: 'secret://pw', agent: 'Secretary' } };
  const agents = [{ id: 'ag_sec', name: 'Secretary', managerId: undefined }, { id: 'ag_old', name: 'Old', archivedAt: 1 }];
  const org = { list: () => agents, get: (id: string) => agents.find((a) => a.id === id), managers: () => [] };
  assert.equal(mailAgent({ org } as never, box), 'ag_sec');
  const wakes: Array<{ agentId: string; note: string }> = [];
  let now = 1_000_000;
  const timers = new ManualTimers();
  const waker = new MailWaker({ services: { org, wakes: { wake: (input: { agentId: string; note: string }) => { wakes.push(input); } }, clock: { now: () => now } } as never, connected: () => box, timers });
  waker.notice('work', { count: 1, from: 'Maria <maria@client.example>', subject: 'Offer' });
  waker.notice('work', { count: 2, subject: 'Again' });
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].note, /New mail in me@example\.com: 1 new message\. Newest from "Maria \(maria@client\.example\)"/);
  now += 61_000;
  timers.fireAll();
  assert.equal(wakes.length, 2);
  assert.match(wakes[1].note, /2 new messages/);
});
