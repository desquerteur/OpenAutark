// End-to-end measurement (audit 23.10., 8 GB reference): memory and CPU of the real headless runtime
// (built app/runtime-cli.mjs, deterministic fake engine, real WebSocket RPC, temp profile) after start,
// idle, while agents work (several chats with turns at once, task tools included) and idle again.
// Reads the runtime's own numbers (system.resources › runtime: rss, heap, CPU time) and prints them as
// diagnostics; CPU shares are CPU-time deltas over wall time (the sampler's reads would reset the
// field cpuPercent). Asserts the budgets the 8 GB laptop needs: idle < 2 % of one core once start-up
// work settled (also after the load), heap below 200 MB and rss below 400 MB / 600 MB under the fake
// load, heap back below the load peak + 10 % afterwards. On Windows rss is the working set, which the
// OS trims under memory pressure – heap is the steadier number. The sampling is the test's own probe.
// Run: npm run build && node --test test/e2e/runtime-footprint.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';

const CHATS = 4;
const ROUNDS = 3;
const SETTLE_MS = 15_000; // start-up / after-turn background work (indexing, memory scans) ends
const IDLE_WINDOW_MS = 20_000;

const usage = async (client) => (await client.call('system.resources')).runtime;
const fmt = (u) => `rss ${u.rssMb.toFixed(0)} MB, heap ${u.heapUsedMb.toFixed(0)} MB`;
/** CPU share of one core between two readings, in percent. */
const cpu = (from, to) => ((to.cpuMs - from.cpuMs) / Math.max(1, to.uptimeMs - from.uptimeMs)) * 100;
/** CPU share over an idle window that starts after SETTLE_MS. */
async function idleWindow(client) {
  await sleep(SETTLE_MS);
  const from = await usage(client);
  await sleep(IDLE_WINDOW_MS);
  const to = await usage(client);
  return { usage: to, cpu: cpu(from, to) };
}

test('runtime footprint: start, idle, fake-engine load, idle again', { timeout: 300_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org'] });
  const started = await usage(client);
  t.diagnostic(`after start: ${fmt(started)}, uptime ${(started.uptimeMs / 1000).toFixed(1)} s`);

  const quiet = await idleWindow(client);
  const idle = quiet.usage;
  t.diagnostic(`idle ${IDLE_WINDOW_MS / 1000} s (after ${SETTLE_MS / 1000} s): ${fmt(idle)}, cpu ${quiet.cpu.toFixed(2)} %`);

  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const chats = [];
  for (let i = 0; i < CHATS; i++) {
    const chat = await client.call('chats.create', { title: `Load ${i + 1}`, agentIds: [manager.id] });
    await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
    chats.push(chat);
  }
  let peak = 0;
  let peakHeap = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) { const u = await usage(client).catch(() => undefined); if (u) { peak = Math.max(peak, u.rssMb); peakHeap = Math.max(peakHeap, u.heapUsedMb); } await sleep(250); }
  })();
  const loadStart = Date.now();
  const loadFrom = await usage(client);
  for (let round = 0; round < ROUNDS; round++) {
    await Promise.all(chats.map(async (chat, i) => {
      const body = `Round ${round + 1} in chat ${i + 1}: please answer briefly`;
      await client.call('messages.send', { conversationId: chat.id, body });
      await client.waitFor('message.updated', (m) => m.conversationId === chat.id && m.authorId === manager.id && m.state === 'final' && m.body.includes(`Round ${round + 1} in chat ${i + 1}`), 90_000);
    }));
  }
  await Promise.all(chats.map((chat) => client.call('tasks.create', { conversationId: chat.id, title: `Load task ${chat.title}`, assigneeKind: 'agent', assigneeId: manager.id })));
  await sleep(3000);
  const load = await usage(client);
  sampling = false;
  await sampler;
  const turns = CHATS * ROUNDS;
  t.diagnostic(`load (${turns} turns in ${CHATS} chats + ${CHATS} tasks, ${((Date.now() - loadStart) / 1000).toFixed(1)} s): ${fmt(load)}, cpu ${cpu(loadFrom, load).toFixed(1)} %, peak rss ${peak.toFixed(0)} MB, peak heap ${peakHeap.toFixed(0)} MB`);

  const calm = await idleWindow(client);
  const after = calm.usage;
  t.diagnostic(`idle again: ${fmt(after)}, cpu ${calm.cpu.toFixed(2)} %`);

  assert.ok(quiet.cpu < 2, `idle CPU ${quiet.cpu.toFixed(2)} % < 2 %`);
  assert.ok(calm.cpu < 2, `idle CPU after the load ${calm.cpu.toFixed(2)} % < 2 %`);
  assert.ok(started.rssMb < 400 && idle.rssMb < 400 && idle.heapUsedMb < 200, 'rss below 400 MB and heap below 200 MB at start and idle');
  assert.ok(peak < 600 && peakHeap < 200, `under the fake load rss ${peak} MB < 600 MB, heap ${peakHeap} MB < 200 MB`);
  assert.ok(after.heapUsedMb < Math.max(peakHeap, idle.heapUsedMb) * 1.1, 'no heap growth that stays after the load');
});
