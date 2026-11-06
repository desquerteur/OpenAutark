// B-075 (owner 04.11.2026: the app's Codex threads filled his own Codex chat list): every new agent thread – thread/start,
// thread/fork, the rebuild and its probe – is stored with threadSource 'chatgpt_hidden', which the Codex desktop app
// leaves out of its sidebar, search and notifications; thread/resume never carries it (the field is not in its schema,
// the thread keeps its stored source). Opens wait THREAD_OPEN_MS, the rebuild's too.
// Owns: nothing in production. Never starts a real binary (a scripted request function).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIDDEN_THREAD, THREAD_OPEN_MS, openAgentThread } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { probeCodexRebuild, startRebuiltThread } from '../../../src/runtime/engines/codex/rebuild.ts';
import { RpcError, type RpcClient } from '../../../src/runtime/engines/codex/rpc.ts';

type Sent = { method: string; params: Record<string, any>; timeoutMs?: number };

/** Answers every request; `refuse(sent)` turns one into an error answer (a refusal, not a timeout). */
function fakeRpc(refuse: (sent: Sent) => boolean = () => false) {
  const sent: Sent[] = [];
  const rpc = {
    request: async (method: string, params?: unknown, timeoutMs?: number) => {
      const entry = { method, params: params as Record<string, any>, timeoutMs };
      sent.push(entry);
      if (refuse(entry)) throw new RpcError(-32602, 'unknown field');
      if (method === 'thread/items/list') return { data: [{}, {}], nextCursor: null };
      return method.startsWith('thread/') && method !== 'thread/delete' && method !== 'thread/inject_items' ? { thread: { id: 'thr_1' } } : {};
    },
  } as unknown as RpcClient;
  return { rpc, sent };
}

test('a new agent thread (start, fork) is stored hidden from the Codex desktop app; a resume never carries the field', async () => {
  assert.deepEqual(HIDDEN_THREAD, { threadSource: 'chatgpt_hidden' });
  const { rpc, sent } = fakeRpc();
  const settings = { model: 'gpt-6.1-sol', cwd: '/ws', config: {} };
  await openAgentThread(rpc, 'thread/start', settings, new Set(), 'acc_1', new Set());
  await openAgentThread(rpc, 'thread/fork', { threadId: 'thr_parent', ...settings }, new Set(), 'acc_1');
  await openAgentThread(rpc, 'thread/resume', { threadId: 'thr_1', ...settings }, new Set(), 'acc_1');
  assert.deepEqual(sent.map((entry) => [entry.method, entry.params.threadSource, entry.timeoutMs]), [
    ['thread/start', 'chatgpt_hidden', THREAD_OPEN_MS],
    ['thread/fork', 'chatgpt_hidden', THREAD_OPEN_MS],
    ['thread/resume', undefined, THREAD_OPEN_MS],
  ]);
  assert.equal('threadSource' in sent[2].params, false);
  assert.equal('threadSource' in settings, false, 'the caller\'s settings stay as they are');
});

test('the fallbacks keep it: a server that refuses raw items or the lean settings still opens a hidden thread', async () => {
  const { rpc, sent } = fakeRpc((entry) => entry.method === 'thread/start' && (entry.params.experimentalRawEvents === true || entry.params.config?.include_environment_context === false));
  const refused = new Set<string>();
  const raw = new Set<string>();
  await openAgentThread(rpc, 'thread/start', { model: 'gpt-6.1-sol', config: {} }, refused, 'acc_1', raw);
  assert.ok(sent.length >= 3, 'refused, then opened plainer');
  assert.ok(sent.every((entry) => entry.params.threadSource === 'chatgpt_hidden'), JSON.stringify(sent.map((entry) => entry.params.threadSource)));
  assert.deepEqual([refused.has('acc_1'), raw.has('acc_1')], [true, true]);
});

test('the rebuild\'s own thread and its probe open hidden and wait THREAD_OPEN_MS (a cold app-server took ~65 s)', async () => {
  const { rpc, sent } = fakeRpc();
  await startRebuiltThread(rpc, { model: 'gpt-6.1-sol' }, [], 'accepted');
  const probe = await probeCodexRebuild(rpc, { model: 'gpt-6.1-sol' }, '0.166.0', 1);
  assert.equal(probe.ok, true);
  const starts = sent.filter((entry) => entry.method === 'thread/start');
  assert.equal(starts.length, 2);
  for (const start of starts) assert.deepEqual([start.params.threadSource, start.timeoutMs], ['chatgpt_hidden', THREAD_OPEN_MS]);
  assert.deepEqual(starts[1].params.dynamicTools?.map((tool: { name: string }) => tool.name), ['workforce_probe']);
});
