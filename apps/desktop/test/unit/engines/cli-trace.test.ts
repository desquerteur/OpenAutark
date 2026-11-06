// The subconscious's trace on the CLI engines (owner 01.11.2026): Codex gets real function_call + function_call_output pairs through
// thread/inject_items before the turn; Claude Code real tool_use + tool_result records in the session's transcript before the resume –
// on a session that is new, a fresh transcript holding only them. A refusal falls back to a tool-call-shaped block in the turn input
// and says so (result.traceAsText). No trace: nothing changes. An engine without its own form gets the block from the executor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lastRecord } from '../../../src/runtime/engines/claude/rebuild.ts';
import { ClaudeRebuilder, TRACE_END } from '../../../src/runtime/engines/claude/rebuilder.ts';
import { injectTrace } from '../../../src/runtime/engines/codex/rebuild.ts';
import { traceInput, traceItems } from '../../../src/runtime/engines/trace-text.ts';
import { account } from './fakes.ts';
import type { RpcClient } from '../../../src/runtime/engines/codex/rpc.ts';
import type { TraceCall } from '../../../src/shared/model/subconscious.ts';

const CALLS: TraceCall[] = [{ tool: 'vector.search', args: { query: 'launch day', in: ['memory'] }, output: 'memory/company/launch.md: Friday' }];

function rebuilder(dir: string, files: Record<string, unknown> = {}) {
  let n = 0;
  return new ClaudeRebuilder({
    supervisor: undefined as never, finder: { find: async () => null } as never, tempDir: dir, transcriptsDir: path.join(dir, 'transcripts'),
    files: { writeFile: async (file, data) => writeFileSync(file, data), rm: async (file) => rmSync(file, { force: true }), mkdir: async (folder) => { mkdirSync(folder, { recursive: true }); }, ...files },
    envFor: () => ({}), uuid: () => `00000000-0000-4000-8000-00000000000${++n}`, now: () => 1000,
  });
}

test('Codex: the trace goes in as a real function_call + output pair; a refusal comes back as its reason', async () => {
  const sent: Array<{ method: string; params: { threadId: string; items: Array<Record<string, unknown>> } }> = [];
  const rpc = { request: async (method: string, params: never) => { sent.push({ method, params }); return {}; } } as unknown as RpcClient;
  assert.equal(await injectTrace(rpc, 'thr_1', CALLS, 'run_1'), undefined);
  assert.equal(sent[0].method, 'thread/inject_items');
  assert.equal(sent[0].params.threadId, 'thr_1');
  assert.deepEqual(sent[0].params.items, [
    { type: 'function_call', name: 'vector__search', arguments: JSON.stringify(CALLS[0].args), call_id: 'sc_run_1_0' },
    { type: 'function_call_output', call_id: 'sc_run_1_0', output: CALLS[0].output },
  ]);
  const refusing = { request: async () => { throw new Error('method not found'); } } as unknown as RpcClient;
  assert.equal(await injectTrace(refusing, 'thr_1', CALLS, 'run_1'), 'method not found');
});

test('Claude Code: the pair is appended to the session transcript, chained to its last record, with a closing record', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-trace-'));
  try {
    const home = path.join(dir, 'home');
    const folder = path.join(home, 'projects', 'C--work');
    mkdirSync(folder, { recursive: true });
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const file = path.join(folder, `${sessionId}.jsonl`);
    const before = [
      { type: 'user', uuid: 'a', parentUuid: null, sessionId, version: '2.1.303', isSidechain: false, message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'b', parentUuid: 'a', sessionId, version: '2.1.303', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'last-prompt', sessionId, lastPrompt: 'hello' },
    ].map((record) => JSON.stringify(record)).join('\n');
    writeFileSync(file, `${before}\n`);
    const ref = await rebuilder(dir).injectTrace({ trace: { calls: CALLS }, runId: 'run_1', cwd: 'C:/work', model: 'claude-opus-5-5', account: account({ provider: 'claude', home }) }, sessionId);
    assert.equal(ref, sessionId, 'the same session: the prefix keeps its prompt cache');
    const records = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const [use, result, closing] = records.slice(3);
    assert.equal(use.type, 'assistant');
    assert.equal(use.parentUuid, 'b', 'chained to the newest record of the main chain');
    assert.equal(use.sessionId, sessionId);
    assert.equal(use.version, '2.1.303');
    assert.deepEqual(use.message.content, [{ type: 'tool_use', id: 'sc_run_1_0', name: 'mcp__workforce__tools__call', input: { name: 'vector.search', args: CALLS[0].args } }], 'the hub offers tools.call in every turn, vector.search only once learned');
    assert.equal(result.type, 'user');
    assert.equal(result.parentUuid, use.uuid);
    assert.deepEqual(result.message.content, [{ type: 'tool_result', tool_use_id: 'sc_run_1_0', content: CALLS[0].output }]);
    assert.equal(result.sourceToolAssistantUUID, use.uuid);
    assert.deepEqual(closing.message.content, [{ type: 'text', text: TRACE_END }]);
    assert.equal(closing.parentUuid, result.uuid);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude Code: without a session a fresh transcript holds only the pair; a missing transcript throws (the turn takes the text form)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-trace-'));
  try {
    const b = rebuilder(dir);
    const input = { trace: { calls: CALLS }, runId: 'run_1', cwd: 'C:/work', model: 'claude-opus-5-5', account: account({ provider: 'claude', home: path.join(dir, 'home') }) };
    const ref = await b.injectTrace(input, undefined);
    assert.ok(ref.endsWith('.jsonl') && path.isAbsolute(ref));
    const records = readFileSync(ref, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.type), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(records[0].parentUuid, null);
    assert.equal((await b.before(ref)).rebuilt, true, 'its first turn counts as a rebuilt session');
    await assert.rejects(b.injectTrace(input, '22222222-2222-4222-8222-222222222222'), /not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lastRecord skips a cut first line, records without a uuid and sidechains', () => {
  const tail = ['"cut line}', JSON.stringify({ uuid: 'x', isSidechain: false, sessionId: 's', version: 'v' }), JSON.stringify({ uuid: 'side', isSidechain: true }), JSON.stringify({ type: 'last-prompt' }), ''].join('\n');
  assert.deepEqual(lastRecord(tail), { uuid: 'x', sessionId: 's', version: 'v' });
  assert.equal(lastRecord('no json\n'), undefined);
});

test('the fallback is one tool-call-shaped input block; the items are real calls of ours', () => {
  const block = traceInput(CALLS);
  assert.equal(block.type, 'text');
  assert.match((block as { text: string }).text, /^<tool_call name="vector\.search" args='\{"query":"launch day","in":\["memory"\]\}'>\n<tool_output>\nmemory\/company\/launch\.md: Friday\n<\/tool_output>\n<\/tool_call>$/);
  assert.equal(traceItems(CALLS, 'r')[0].call?.own, undefined);
});
