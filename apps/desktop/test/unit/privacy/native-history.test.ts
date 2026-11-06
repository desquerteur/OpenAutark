// The person's "Delete histories" of a Claude Code account (privacy/native-history.ts): `claude purge --all --yes`
// runs only on request, only for this app's isolated homes, never during a running turn, and its sessions start
// fresh; ClaudeEngine.purgeHistories runs the CLI with the account's CLAUDE_CONFIG_DIR and reads its answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { NativeHistory } from '../../../src/runtime/privacy/native-history.ts';
import { ClaudeEngine } from '../../../src/runtime/engines/claude/engine.ts';
import { PURGE_ARGS } from '../../../src/runtime/engines/claude/purge.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { account, fakeFinder, fakeSpawn, memoryFiles, testSupervisor, tick, turnInput } from '../engines/fakes.ts';
import { clock, memoryDb } from '../store/helpers.ts';

const ROOT = path.resolve('/data/accounts');

function world(engines: Partial<Record<string, Partial<Engine>>>, accounts = [account({ id: 'acc_codex' })]) {
  const db = memoryDb();
  const time = clock();
  const history = new NativeHistory({ db, clock: time, accounts: () => accounts, engine: (id) => engines[id] as Engine | undefined, accountsRoot: ROOT });
  const run = (agentId: string, status: string, accountId = 'acc_codex') => db.run(`INSERT INTO runs (id, agent_id, trigger, status, account_id, engine) VALUES (?, ?, 'message', ?, ?, 'codex')`, [`run_${agentId}_${status}`, agentId, status, accountId]);
  const session = (agentId: string, engine: string, ref: string, accountId: string) => db.run(
    `INSERT INTO engine_sessions (agent_id, conversation_id, engine, account_id, session_ref, cursor_seq, generation, updated_at) VALUES (?, 'chat_1', ?, ?, ?, 0, 0, ?)`, [agentId, engine, accountId, ref, time.now()]);
  return { db, time, history, run, session, accounts };
}

test('Claude Code: purge only for this app\'s own homes, never during a running turn; its sessions start fresh', async () => {
  const purged: string[] = [];
  const claude = { purgeHistories: async (item: { id: string }) => { purged.push(item.id); return { purged: true }; } };
  const own = account({ id: 'acc_own', provider: 'claude', label: 'Claude · work', home: path.join(ROOT, 'claude', 'acc_own') });
  const detected = account({ id: 'acc_mine', provider: 'claude', label: 'Claude · mine', home: path.resolve('/home/me/.claude'), detected: true });
  const w = world({ claude }, [own, detected]);
  w.session('ag_a', 'claude', 'uuid-a', 'acc_own');
  w.session('ag_b', 'codex', 'thr_b', 'acc_own');
  assert.deepEqual(w.history.state().claude, [{ accountId: 'acc_own', label: 'Claude · work', sessions: 1, running: false }]);
  await assert.rejects(w.history.purgeClaude('acc_mine'), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  w.run('ag_a', 'running', 'acc_own');
  await assert.rejects(w.history.purgeClaude('acc_own'), (error: unknown) => error instanceof WorkforceError && error.code === 'conflict');
  w.db.run(`UPDATE runs SET status = 'done'`);
  const result = await w.history.purgeClaude('acc_own');
  assert.deepEqual(result, { accountId: 'acc_own', label: 'Claude · work', purged: true, renewed: 1 });
  assert.deepEqual(purged, ['acc_own']);
  assert.deepEqual(w.db.all<{ engine: string }>('SELECT engine FROM engine_sessions').map((row) => row.engine), ['codex'], 'only the Claude sessions of that account renew');
});

test('engine: Claude Code runs purge with the account home and reads its answer', async () => {
  const answers = [{ code: 0, out: 'Purged 3 item(s) across all projects.' }, { code: 1, out: 'No Claude Code project state found under /h.' }, { code: 2, out: 'boom' }];
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const cli = fakeSpawn(({ child, args, options }) => {
    calls.push({ args, env: options.env });
    const answer = answers[calls.length - 1];
    setImmediate(() => { child.stdout.write(answer.out); child.exit(answer.code); });
  });
  const claude = new ClaudeEngine({ supervisor: testSupervisor(cli.spawn), finder: fakeFinder({ claude: '/bin/claude' }), tempDir: '/tmp' });
  const home = account({ provider: 'claude', home: '/data/accounts/claude/acc_1' });
  assert.deepEqual(await claude.purgeHistories(home), { purged: true });
  assert.deepEqual(await claude.purgeHistories(home), { purged: false, message: 'Claude Code had no stored sessions for this account.' });
  await assert.rejects(claude.purgeHistories(home), /could not delete its histories \(exit 2\)/);
  assert.deepEqual(calls[0].args, [...PURGE_ARGS]);
  assert.equal(calls[0].env?.CLAUDE_CONFIG_DIR, '/data/accounts/claude/acc_1');
});

test('Claude Code: a turn of the account that starts during the purge waits for it; a second purge is refused meanwhile', async () => {
  const order: string[] = [];
  let finish: (() => void) | undefined;
  const cli = fakeSpawn(({ child, args }) => {
    if (args[0] === 'purge') {
      order.push('purge');
      finish = () => { child.stdout.write('Purged 1 item(s) across all projects.'); child.exit(0); };
    } else {
      order.push('turn');
      // One line first: a start that ends without any line is a refused lean flag, retried today's way (B-049 F2, claude/lean.ts).
      setImmediate(() => { child.send({ type: 'system', subtype: 'init' }); child.exit(1); });
    }
  });
  const claude = new ClaudeEngine({ supervisor: testSupervisor(cli.spawn), finder: fakeFinder({ claude: '/bin/claude' }), tempDir: '/tmp', files: memoryFiles().files });
  const home = account({ id: 'acc_own', provider: 'claude', home: '/data/accounts/claude/acc_own' });
  const purge = claude.purgeHistories(home);
  await assert.rejects(claude.purgeHistories(home), /already deleting/);
  const turn = claude.run(turnInput({ account: home, model: 'claude-sonnet-4-5' }).input);
  for (let index = 0; index < 5; index++) await tick();
  assert.deepEqual(order, ['purge'], 'the turn has not started its CLI');
  finish!();
  assert.deepEqual(await purge, { purged: true });
  await turn;
  assert.deepEqual(order, ['purge', 'turn'], 'it starts once the purge ended');
  const other = claude.run(turnInput({ runId: 'run_2', account: account({ id: 'acc_other', provider: 'claude' }), model: 'claude-sonnet-4-5' }).input);
  await other;
  assert.deepEqual(order, ['purge', 'turn', 'turn'], 'other accounts never wait');
});
