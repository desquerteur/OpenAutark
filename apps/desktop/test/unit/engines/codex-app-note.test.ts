// H1 – the Codex app note (engines/codex/app-note.ts) over a scripted app-server: Codex adds its own multi-agent notes
// with the thread (thread/start, a fork, a compacted history), after this app's instructions, so the note is never in
// the thread's instructions but a text item of the turn input – after the context block, before the turn's own input –
// on the first turn of a thread this process opened (start, resume, fork) and the first after Codex compacted it; never
// on the turns between, never on a helper turn, never without a team tool. The text names only the offered team tools
// and nothing about a request's topic.
// Owns: nothing in production. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { TEAM_TOOLS, appNote, appNoteItem } from '../../../src/runtime/engines/codex/app-note.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';

const spec = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const MANAGER_TOOLS = ['tasks.create', 'agents.create', 'agents.delegate', 'files.read'].map(spec);

/** A scripted app-server; `compactNext.value` makes the next turn report a contextCompaction item. */
function appServer(compactNext = { value: false }) {
  const requests: any[] = [];
  let threads = 0;
  let forks = 0;
  let turns = 0;
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (msg.id === undefined) return;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'workforce/0.165.0 (Windows)' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/resume': child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } }); break;
        case 'thread/fork': child.send({ id: msg.id, result: { thread: { id: `thr_fork_${++forks}`, forkedFromId: msg.params.threadId }, cwd: msg.params.cwd, model: 'gpt-test' } }); break;
        case 'thread/unsubscribe': case 'thread/backgroundTerminals/clean': child.send({ id: msg.id, result: {} }); break;
        case 'turn/start': {
          const id = `turn_${++turns}`;
          const threadId = msg.params.threadId;
          child.send({ id: msg.id, result: { turn: { id, status: 'inProgress' } } });
          if (compactNext.value) { compactNext.value = false; child.send({ method: 'item/completed', params: { threadId, turnId: id, item: { id: `c${turns}`, type: 'contextCompaction' } } }); }
          child.send({ method: 'item/completed', params: { threadId, turnId: id, item: { id: `m${turns}`, type: 'agentMessage', text: 'ok' } } });
          child.send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
          break;
        }
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, requests, sent: (method: string) => requests.filter((r) => r.method === method) };
}

const engineOf = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });
const isNote = (item: any) => typeof item?.text === 'string' && item.text.startsWith('App note: ');
const notes = (params: any) => params.input.filter(isNote).length;

test('the note: names the offered team tools, says what Codex\'s note is about, nothing about a topic; none without a team tool', () => {
  const full = appNote(MANAGER_TOOLS);
  assert.equal(full, "App note: agents.create, agents.delegate and tasks.create are this app's own tools for the person's team of lasting colleagues, not Codex sub-agents. The multi-agent note above is only about Codex's own spawn_agent tools – I use this app's tools whenever the work calls for them.");
  assert.ok(full.length < 300, `short: ${full.length} characters`);
  assert.doesNotMatch(full, /set ?up|einricht|onboard|first run|hire|social|newsletter|book|café|everything/i, 'general: no topic, no recipe');
  assert.equal(appNote([spec('tasks.create'), spec('web.fetch')]), "App note: tasks.create is this app's own tool for the person's team of lasting colleagues, not Codex sub-agents. The multi-agent note above is only about Codex's own spawn_agent tools – I use this app's tools whenever the work calls for them.");
  assert.equal(appNote([spec('web.fetch'), spec('files.read')]), '', 'no team tool: no note');
  assert.equal(appNote([]), '');
  assert.deepEqual(TEAM_TOOLS, ['agents.create', 'agents.delegate', 'tasks.create']);
  assert.deepEqual(appNoteItem(''), []);
  assert.deepEqual(appNoteItem('App note: x'), [{ type: 'text', text: 'App note: x', text_elements: [] }]);
});

