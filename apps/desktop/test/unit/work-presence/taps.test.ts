// B-055 G (WORK-PRESENCE): the one tap – the run journal's bus events (work-presence/service.ts, touches.ts):
//  - a Codex fileChange item (scripted app-server) and a patch run through its shell, as the turn journals them;
//  - Claude Code's Edit / Write (a long one arrives as a cut preview) / MultiEdit / NotebookEdit / Read tool_use;
//  - an ACP edit (its locations travel as `paths`, engines/acp/updates.ts) and read;
//  - our files tools are not read from the journal (they record themselves); a re-emitted row records nothing new;
//  - 'run.upserted' running / done → running turns and the overlap note; summary().
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { ClaudeStreamParser } from '../../../src/runtime/engines/claude/stream.ts';
import { applyUpdate, newTurnState } from '../../../src/runtime/engines/acp/updates.ts';
import { touchesOf } from '../../../src/runtime/work-presence/touches.ts';
import type { EngineEvent } from '../../../src/runtime/engines/types.ts';
import { fakeFinder, fakeSpawn, testSupervisor, turnInput, type FakeChild } from '../engines/fakes.ts';
import { MIN, presenceSetup } from './fixture.ts';

function appServer(onTurn: (child: FakeChild, threadId: string) => void) {
  return fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.id !== undefined && !msg.method) return;
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        onTurn(child, msg.params.threadId);
      } else if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
}

const kinds = (s: ReturnType<typeof presenceSetup>, agentId: string) =>
  s.presence.ledger.touchedBy(agentId).map((entry) => `${entry.kind} ${path.relative(s.workspace, entry.file).replace(/\\/g, '/')}`).sort();

test('Codex: a fileChange item and a patch through its shell reach the ledger (relative paths in the turn\'s folder)', async () => {
  const s = presenceSetup();
  try {
    const absolute = path.join(s.workspace, 'src', 'app.ts');
    const fake = appServer((child, threadId) => {
      const item = (method: string, body: Record<string, unknown>) => child.send({ method, params: { threadId, turnId: 'turn_1', item: body } });
      item('item/started', { id: 'fc_1', type: 'fileChange', status: 'inProgress', changes: [{ path: absolute, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }, { path: 'docs/new.md', kind: { type: 'add' } }] });
      item('item/completed', { id: 'fc_1', type: 'fileChange', status: 'completed', changes: [{ path: absolute, kind: { type: 'update' } }] });
      const patch = '*** Begin Patch\n*** Update File: lib/util.ts\n@@\n-x\n+y\n*** Add File: lib/added.ts\n+new\n*** End Patch';
      item('item/started', { id: 'sh_1', type: 'commandExecution', command: `apply_patch <<'EOF'\n${patch}\nEOF`, cwd: path.join(s.workspace, 'pkg') });
      item('item/completed', { id: 'sh_1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'Done' });
      child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
    });
    const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: s.workspace, version: '0.2.0' });
    const runId = s.turn('ag_ada');
    const { input, events } = turnInput({ runId, agentId: 'ag_ada', cwd: s.workspace });
    await engine.run(input);
    await engine.dispose();
    for (const event of events as EngineEvent[]) s.journalEvent(runId, event);
    assert.deepEqual(kinds(s, 'ag_ada'), ['edit pkg/lib/util.ts', 'edit src/app.ts', 'edit docs/new.md', 'write pkg/lib/added.ts'].sort());
    assert.equal(s.presence.ledger.recentChanges()[0].runId, runId);
  } finally { s.cleanup(); }
});

test('Claude Code: Edit, a long Write (cut preview), MultiEdit, NotebookEdit and Read tool_use reach the ledger with their kind', () => {
  const s = presenceSetup();
  try {
    const runId = s.turn('ag_bob');
    const events: EngineEvent[] = [];
    const parser = new ClaudeStreamParser((event) => events.push(event), () => s.clock.now());
    const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
    parser.push({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [
      use('t1', 'Edit', { file_path: path.join(s.workspace, 'src', 'app.ts'), old_string: 'a', new_string: 'b' }),
      use('t2', 'Write', { file_path: path.join(s.workspace, 'README.md'), content: 'x'.repeat(5000) }),
      use('t3', 'MultiEdit', { file_path: path.join(s.workspace, 'src', 'b.ts'), edits: [{ old_string: 'a', new_string: 'b' }] }),
      use('t4', 'NotebookEdit', { notebook_path: path.join(s.workspace, 'nb.ipynb'), new_source: 'print(1)' }),
      use('t5', 'Read', { file_path: path.join(s.workspace, 'src', 'c.ts') }),
      use('t6', 'Bash', { command: 'echo hi > out.txt' }),
      use('t7', 'mcp__workforce__files__read', { path: 'src/d.ts' }),
    ] } });
    for (const event of events) s.journalEvent(runId, event);
    const write = s.journal.items(runId).find((item) => item.name === 'Write');
    assert.ok(typeof write?.data.args === 'string' && (write.data.args as string).endsWith('…'), 'the long Write arrived cut');
    assert.deepEqual(kinds(s, 'ag_bob'), ['edit nb.ipynb', 'edit src/app.ts', 'edit src/b.ts', 'read src/c.ts', 'write README.md'].sort(),
      'no guess from a shell command; our files.read (through the hub) records itself');
  } finally { s.cleanup(); }
});

