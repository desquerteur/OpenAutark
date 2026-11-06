// B-048 E1 capture: one real engine attempt (agents/turn-attempt.ts with a scripted fake engine) on a real run
// journal – the chat line the input shows becomes m<seq> first, then reasoning (r), commentary (a), an
// engine-native call with its full tool_end.output (t, kept whole in a blob), our calls through the registry's
// journal (t, skills.load → s, files.read → f) and the final answer (a), in the turn's order, with the attempt's
// engine and model as origin. A run nobody attached is not captured; a finished run is let go.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAttempt } from '../../../src/runtime/agents/turn-attempt.ts';
import { journalAnswer } from '../../../src/runtime/agents/publishing.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { ContextLedgerService } from '../../../src/runtime/context/ledger/service.ts';
import { journalResult } from '../../../src/runtime/tools/journal.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { TurnPlan } from '../../../src/runtime/agents/turn-types.ts';
import { setup } from '../agents/fixture.ts';
import { tempDir } from '../store/helpers.ts';
import { keepFor, redact } from './ledger-fixture.ts';

function wired() {
  const h = setup();
  const dir = tempDir('wf-ledger-capture-');
  const files = new Blobs({ db: h.db, blobs: dir.dir, clock: h.clock, log: h.services.log });
  let ledger: ContextLedgerService | undefined;
  const journal = new Journal({ db: h.db, bus: h.bus, clock: h.clock, keepOutput: keepFor(files, () => ledger) });
  Object.assign(h.services, { runs: journal, files, secrets: { redact } });
  ledger = new ContextLedgerService({ services: () => h.services });
  (h.services as RuntimeServices).ledger = ledger;
  const stop = ledger.start();
  return { ...h, files, journal, ledger, cleanup: () => { stop(); dir.cleanup(); } };
}

const ours = (h: ReturnType<typeof wired>, runId: string, name: string, args: Record<string, unknown>, text: string, callId: string) => {
  h.journal.item(runId, { kind: 'tool_call', name, data: { callId, args: JSON.stringify(args), summary: `${name} ${Object.values(args).join(' ')}` }, effectStatus: 'none', idemKey: `${runId}:${callId}` });
  journalResult(h.services, runId, name, callId, `${runId}:${callId}`, { content: [{ type: 'text', text }] }, []);
};

