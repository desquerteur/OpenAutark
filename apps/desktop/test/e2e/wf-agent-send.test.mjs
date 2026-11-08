// End-to-end (AF-001): an agent without our MCP chat tool writes into a chat with `wf send` from its own shell, and the
// line stands there under the agent's name – not the person's. The real headless runtime with the deterministic fake
// engine (no MCP hub: caps.mcp false); the manager runs `wf send` through shell.exec, which starts in the agents' env
// (<data>/bin first on PATH – the wf shim of app/wf.mjs –, AUTARK_DATA, and its AUTARK_AGENT_TOKEN). Covers: author id,
// kind and name of the line (messages.list and `wf read`), that the agent's own line does not wake it again, that the
// person's wf still writes as the person, and that a forged identity is refused (exit 3) instead of posting as the person.
// Run: npm run build && node --test test/e2e/wf-agent-send.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startRuntime } from './lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = path.join(root, 'app', 'wf.mjs');
const MARK = 'AF001-line-from-the-agent';

/** `node app/wf.mjs --data <dir> …` as the person runs it (no agent identity unless `env` gives one). */
function wf(args, { data, env = {} }) {
  const clean = { ...process.env };
  delete clean.AUTARK_AGENT_TOKEN;
  delete clean.AUTARK_DATA;
  const child = spawn(process.execPath, [WF, '--data', data, ...args], { cwd: root, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`wf ${args.join(' ')} did not finish\n${stdout}\n${stderr}`)); }, 60_000);
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const finalFrom = (chatId, agentId) => (message) => message.conversationId === chatId && message.authorId === agentId && message.state === 'final' && /shell\.exec/.test(message.body);

test('an agent without the MCP chat tool writes with wf send – the line is the agent\'s', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client, dataDir } = runtime;
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'the first run seeds the manager');
  const chat = await client.call('chats.create', { title: 'wf as the agent', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });

  // The person asks; the manager's turn (fake engine, no MCP) runs `wf send` in its shell instead of chat.send.
  await client.call('messages.send', { conversationId: chat.id, body: `Tell us through wf [[tool:shell.exec {"command":"wf send ${chat.id} ${MARK}"}]]` });
  const reply = await client.waitFor('message.updated', finalFrom(chat.id, manager.id), 120_000);
  assert.match(reply.body, /Sent to/, `wf ran in the agent's shell:\n${reply.body}`);

  const lines = await client.call('messages.list', { conversationId: chat.id, limit: 50 });
  const line = lines.find((message) => message.body.trim() === MARK);
  assert.ok(line, 'the wf line is in the chat');
  assert.equal(line.authorId, manager.id, 'written by the manager');
  assert.equal(line.authorKind, 'agent');
  assert.ok(!lines.some((message) => message.body.trim() === MARK && message.authorId === 'human'), 'never as the person');

  const read = await wf(['read', chat.id], { data: dataDir });
  assert.equal(read.code, 0, read.stderr);
  const shown = read.stdout.split('\n').find((text) => text.trimEnd().endsWith(`: ${MARK}`)); // the wf line itself, not the person's request quoting it
  assert.ok(shown?.includes(`${manager.name}:`), `wf read names the agent: ${shown}`);
  assert.ok(!shown?.includes('You:'), 'not the person');

  // Its own line woke nobody: the manager answers the person's message once, not its own wf line as well.
  await delay(3_000);
  const after = await client.call('messages.list', { conversationId: chat.id, limit: 50 });
  assert.equal(after.filter((message) => message.authorId === manager.id && message.state === 'final' && message.kind !== 'status' && message.body.trim() !== MARK).length, 1, 'one answer, no turn for its own line');

  // The person's own wf still writes as the person; a forged agent identity is refused, never posted as the person.
  const own = await wf(['send', chat.id, 'From the person', '--json'], { data: dataDir });
  assert.equal(own.code, 0, own.stderr);
  assert.equal(JSON.parse(own.stdout).authorId, 'human');
  const forged = await wf(['send', chat.id, 'Forged line'], { data: dataDir, env: { AUTARK_AGENT_TOKEN: 'wfa1.YWdfbm9ib2R5.forged', AUTARK_DATA: dataDir } });
  assert.equal(forged.code, 3, `refused: ${forged.stderr}`);
  assert.match(forged.stderr, /AUTARK_AGENT_TOKEN/);
  const final = await client.call('messages.list', { conversationId: chat.id, limit: 80 });
  assert.ok(!final.some((message) => message.body.includes('Forged line')), 'nothing posted for a forged identity');
});