test('ACP: an edit names its files through locations (paths), a read is a read; hub tools and other kinds are skipped', () => {
  const s = presenceSetup();
  try {
    const runId = s.turn('ag_cy');
    const events: EngineEvent[] = [];
    const state = newTurnState();
    applyUpdate(state, { sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'edit', title: 'Edit app.ts', status: 'pending', locations: [{ path: path.join(s.workspace, 'src', 'app.ts') }], rawInput: { old_string: 'a', new_string: 'b' } }, (event) => events.push(event));
    applyUpdate(state, { sessionUpdate: 'tool_call', toolCallId: 'c2', kind: 'read', title: 'Read notes', rawInput: { file_path: path.join(s.workspace, 'notes.md') } }, (event) => events.push(event));
    applyUpdate(state, { sessionUpdate: 'tool_call', toolCallId: 'c3', kind: 'execute', title: 'npm test', rawInput: { command: 'npm test' } }, (event) => events.push(event));
    const start = events.find((event) => event.type === 'tool_start' && event.callId === 'c1') as Extract<EngineEvent, { type: 'tool_start' }>;
    assert.deepEqual((start.args as Record<string, unknown>).paths, [path.join(s.workspace, 'src', 'app.ts')]);
    assert.equal((start.args as Record<string, unknown>).old_string, 'a', 'the raw input is kept');
    for (const event of events) s.journalEvent(runId, event);
    assert.deepEqual(kinds(s, 'ag_cy'), ['edit src/app.ts', 'read notes.md']);
  } finally { s.cleanup(); }
});

test('the tap: only engine-own tool_call rows; a re-emitted row records nothing new', () => {
  const s = presenceSetup();
  try {
    const runId = s.turn('ag_ada');
    s.journal.item(runId, { kind: 'tool_call', name: 'files.write', effectStatus: 'none', data: { callId: 'x1', args: JSON.stringify({ path: 'a.ts', content: 'x' }) } });
    s.journal.item(runId, { kind: 'tool_result', name: 'Edit', effectStatus: 'none', data: { callId: 'x2', own: true, args: '{"file_path":"a.ts"}' } });
    assert.equal(s.presence.ledger.size, 0, 'ours record themselves; results are no calls');
    const row = s.journalEvent(runId, { type: 'tool_start', callId: 'e1', name: 'Edit', own: true, args: { file_path: 'src/a.ts' } })!;
    const first = s.presence.ledger.recentChanges()[0].at;
    s.clock.advance(5 * MIN);
    s.journal.updateItem(row.id, { data: { note: 'settled' } }); // re-emits 'run.item'
    assert.equal(s.presence.ledger.recentChanges()[0].at, first, 'timed by the row, not by the event');
  } finally { s.cleanup(); }
});

test('run.upserted: running turns, the overlap note at the end of a turn, summary()', () => {
  const s = presenceSetup();
  try {
    const ada = s.turn('ag_ada');
    assert.equal(s.presence.ledger.isRunning(ada), true);
    s.journalEvent(ada, { type: 'tool_start', callId: 'a1', name: 'Edit', own: true, args: { file_path: path.join(s.workspace, 'src', 'app.ts') } });
    s.clock.advance(MIN);
    const bob = s.turn('ag_bob');
    s.journalEvent(bob, { type: 'tool_start', callId: 'b1', name: 'Write', own: true, args: { file_path: 'src/app.ts', content: 'all new' } });
    const summary = s.presence.summary();
    assert.deepEqual(summary.map((item) => [item.agentName, item.path, item.kind, item.running]), [['Bob', 'src/app.ts', 'write', true], ['Ada', 'src/app.ts', 'edit', true]]);
    s.end(bob);
    assert.equal(s.presence.ledger.isRunning(bob), false);
    assert.deepEqual(s.presence.ledger.takeNotes('ag_bob'), [], "Ada's change came before Bob's turn");
    s.end(ada);
    assert.deepEqual(s.presence.ledger.takeNotes('ag_ada').map((note) => note.byName), ['Bob']);
  } finally { s.cleanup(); }
});

test('touchesOf: cut previews keep their path keys and patch files; unknown tools touch nothing', () => {
  assert.deepEqual(touchesOf('Write', '{"file_path":"C:\\\\w\\\\a.ts","content":"xxxx…'), [{ path: 'C:\\w\\a.ts', kind: 'write' }]);
  assert.deepEqual(touchesOf('apply_patch', '{"files":["a.ts","b.ts"'), [{ path: 'a.ts', kind: 'edit' }, { path: 'b.ts', kind: 'edit' }]);
  assert.deepEqual(touchesOf('shell', '{"command":"apply_patch <<\'EOF\'\\n*** Begin Patch\\n*** Delete File: old.ts\\n*** Update File: x.ts\\n*** Move to: y.ts\\n@@ cut…'), [
    { path: 'old.ts', kind: 'edit' }, { path: 'x.ts', kind: 'edit' }, { path: 'y.ts', kind: 'edit' },
  ]);
  assert.deepEqual(touchesOf('shell', { command: 'git status', cwd: '/w' }), []);
  assert.deepEqual(touchesOf('Edit', { file_path: 'a.ts' }).concat(touchesOf('Read', {})), [{ path: 'a.ts', kind: 'edit' }]);
  assert.deepEqual(touchesOf('web_search', { query: 'x' }), []);
  assert.deepEqual(touchesOf(undefined, {}), []);
});
