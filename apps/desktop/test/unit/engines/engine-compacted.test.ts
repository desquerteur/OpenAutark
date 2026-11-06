// B-049 F6 – an engine reports when it compacted the native session's history inside a turn (EngineTurnResult.compacted),
// so the executor forgets which volatile sections that session holds (agents/volatile-delta.ts forgetSent) and the
// next turn sends them all again: Codex's contextCompaction item and its deprecated thread/compacted notification
// (app-server schema v2), Claude Code's main-thread system/compact_boundary line (a subagent's does not count).
// Owns: these assertions only. Never starts a real binary (scripted app-server / CLI over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { ClaudeEngine, type FileOps } from '../../../src/runtime/engines/claude/engine.ts';
import { ClaudeStreamParser } from '../../../src/runtime/engines/claude/stream.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';

type Compaction = 'item' | 'notification' | undefined;

/** A scripted Codex app-server whose turns may compact the thread first (the way `compact` says). */
function codexServer(compact: { next: Compaction }) {
  let threads = 0;
  let turns = 0;
  return fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method || msg.id === undefined) return;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'workforce/0.164.0 (Windows)' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'turn/start': {
          const id = `turn_${++turns}`;
          const threadId = msg.params.threadId;
          child.send({ id: msg.id, result: { turn: { id, status: 'inProgress' } } });
          if (compact.next === 'item') child.send({ method: 'item/completed', params: { threadId, turnId: id, item: { id: `c${turns}`, type: 'contextCompaction' } } });
          if (compact.next === 'notification') child.send({ method: 'thread/compacted', params: { threadId, turnId: id } });
          child.send({ method: 'item/completed', params: { threadId, turnId: id, item: { id: `m${turns}`, type: 'agentMessage', text: 'ok' } } });
          child.send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
          break;
        }
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
}

test('codex: a contextCompaction item or thread/compacted in the turn sets result.compacted; a plain turn does not', async () => {
  const compact: { next: Compaction } = { next: undefined };
  const { spawn } = codexServer(compact);
  const e = new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });
  const plain = await e.run(turnInput({ runId: 'run_1' }).input);
  assert.equal(plain.stop, 'done');
  assert.equal(plain.compacted, undefined);
  compact.next = 'item';
  const viaItem = await e.run(turnInput({ runId: 'run_2', session: { ref: 'thr_1', generation: 1 } }).input);
  assert.equal(viaItem.stop, 'done');
  assert.equal(viaItem.compacted, true);
  compact.next = 'notification';
  const viaNote = await e.run(turnInput({ runId: 'run_3', session: { ref: 'thr_1', generation: 1 } }).input);
  assert.equal(viaNote.compacted, true);
  compact.next = undefined;
  assert.equal((await e.run(turnInput({ runId: 'run_4', session: { ref: 'thr_1', generation: 1 } }).input)).compacted, undefined, 'per turn, never sticky');
  await e.dispose();
});

test('claude: a main-thread system/compact_boundary sets result.compacted; a subagent\'s does not', async () => {
  const parser = new ClaudeStreamParser(() => {}, () => 0);
  parser.push({ type: 'system', subtype: 'compact_boundary', parent_tool_use_id: 'toolu_1', compact_metadata: { trigger: 'auto' } });
  assert.equal(parser.state.compacted, undefined, 'a subagent compacted its own history, not the session');
  parser.push({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180_000 } });
  assert.equal(parser.state.compacted, true);

  let compactNext = false;
  const { spawn } = fakeSpawn(({ args, child }) => {
    const at = args.indexOf('--resume') >= 0 ? args.indexOf('--resume') : args.indexOf('--session-id');
    const session = args[at + 1];
    child.onLine = (message) => {
      if (message?.type !== 'user') return;
      child.send({ type: 'system', subtype: 'init', session_id: session });
      if (compactNext) child.send({ type: 'system', subtype: 'compact_boundary', session_id: session, compact_metadata: { trigger: 'auto', pre_tokens: 180_000 } });
      child.send({ type: 'result', session_id: session, subtype: 'success', is_error: false, result: 'Done.', usage: { input_tokens: 10, output_tokens: 2 } });
      setImmediate(() => child.exit(0));
    };
  });
  const files: FileOps = { writeFile: async () => {}, readFile: async () => new Uint8Array(), rm: async () => {}, mkdir: async () => {} };
  let n = 0;
  const e = new ClaudeEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ claude: '/bin/claude' }), tempDir: '/tmp/wf', files, uuid: () => `00000000-0000-4000-8000-00000000000${++n}` });
  const plain = await e.run(turnInput({ model: 'claude-opus-5-5', account: account({ provider: 'claude' }) }).input);
  assert.equal(plain.stop, 'done');
  assert.equal(plain.compacted, undefined);
  compactNext = true;
  const compacted = await e.run(turnInput({ model: 'claude-opus-5-5', account: account({ provider: 'claude' }), session: plain.session }).input);
  assert.equal(compacted.stop, 'done');
  assert.equal(compacted.compacted, true);
});
