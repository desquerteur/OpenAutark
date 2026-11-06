// B-048 E2 (TRANSFER) – superseded native sessions: SessionStore records a replaced or removed ref (never the same
// ref saved again) and tells the bind listeners of a new ref; SessionSweep deletes a recorded session only after
// the agent finished a turn in that chat after it AND 24 h passed, not while the ref is bound again or a turn of
// the agent runs, keeps waiting for an unusable account, drops records of engines without deleteSession and after
// 3 failed attempts – started once and on every new binding (no timer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../chat/harness.ts';
import { SessionStore, SUPERSEDED_NS, onSessionBound, type SessionBinding, type SupersededSession } from '../../../src/runtime/agents/sessions.ts';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { KEEP_SUPERSEDED_MS, ORPHAN_AGE_MS, SessionSweep, transcriptFiles } from '../../../src/runtime/agents/session-sweep.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';
import type { Account, EngineId } from '../../../src/shared/model/providers.ts';

const binding = (patch: Partial<SessionBinding> = {}): SessionBinding => ({
  agentId: 'ag_1', conversationId: 'c_1', engine: 'codex', accountId: 'acc_codex', ref: 'thr_1', generation: 1, cursorSeq: 0, updatedAt: 1000, ...patch,
});

function setup() {
  const h = harness();
  const store = new SessionStore(h.db);
  const kv = new KvRepo(h.db);
  const deleted: string[] = [];
  const state: { fail?: boolean; account: Partial<Account> } = { account: {} };
  const codex = {
    id: 'codex',
    deleteSession: async (_account: Account, ref: string) => { if (state.fail) throw new Error('server busy'); deleted.push(ref); return 'deleted' as const; },
  } as unknown as Engine;
  const acp = { id: 'acp' } as unknown as Engine;
  const accounts = () => [{ id: 'acc_codex', provider: 'codex', enabled: true, state: 'ok', ...state.account } as Account];
  const sweep = new SessionSweep({ db: h.db, clock: h.clock, engine: (id) => (id === 'codex' ? codex : id === 'acp' ? acp : undefined), accounts });
  const records = () => kv.list<SupersededSession>(SUPERSEDED_NS).map((entry) => entry.value);
  const run = (id: string, status: string, endedAt?: number, agentId = 'ag_1', conversationId: string | null = 'c_1') =>
    h.db.run('INSERT INTO runs (id, agent_id, conversation_id, trigger, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, agentId, conversationId, 'message', status, endedAt ?? h.clock.now(), endedAt ?? null]);
  return { ...h, store, kv, deleted, state, sweep, records, run };
}

test('sessions: a replaced or removed ref is recorded as superseded; the same ref saved again is not; listeners hear only new refs', () => {
  const h = setup();
  const heard: string[] = [];
  const off = onSessionBound(h.db, (bound) => heard.push(bound.ref));
  h.store.save(binding());
  h.store.save(binding({ cursorSeq: 4, updatedAt: 2000 }));
  assert.deepEqual(h.records(), []);
  h.store.save(binding({ ref: 'thr_2', accountId: 'acc_other', updatedAt: 3000 })); // e.g. an account switch on the same engine
  assert.deepEqual(h.records(), [{ agentId: 'ag_1', conversationId: 'c_1', engine: 'codex', ref: 'thr_1', at: 3000, accountId: 'acc_codex' }]);
  h.store.remove('ag_1', 'c_1', 'codex', 5000);
  assert.deepEqual(h.records().map((record) => [record.ref, record.at]), [['thr_1', 3000], ['thr_2', 5000]]);
  h.store.save(binding({ ref: 'thr_3', engine: 'claude' }));
  h.store.remove('ag_1', 'c_1', 'claude'); // without a time: the row's last update
  assert.equal(h.records().find((record) => record.ref === 'thr_3')?.at, 1000);
  assert.deepEqual(heard, ['thr_1', 'thr_2', 'thr_3']);
  off();
  h.store.save(binding({ ref: 'thr_4' }));
  assert.deepEqual(heard, ['thr_1', 'thr_2', 'thr_3']);
});

test('sweep: deleted only after the agent finished a turn in that chat after it AND 24 h passed', async () => {
  const h = setup();
  h.store.save(binding({ updatedAt: h.clock.now() }));
  h.store.remove('ag_1', 'c_1', 'codex', h.clock.now());
  const at = h.clock.now();

  h.clock.advance(KEEP_SUPERSEDED_MS + 1);
  await h.sweep.sweep();
  assert.deepEqual(h.deleted, [], 'no finished turn after it yet');
  h.run('run_old', 'done', at - 1);
  h.run('run_other_chat', 'done', at + 10, 'ag_1', 'c_2');
  h.run('run_failed', 'failed', at + 10);
  await h.sweep.sweep();
  assert.deepEqual(h.deleted, [], 'a done turn before, in another chat or a failed one does not count');

  h.clock.set(at + 1000);
  h.run('run_next', 'done', at + 500);
  await h.sweep.sweep();
  assert.deepEqual(h.deleted, [], 'not within 24 h');
  h.clock.set(at + KEEP_SUPERSEDED_MS);
  await h.sweep.sweep();
  assert.deepEqual(h.deleted, ['thr_1']);
  assert.deepEqual(h.records(), [], 'the record goes once deleted');
});

test('sweep: a ref bound again drops its record; a running turn and an unusable account wait; engines without deleteSession and 3 failures drop it', async () => {
  const h = setup();
  const supersede = (ref: string, engine: EngineId = 'codex') => {
    h.kv.set(SUPERSEDED_NS, `${engine}:acc_codex:${ref}`, { agentId: 'ag_1', conversationId: 'c_1', engine, accountId: 'acc_codex', ref, at: h.clock.now() } satisfies SupersededSession, h.clock.now());
  };
  supersede('thr_bound');
  h.store.save(binding({ ref: 'thr_bound', agentId: 'ag_2' }));
  supersede('thr_wait');
  supersede('acp_s1', 'acp');
  h.run('run_done', 'done', h.clock.now() + 1);
  h.clock.advance(KEEP_SUPERSEDED_MS + 10);

  h.run('run_live', 'running');
  h.state.account = { state: 'needs_login' };
  await h.sweep.sweep();
  assert.deepEqual(h.records().map((record) => record.ref).sort(), ['acp_s1', 'thr_wait'], 'bound again: not superseded any more');
  assert.deepEqual(h.deleted, [], 'a running turn of the agent waits');

  h.db.run(`UPDATE runs SET status = 'done', ended_at = ? WHERE id = 'run_live'`, [h.clock.now()]);
  await h.sweep.sweep();
  assert.deepEqual(h.deleted, [], 'a signed-out account waits');
  assert.ok(!h.records().some((record) => record.ref === 'acp_s1'), 'an engine without deleteSession keeps its sessions; the record goes');

  h.state.account = {};
  h.state.fail = true;
  await h.sweep.sweep();
  await h.sweep.sweep();
  assert.equal(h.records().find((record) => record.ref === 'thr_wait')?.attempts, 2);
  await h.sweep.sweep();
  assert.deepEqual(h.records(), [], 'dropped after 3 failed attempts (the provider\'s own retention applies)');
});

test('sweep (B-048 review, privacy): an hour-old transcript of the app that no row binds and no record names goes; bound, recorded and young ones stay', async () => {
  const h = setup();
  const dir = path.resolve('/fake-data/engine-transcripts/claude');
  const file = (n: number) => path.join(dir, `00000000-0000-4000-8000-${String(n).padStart(12, '0')}.jsonl`);
  const removed: string[] = [];
  const listed = [
    { file: file(1), at: h.clock.now() - ORPHAN_AGE_MS }, // bound
    { file: file(2), at: h.clock.now() - ORPHAN_AGE_MS }, // superseded, waiting for its successor
    { file: file(3), at: h.clock.now() - ORPHAN_AGE_MS }, // its row went by SQL (a Forget, a purge, a deleted chat)
    { file: file(4), at: h.clock.now() - 1000 }, // just written (a rebuild binds it, a probe deletes it)
  ];
  const sweep = new SessionSweep({
    db: h.db, clock: h.clock, engine: () => undefined, accounts: () => [],
    transcripts: { list: async () => listed, remove: async (entry) => { removed.push(entry); } },
  });
  h.store.save(binding({ engine: 'claude', ref: file(1) }));
  h.store.save(binding({ engine: 'claude', ref: file(2), agentId: 'ag_2' }));
  h.store.save(binding({ engine: 'claude', ref: file(9), agentId: 'ag_2' })); // file(2) is superseded now
  h.store.save(binding({ engine: 'claude', ref: file(3), agentId: 'ag_3' }));
  h.db.run(`DELETE FROM engine_sessions WHERE agent_id = 'ag_3'`); // like forget.ts and native-history.ts
  await sweep.sweep();
  assert.deepEqual(removed, [file(3)]);

  // On disk: only `<session id>.jsonl` files directly in the folder are listed; a missing folder lists none.
  const tmp = mkdtempSync(path.join(tmpdir(), 'wf-transcripts-'));
  try {
    writeFileSync(path.join(tmp, '00000000-0000-4000-8000-000000000001.jsonl'), '{}\n');
    writeFileSync(path.join(tmp, 'notes.jsonl'), '{}\n');
    mkdirSync(path.join(tmp, '00000000-0000-4000-8000-000000000002.jsonl'));
    const disk = transcriptFiles(tmp);
    assert.deepEqual((await disk.list()).map((entry) => path.basename(entry.file)), ['00000000-0000-4000-8000-000000000001.jsonl']);
    await disk.remove(path.join(tmp, '00000000-0000-4000-8000-000000000001.jsonl'));
    assert.deepEqual(await disk.list(), []);
    assert.deepEqual(await transcriptFiles(path.join(tmp, 'missing')).list(), []);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('sweep: started once, then every new binding sweeps (no timer)', async () => {
  const h = setup();
  h.kv.set(SUPERSEDED_NS, 'codex:acc_codex:thr_9', { agentId: 'ag_1', conversationId: 'c_1', engine: 'codex', accountId: 'acc_codex', ref: 'thr_9', at: h.clock.now() } satisfies SupersededSession, h.clock.now());
  h.run('run_done', 'done', h.clock.now() + 1);
  const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const stop = h.sweep.start();
  await ticks();
  assert.deepEqual(h.deleted, [], 'not 24 h yet');
  h.clock.advance(KEEP_SUPERSEDED_MS + 5);
  await ticks();
  assert.deepEqual(h.deleted, [], 'time alone sweeps nothing: no timer');
  h.store.save(binding({ ref: 'thr_new', agentId: 'ag_3' })); // a new binding sweeps
  await ticks();
  assert.deepEqual(h.deleted, ['thr_9']);
  stop();
  h.kv.set(SUPERSEDED_NS, 'codex:acc_codex:thr_10', { agentId: 'ag_1', conversationId: 'c_1', engine: 'codex', accountId: 'acc_codex', ref: 'thr_10', at: 0 } satisfies SupersededSession, 0);
  h.store.save(binding({ ref: 'thr_newer', agentId: 'ag_4' }));
  await ticks();
  assert.deepEqual(h.deleted, ['thr_9'], 'after stop a binding no longer sweeps');
});
