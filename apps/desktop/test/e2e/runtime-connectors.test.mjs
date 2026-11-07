// End-to-end (AF-005): connectors added the way Settings › Connectors adds them reach an agent at once – the real headless
// runtime (built app/runtime-cli.mjs) with the deterministic fake engine over the real WebSocket RPC and a local stdio MCP
// server (test/fixtures/apps/fake-stdio-server.mjs; no network, no real token). One server comes from the own-server form,
// one from pasted Claude Desktop JSON: their values go into the secrets catalog (secrets.save) and mcp.json holds only the
// handles (files.readPath / files.writePath, what the page does); both turn "ok" with their tools; the manager calls a tool
// of each in its next turn (the env tool proves the handle was filled in); an "agents" list that leaves the manager out
// refuses its call without a new connection, and the switch turns the tools off and on again.
// Run: npm run build && node --test test/e2e/runtime-connectors.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';
import { serverDraft, NO_SERVER } from '../../src/ui/settings/apps-server-entry.ts';
import { checkImport, withHandles } from '../../src/ui/settings/mcp-import.ts';
import { agentsPatch, patchedEntry, switchPatch, withEntries } from '../../src/ui/settings/apps-files.ts';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'apps', 'fake-stdio-server.mjs');
const FORM_VALUE = 'form-value-e2e-7731';
const PASTED_KEY = 'pasted-key-e2e-4410';

const finalFrom = (chatId, agentId, pattern) => (message) =>
  message.conversationId === chatId && message.authorId === agentId && message.state === 'final' && pattern.test(message.body);

test('connectors from the form and from pasted JSON connect and an agent uses their tools at once', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  const root = (await client.call('system.root')).path;
  const file = path.join(root, 'connectors', 'mcp.json');

  // What saveServers (apps-files.ts) does: each moved value into Secrets, the handles into the entry, one write of mcp.json.
  const save = async (servers) => {
    const ready = [];
    for (const server of servers) {
      const ids = new Map();
      for (const move of server.moves) ids.set(`${move.where}.${move.key}`, (await client.call('secrets.save', { label: `${server.name} · ${move.key}`, kind: 'api_key', value: move.value, description: 'AF-005 e2e' })).id);
      ready.push({ name: server.name, entry: withHandles(server, ids) });
    }
    const now = await client.call('files.readPath', { path: file });
    const { text, names } = withEntries('mcp.json', now.text ?? '', ready);
    await client.call('files.writePath', { path: file, text, ...(now.stamp ? { base: now.stamp } : {}) });
    return names;
  };
  const edit = async (change) => {
    const now = await client.call('files.readPath', { path: file });
    await client.call('files.writePath', { path: file, text: change(now.text ?? ''), ...(now.stamp ? { base: now.stamp } : {}) });
  };
  const apps = async () => client.call('apps.list');
  const until = async (check, what, ms = 60_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const list = await apps();
      if (check(list)) return list;
      if (Date.now() > end) throw new Error(`${what}: ${JSON.stringify(list)}\n${runtime.stderr().slice(-3000)}`);
      await sleep(250);
    }
  };

  // 1. The own-server form: a command on this PC with an environment variable (its value goes into Secrets).
  const form = serverDraft({ ...NO_SERVER, kind: 'command', address: `"${process.execPath}" "${fixture}" normal`, name: 'Form server', rows: [{ id: '1', name: 'APP_OWN', value: FORM_VALUE }] });
  assert.equal(form.blocked, '');
  // 2. Pasted Claude Desktop JSON.
  const pasted = checkImport(JSON.stringify({ mcpServers: { pasted: { command: process.execPath, args: [fixture, 'normal'], env: { APP_OWN: 'plain', API_KEY: PASTED_KEY } } } }));
  assert.deepEqual(pasted.errors, []);
  assert.deepEqual(await save([form.server, ...pasted.servers]), ['Form server', 'pasted']);
  const text = (await client.call('files.readPath', { path: file })).text;
  assert.doesNotMatch(text, new RegExp(`${FORM_VALUE}|${PASTED_KEY}`), 'no value in mcp.json');
  assert.match(text, /"APP_OWN": "secret:\/\/[A-Za-z0-9_-]+"/);

  const connected = await until((list) => list.length === 2 && list.every((app) => app.status === 'ok' && app.tools >= 5), 'both connect');
  const formApp = connected.find((app) => app.name === 'Form server');
  const pastedApp = connected.find((app) => app.name === 'pasted');
  assert.ok(formApp && pastedApp);
  assert.ok(formApp.toolNames.includes('echo'));

  // 3. The manager uses them in its next turn.
  await client.call('events.subscribe', { topics: ['chats'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  const chat = await client.call('chats.create', { title: 'Connectors', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
  await client.call('messages.send', { conversationId: chat.id, body: `[[tool:app.${formApp.id}.echo {"text":"hi"}]] [[tool:app.${formApp.id}.env {}]] [[tool:app.${pastedApp.id}.echo {"n":2}]]` });
  const answer = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, new RegExp(`app\\.${pastedApp.id}\\.echo →`)), 90_000);
  assert.match(answer.body, new RegExp(`app\\.${formApp.id}\\.echo → [^\\n]*\\necho \\{"text":"hi"\\}`), 'the form server answered');
  assert.match(answer.body, new RegExp(`app\\.${pastedApp.id}\\.echo → [^\\n]*\\necho \\{"n":2\\}`), 'the pasted server answered');
  assert.match(answer.body, /"own":"secret:\/\/[^"]+"/,'the server saw the value (masked back to its handle in what the agent reads)');
  assert.doesNotMatch(answer.body, new RegExp(FORM_VALUE), 'the value itself never reaches the chat');

  // 4. Only another agent may use the form server: the manager's call is refused, nothing connects again.
  await edit((current) => patchedEntry('mcp.json', current, 'Form server', agentsPatch(['agt_someone_else'])));
  await until((list) => list.find((app) => app.id === formApp.id)?.agents?.[0] === 'agt_someone_else', 'the list applies');
  assert.equal((await apps()).find((app) => app.id === formApp.id).status, 'ok', 'still connected');
  await client.call('messages.send', { conversationId: chat.id, body: `[[tool:app.${formApp.id}.echo {"text":"again"}]]` });
  const refused = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /shares with other agents only|not available|Unknown tool/), 90_000);
  assert.doesNotMatch(refused.body, /echo \{"text":"again"\}/);

  // 5. Off and on again (the same switch the row has).
  await edit((current) => patchedEntry('mcp.json', current, 'pasted', switchPatch(false)));
  await until((list) => list.find((app) => app.id === pastedApp.id)?.status === 'off', 'off');
  await edit((current) => patchedEntry('mcp.json', current, 'pasted', switchPatch(true)));
  await until((list) => list.find((app) => app.id === pastedApp.id)?.status === 'ok', 'on again');
});
