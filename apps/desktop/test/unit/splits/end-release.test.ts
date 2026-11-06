// B-057 – a part's native session goes as soon as the part ends for good, not only when its group is gathered or
// stopped: done, failed after its last attempt, stopped by the person (once its lane's late end saved it again) or
// stopped while a retry waited – its engine unloads it (a Codex app-server thread) while the siblings still run. A
// retryable end keeps it (the retry resumes it). The results stay readable: agents.split_results and the parent's
// block read the run journal only. The boot recovery releases what a crash left of parts that had ended.
// Owns: these checks. Never: an engine, git or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { splitThread } from '../../../src/shared/model/splits.ts';
import type { EngineId } from '../../../src/shared/model/providers.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { CHAT, part, splitAndEnd, world, type World } from './fixture.ts';

const bind = (w: World, splitId: string, ref = `thr_${splitId}`) => new SessionStore(w.db).save({
  agentId: 'ag_ava', conversationId: splitThread(splitId), engine: 'codex', accountId: 'acc_1', ref, generation: 1, cursorSeq: 0, updatedAt: w.clock.now(),
});
const bound = (w: World, splitId: string) => w.db.all('SELECT 1 FROM engine_sessions WHERE conversation_id = ?', [splitThread(splitId)]).length;

/** A world whose Codex engine records every unload. */
function unloading() {
  const w = world();
  const unloaded: string[] = [];
  const codex = { unload: async (_account: { id: string }, ref: string) => { unloaded.push(ref); } };
  Object.assign(w.services, {
    engines: { get: (id: EngineId) => (id === 'codex' ? codex : {}) as unknown as Engine },
    accounts: { get: (id: string) => ({ id }), list: () => [] },
  });
  return { w, unloaded };
}

test('a part that ended done or failed for good leaves its engine at once; a retryable end keeps its session for the retry', () => {
  const { w, unloaded } = unloading();
  const groupId = splitAndEnd(w, [part('A'), part('B'), part('C')]);
  const [a, b, c] = w.lanes.started;
  for (const id of [a, b, c]) bind(w, id);
  w.lanes.end(a, 'done', { answer: 'A found three issues.' });
  assert.deepEqual([bound(w, a), bound(w, b), bound(w, c)], [0, 1, 1], 'A ended; B and C still run');
  assert.deepEqual(unloaded, [`thr_${a}`]);

  w.lanes.end(b, 'failed', { retryable: true, error: 'The provider is busy.' });
  assert.equal(w.splits.get(b)!.split.status, 'running', 'its retry started');
  assert.equal(bound(w, b), 1, 'the retry resumes its session');
  w.lanes.end(b, 'failed', { retryable: true, error: 'Still busy.' }); // its last attempt
  assert.equal(w.splits.get(b)!.split.status, 'failed');
  assert.equal(bound(w, b), 0);
  assert.deepEqual(unloaded, [`thr_${a}`, `thr_${b}`]);
  assert.equal(w.splits.list({ groupId })[0].status, 'running', 'part C still works');

  // The results are the journal's: still whole after the sessions went.
  assert.match(w.splits.results('ag_ava', { groupId, idx: 1 }), /A found three issues\./);
  w.lanes.end(c, 'done', { answer: 'C is fine.' });
  const block = w.splits.pendingResults('ag_ava', CHAT)?.text ?? '';
  assert.match(block, /A found three issues\./);
  assert.match(block, /#2 B – failed – Still busy\./);
  assert.match(block, /C is fine\./);
});

test('the person\'s stop of one part: a running part goes when its lane\'s late end arrives, a waiting retry at once', () => {
  const { w, unloaded } = unloading();
  splitAndEnd(w, [part('A'), part('B'), part('C')]);
  const [a, b, c] = w.lanes.started;
  bind(w, a);
  w.lanes.answers.push(...Array<'busy'>(10).fill('busy')); // B's retry finds no free lane: it waits, queued
  w.lanes.end(b, 'failed', { retryable: true, error: 'The provider is busy.' });
  bind(w, b, 'thr_b1'); // the ended attempt's session
  assert.equal(w.splits.get(b)!.split.status, 'queued');

  assert.equal(w.splits.stop({ splitId: a }, HUMAN_ID), 1);
  assert.equal(bound(w, a), 1, 'its turn is still being aborted on its lane');
  bind(w, a, 'thr_a2'); // the aborted turn's finish saves its session once more
  w.lanes.end(a, 'stopped');
  assert.equal(bound(w, a), 0, 'gone with the late end');

  assert.equal(w.splits.stop({ splitId: b }, HUMAN_ID), 1);
  assert.equal(bound(w, b), 0, 'a waiting retry\'s session goes at once');
  assert.deepEqual(unloaded, ['thr_a2', 'thr_b1']);
  assert.equal(w.splits.get(c)!.split.status, 'running', 'the sibling runs on');
});

test('boot recovery releases what a crash left of parts that had ended while their group still runs', () => {
  const w = world();
  splitAndEnd(w, [part('A'), part('B')]);
  const [a, b] = w.lanes.started;
  w.lanes.end(a, 'done', { answer: 'A' });
  bind(w, a); // the app stopped before the release reached the database
  bind(w, b);
  const after = w.restart();
  after.splits.reconcile();
  assert.equal(bound(w, a), 0);
  assert.equal(bound(w, b), 1, 'a part that runs again keeps its session');
});
