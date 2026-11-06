// B-054 (owner 29.10.2026 "To-dos gehören ja nicht zum Chat"): the sign-in work of accounts/relogin.ts needs no chat.
// The Manager's task "Sign in to <account> again" is chat-free (origin system "Account signed out"): no hidden
// "Account sign-in" work chat and no 1:1 is used or created, and the Manager is woken on the task. The person's
// fallback to-do is chat-free on My day too, and both still close themselves when the account works again.
// Owns: these assertions only. Never: a real CLI or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { recordAccountFailure } from '../../../src/runtime/accounts/failure.ts';
import { RELOGIN_ORIGIN, Relogin } from '../../../src/runtime/accounts/relogin.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';

function account(id: string, extra: Partial<Account> = {}): Account {
  return { id, provider: 'codex', label: 'Codex work', auth: 'cli', state: 'ok', priority: 0, rotation: true, enabled: true, detected: true, createdAt: 0, ...extra };
}

const SIGNED_OUT = { stop: 'error', text: '', error: { code: 'unavailable', message: 'Codex is not signed in.' } } as unknown as EngineTurnResult;

function rig(accounts: Account[], options: { direct?: boolean } = {}) {
  const h = harness();
  const store = new Map(accounts.map((item) => [item.id, item]));
  const service = {
    list: () => [...store.values()],
    get: (id: string) => store.get(id),
    markLimited: () => {},
    markUnavailable: (id: string, state: 'needs_login' | 'error') => {
      const current = store.get(id);
      if (!current || current.state === state) return false;
      const next = { ...current, state };
      store.set(id, next);
      h.bus.emit('account.upserted', next);
      return true;
    },
    login: async () => ({ started: true }),
  };
  const warnings: unknown[][] = [];
  Object.assign(h.services, { accounts: service, log: { debug() {}, info() {}, error() {}, warn: (...args: unknown[]) => { warnings.push(args); } } });
  h.org.add(agent('ag_boss', 'Mia', { mode: 'manager' }));
  if (options.direct) h.chats.create({ agentIds: ['ag_boss'], createdBy: HUMAN_ID }); // the Manager's 1:1 with the person
  const relogin = new Relogin({ services: () => h.services });
  relogin.watch();
  const set = (id: string, patch: Partial<Account>) => { const next = { ...store.get(id)!, ...patch }; store.set(id, next); h.bus.emit('account.upserted', next); };
  const fail = (id: string) => recordAccountFailure({ accounts: service, clock: h.clock, notifications: h.services.notifications, relogin }, store.get(id)!, 'gpt-6.1-sol', SIGNED_OUT);
  const chatIds = () => h.services.db.all<{ id: string }>('SELECT id FROM conversations ORDER BY id').map((row) => row.id);
  return { ...h, relogin, set, fail, chatIds, warnings };
}

test('the Manager\'s sign-in task is chat-free: no work chat, no 1:1, a wake on the task', () => {
  for (const direct of [false, true]) {
    const r = rig([account('acc_a'), account('acc_b', { provider: 'claude', label: 'Claude Max' })], { direct });
    const before = r.chatIds();
    r.fail('acc_a');
    const task = r.relogin.openWork('acc_a')!;
    assert.deepEqual(r.warnings, [], 'nothing failed on the way');
    assert.equal(task.assigneeId, 'ag_boss');
    assert.equal(task.conversationId, undefined, `no chat (1:1 present: ${direct})`);
    assert.equal(task.messageId, undefined, 'no anchor card anywhere');
    assert.deepEqual(task.origin, RELOGIN_ORIGIN);
    assert.deepEqual(r.chatIds(), before, 'no chat was created');
    const wake = r.services.db.get<{ conversation_id: string | null; task_id: string | null }>(
      'SELECT conversation_id, task_id FROM wakes WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1', ['ag_boss']);
    assert.deepEqual(wake && [wake.conversation_id, wake.task_id], [null, task.id], 'the Manager works on the task, not in a chat');
    r.set('acc_a', { state: 'ok' });
    assert.equal(r.tasks.get(task.id)!.status, 'done', 'it still closes itself');
  }
});

test('the person\'s fallback to-do is chat-free, first-class on My day, and closes itself', () => {
  const r = rig([account('acc_a')]);
  const before = r.chatIds();
  r.fail('acc_a');
  const todo = r.relogin.openWork('acc_a')!;
  assert.deepEqual([todo.assigneeKind, todo.humanReason, todo.conversationId], ['human', 'credential', undefined]);
  assert.deepEqual(todo.origin, RELOGIN_ORIGIN);
  assert.deepEqual(r.chatIds(), before, 'no To-do chat is made for it');
  assert.ok(r.tasks.todos().some((item) => item.id === todo.id), 'on My day');
  r.set('acc_a', { state: 'ok' });
  assert.equal(r.tasks.get(todo.id)!.status, 'done');
});