test('one attempt: m, r, a, native t with its full output, ours as t/s/f, the answer – in order, with origin', async () => {
  const h = wired();
  try {
    const asked = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Please check the build and the deploy skill.' });
    h.journal.start({ id: 'run_1', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
    const plan = { agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, memberCursor: 0, focus: '' } as unknown as TurnPlan;
    const log = 'npm test\n' + 'ok '.repeat(3000) + '\nsk-abcdef123456 leaked';
    h.state.script = async (input) => {
      input.onEvent({ type: 'reasoning', delta: 'Checking the build first.', id: 'rs_1' });
      input.onEvent({ type: 'reasoning_end', id: 'rs_1' });
      input.onEvent({ type: 'commentary', text: 'Running the tests now.' });
      input.onEvent({ type: 'tool_start', callId: 'c1', name: 'shell', args: { command: 'npm test' }, own: true });
      input.onEvent({ type: 'tool_end', callId: 'c1', ok: true, summary: 'exit 0', output: log });
      ours(h, 'run_1', 'skills.load', { name: 'deploy' }, '# Skill: deploy\n' + 'step '.repeat(1200), 'c2');
      ours(h, 'run_1', 'files.read', { path: 'docs/notes.md' }, 'notes', 'c3');
      ours(h, 'run_1', 'chat.read', { limit: 5 }, 'lines', 'c4');
      return { text: 'The build passes.', stop: 'done' };
    };
    const attempt = await runAttempt(h.services, plan, { ...h.routed(), lastSeq: asked.seq }, h.request(), undefined);
    assert.equal(attempt.result.stop, 'done');
    journalAnswer(h.services, 'run_1', 'The build passes.', 'notify');
    await h.journal.settled();

    const items = h.ledger.items(h.tom.id, h.chat.id);
    assert.deepEqual(items.map((item) => item.itemId), [`m${asked.seq}`, 'r1', 'a2', 't3', 's4', 'f5', 't6', 'a7']);
    assert.deepEqual(items.map((item) => item.kind), ['message', 'reasoning', 'assistant', 'tool', 'skill', 'file', 'tool', 'assistant']);
    assert.ok(items.every((item) => item.runId === 'run_1'));
    assert.deepEqual(items[3].origin, { engine: 'claude', model: 'claude:claude-opus-5-5' }, 'the attempt\'s engine and model');
    assert.match(items[0].title, /Please check the build/);
    assert.match(items[3].title, /^shell: Ran npm test/);
    assert.equal(items[4].title, 'Skill deploy');
    assert.equal(items[5].title, 'File docs/notes.md');
    assert.ok(items[3].tokens > 2000, 'the native output counts');

    const native = h.ledger.original(h.tom.id, h.chat.id, 't3')!;
    assert.equal(native.pruned, false);
    assert.equal(native.text.length, redact(log).length, 'the whole engine-native output, kept in a blob');
    assert.ok(native.text.includes('secret://key') && !native.text.includes('sk-abcdef123456'), 'redacted before it is kept');
    assert.equal(h.ledger.original(h.tom.id, h.chat.id, 's4')!.text.length, '# Skill: deploy\n'.length + 'step '.repeat(1200).length, 'our long output whole');
    assert.equal(h.ledger.original(h.tom.id, h.chat.id, 'r1')!.text, 'Checking the build first.');
    assert.equal(h.ledger.original(h.tom.id, h.chat.id, 'a7')!.text, 'The build passes.');
    assert.equal(h.ledger.original(h.tom.id, h.chat.id, `m${asked.seq}`)!.text, 'Please check the build and the deploy skill.');
    assert.equal(h.ledger.original(h.tom.id, h.chat.id, 't99'), undefined);
  } finally { h.cleanup(); }
});

test('the agent\'s own chat message is not recorded again once its run left its words; messages beyond the window are not', async () => {
  const h = wired();
  try {
    h.journal.start({ id: 'run_1', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
    const first = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'hi' });
    h.ledger.capture({ runId: 'run_1', agentId: h.tom.id, conversationId: h.chat.id, engine: 'codex', model: 'm', seenSeq: first.seq });
    journalAnswer(h.services, 'run_1', 'Hello Alex', 'notify');
    const reply = h.chats.postAgentMessage(h.chat.id, h.tom.id, 'run_1', { body: 'Hello Alex' });
    h.journal.finish('run_1', { status: 'done' });
    assert.equal(h.ledger.attached('run_1'), undefined, 'a finished run is let go');
    h.journal.item('run_1', { kind: 'note', name: 'Answer', data: { answer: true, text: 'late' }, effectStatus: 'none' });
    const next = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'thanks' });
    h.journal.start({ id: 'run_2', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
    h.ledger.capture({ runId: 'run_2', agentId: h.tom.id, conversationId: h.chat.id, engine: 'codex', model: 'm', seenSeq: next.seq });
    let ids = h.ledger.items(h.tom.id, h.chat.id).map((item) => item.itemId);
    assert.deepEqual(ids, [`m${first.seq}`, 'a1', `m${next.seq}`], 'own reply skipped: its run left an a item; nothing for a run that ended');
    assert.ok(reply.seq > first.seq && reply.seq < next.seq);
    for (let i = 0; i < 70; i++) h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: `line ${i}` });
    const last = h.chats.messages(h.chat.id, { limit: 1 })[0];
    h.journal.start({ id: 'run_3', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
    h.ledger.capture({ runId: 'run_3', agentId: h.tom.id, conversationId: h.chat.id, engine: 'codex', model: 'm', seenSeq: last.seq });
    ids = h.ledger.items(h.tom.id, h.chat.id).map((item) => item.itemId);
    assert.equal(ids.filter((id) => id.startsWith('m')).length, 2 + 60, 'the newest 60 lines, as the delta shows them');
    assert.equal(ids.at(-1), `m${last.seq}`);
  } finally { h.cleanup(); }
});

test('a run nobody attached is not captured, and its long outputs add no blobs', async () => {
  const h = wired();
  try {
    h.journal.start({ id: 'run_x', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'task' });
    h.journal.item('run_x', { kind: 'note', name: 'Answer', data: { answer: true, text: 'hello' }, effectStatus: 'none' });
    const result = h.journal.item('run_x', { kind: 'tool_result', data: { callId: 'c1', ok: true, summary: 'exit 0', output: 'x'.repeat(9_000) }, effectStatus: 'none' });
    await h.journal.settled();
    assert.deepEqual(h.ledger.items(h.tom.id, h.chat.id), []);
    assert.equal(h.journal.items('run_x').find((item) => item.id === result.id)!.data.outputBlob, undefined);
    assert.equal(result.data.outputChars, 9_000, 'the row still knows the full length');
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM files')!.n, 0);
  } finally { h.cleanup(); }
});