test("a new thread: the note is in the first turn's input (after Codex's own notes), never in the thread's instructions; later turns go without it", async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  const first = await e.run(turnInput({ tools: MANAGER_TOOLS, system: { stable: 'STABLE', volatile: 'VOLATILE' }, input: [{ type: 'text', text: 'Alles einrichten' }] }).input);
  assert.equal(first.stop, 'done');
  const [start] = fake.sent('thread/start');
  for (const key of ['baseInstructions', 'developerInstructions']) assert.ok(!String(start.params[key]).includes('App note'), `${key}: before Codex's note – not there`);
  const input = fake.sent('turn/start')[0].params.input;
  assert.equal(input.length, 2);
  assert.ok(isNote(input[0]), 'first item of the turn input');
  assert.deepEqual(input[0], { type: 'text', text: appNote(MANAGER_TOOLS), text_elements: [] });
  assert.deepEqual(input[1], { type: 'text', text: 'Alles einrichten', text_elements: [] }, "the person's input follows unchanged");

  for (const runId of ['run_2', 'run_3']) {
    await e.run(turnInput({ runId, tools: MANAGER_TOOLS, session: { ref: 'thr_1', generation: 1 }, system: { stable: 'STABLE', volatile: 'V2' } }).input);
  }
  assert.deepEqual(fake.sent('turn/start').slice(1).map((t) => notes(t.params)), [0, 0], 'once per thread, not per turn');
  await e.dispose();
});

test('after Codex compacted the thread, its next turn carries the note again (after the context block) – once', async () => {
  const compactNext = { value: false };
  const fake = appServer(compactNext);
  const e = engineOf(fake.spawn);
  await e.run(turnInput({ tools: MANAGER_TOOLS }).input);
  compactNext.value = true;
  const compacted = await e.run(turnInput({ runId: 'run_2', tools: MANAGER_TOOLS, session: { ref: 'thr_1', generation: 1 } }).input);
  assert.equal(compacted.compacted, true);
  await e.run(turnInput({ runId: 'run_3', tools: MANAGER_TOOLS, session: { ref: 'thr_1', generation: 1 }, system: { stable: 'S', volatile: 'AFTER' } }).input);
  await e.run(turnInput({ runId: 'run_4', tools: MANAGER_TOOLS, session: { ref: 'thr_1', generation: 1 } }).input);
  const turns = fake.sent('turn/start');
  assert.deepEqual(turns.map((t) => notes(t.params)), [1, 0, 1, 0]);
  const after = turns[2].params.input;
  assert.match(after[0].text, /^<workforce-context>\nAFTER/);
  assert.ok(isNote(after[1]), 'after the context block');
  assert.equal(after[2].text, 'hello');
  await e.dispose();
});

test('a thread resumed after a restart and a forked thread carry the note on their first turn', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await e.run(turnInput({ tools: MANAGER_TOOLS, session: { ref: 'thr_old', generation: 2 }, system: { stable: 'S', volatile: 'RESUMED' } }).input);
  assert.equal(fake.sent('thread/resume').length, 1);
  const resumed = fake.sent('turn/start')[0].params.input;
  assert.match(resumed[0].text, /^<workforce-context>\nRESUMED/);
  assert.ok(isNote(resumed[1]));
  await e.run(turnInput({ runId: 'run_2', tools: MANAGER_TOOLS, session: { ref: 'thr_old', generation: 2 } }).input);
  assert.equal(notes(fake.sent('turn/start')[1].params), 0, 'loaded now: no note');

  const fork = await e.fork({ runId: 'run_w', agentId: 'ag_1', account: account(), parentRef: 'thr_old', cwd: '/work', model: 'gpt-test' });
  await e.run(turnInput({ runId: 'run_w', tools: MANAGER_TOOLS, session: { ref: fork.ref, generation: 1 }, system: { stable: 'S', volatile: 'split #2' } }).input);
  const forked = fake.sent('turn/start')[2].params;
  assert.equal(forked.threadId, fork.ref);
  assert.ok(isNote(forked.input[1]), 'after the split context');
  await e.dispose();
});

test('no note on a helper turn (no tools) or an agent turn without a team tool', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await e.run(turnInput({ tools: [] }).input);
  await e.run(turnInput({ runId: 'run_2', tools: [spec('files.read'), spec('web.fetch')] }).input);
  assert.deepEqual(fake.sent('turn/start').map((t) => notes(t.params)), [0, 0]);
  await e.dispose();
});
