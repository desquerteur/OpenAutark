// Secret form fields typed by the person (PM6, secrets/capture.ts) over the real RPC server:
// blocks.answer and tasks.complete store each typed secret encrypted for the agent that asked
// (bound to the field's domain) and pass on only its handle – on the PC and on a phone with just
// the To-do tier, as long as the connection is secure; plain LAN http is refused before anything
// is stored. The value appears nowhere in the database (tasks, messages, wakes, journal …).
// Retries, second devices and failed answers leave no extra copies in the vault.
// Owns: these assertions only. Never: a real keychain or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { answerWithSecrets, captureSecrets, INSECURE, secretKind } from '../../../src/runtime/secrets/capture.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { OWNER, TODO_ONLY, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};

const SECURE_PHONE: ClientScope = { ...TODO_ONLY, secure: true } as ClientScope;
const FORM = '```ui\n{"type":"form","title":"Shop login","fields":[{"name":"user","label":"User"},{"name":"password","label":"Password","kind":"secret","domain":"https://login.shop.example/"},{"name":"apiKey","label":"API key","kind":"secret"}]}\n```';

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  const vault = new SecretVault({ db: f.db, host, clock: f.clock });
  Object.assign(f.services, { secrets: vault });
  const ask = () => {
    const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
    const message = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_1').id, { body: `Please log me in:\n${FORM}`, state: 'final' });
    const [todo] = f.tasks.ingestBlocks(message, uiBlocksOf(message.body).map((entry) => entry.block));
    return { chat, message, todo };
  };
  /** Every row of every table except the vault itself, as one string. */
  const everything = () => (f.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('secrets')") as Array<{ name: string }>)
    .map((table) => JSON.stringify(f.db.all(`SELECT * FROM "${table.name}"`))).join('\n');
  return { ...f, vault, ask, everything, client: (scope: ClientScope) => new TestClient(f.server, scope) };
}

test('blocks.answer from a To-do-only phone over HTTPS: stored for the asking agent, saved from the domain (no binding), only handles go on', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const { message, todo } = f.ask();
  const result = await f.client(SECURE_PHONE).call<{ ok: true; taskId?: string }>('blocks.answer', {
    messageId: message.id, blockIndex: 0, answer: { values: { user: 'ada', password: 'Tr0ub4dor&3-shop', apiKey: 'sk-live-77aa' } },
  });
  assert.equal(result.taskId, todo.id);
  assert.equal(f.tasks.get(todo.id)?.status, 'done');
  const stored = f.vault.list();
  const password = stored.find((info) => info.kind === 'password')!;
  const key = stored.find((info) => info.kind === 'api_key')!;
  assert.deepEqual([password.label, password.source, password.route], ['Shop login · Password', 'shop.example', 'logins'], 'owner 29.10.2026: the form\'s domain is provenance, the entry is for every agent');
  assert.deepEqual([key.label, key.route], ['Shop login · API key', 'keys']);
  const db = f.everything();
  for (const value of ['Tr0ub4dor&3-shop', 'sk-live-77aa']) assert.ok(!db.includes(value), `${value} is nowhere in the database`);
  assert.ok(db.includes(`secret://${password.id}`) && db.includes(`secret://${key.id}`), 'the handles are');
  assert.ok(db.includes('"user":"ada"') || db.includes('\\"user\\":\\"ada\\"'), 'plain fields stay');
  assert.equal(await f.vault.use(password.id, 'ag_ava', 'login.shop.example'), 'Tr0ub4dor&3-shop');
});

test('plain LAN http is refused before anything is stored; the owner may answer a to-do with tasks.complete', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const { message, todo } = f.ask();
  const refused = await f.client(TODO_ONLY).request('blocks.answer', { messageId: message.id, blockIndex: 0, answer: { values: { user: 'ada', password: 'pw-on-lan' } } });
  assert.equal(refused.error?.code, 'forbidden');
  assert.equal(refused.error?.message, INSECURE);
  assert.equal(f.vault.list().length, 0);
  assert.equal(f.tasks.get(todo.id)?.status, 'open');
  // A form without a typed secret still works on plain http.
  const other = f.ask();
  await f.client(TODO_ONLY).call('blocks.answer', { messageId: other.message.id, blockIndex: 0, answer: { values: { user: 'ada' } } });
  assert.equal(f.tasks.get(other.todo.id)?.status, 'done');

  await f.client(OWNER).call('tasks.complete', { id: todo.id, answer: { values: { user: 'ada', password: 'pw-from-desk' } } });
  assert.equal(f.tasks.get(todo.id)?.status, 'done');
  const [stored] = f.vault.list();
  assert.ok(!f.everything().includes('pw-from-desk'));
});

test('captureSecrets: handles and empty fields stay, other answers pass untouched, odd values are refused', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const { message } = f.ask();
  const ref = { messageId: message.id, blockIndex: 0 };
  const plain = { values: { user: 'ada', password: 'secret://sec_existing', apiKey: '' } };
  assert.equal(await captureSecrets(f.services, ref, plain, { secure: false }), plain, 'nothing typed: the same answer');
  const approved = { approved: true };
  assert.equal(await captureSecrets(f.services, ref, approved, { secure: true }), approved);
  await assert.rejects(captureSecrets(f.services, ref, { values: { password: 42 } }, { secure: true }), /must be text/);
  const upper = await captureSecrets(f.services, ref, { values: { PASSWORD: 'Case-Insensitive-1' } }, { secure: true }) as { values: Record<string, string> };
  assert.match(upper.values.PASSWORD, /^secret:\/\/sec_/, 'field names match case-insensitively');
  assert.equal(secretKind({ name: 'cvc', label: 'Card CVC' }), 'card');
  assert.equal(secretKind({ name: 'token', label: 'Bot token' }), 'token');
  assert.equal(secretKind({ name: 'pin', label: 'PIN' }), 'password');
});

test('retries never pile up copies: an answered to-do stores nothing, a repeat replaces, a refused field stores none', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const { message, todo } = f.ask();
  const phone = f.client(SECURE_PHONE);
  const answer = { values: { user: 'ada', password: 'first-pw-1', apiKey: 'sk-first-1' } };
  await phone.call('blocks.answer', { messageId: message.id, blockIndex: 0, answer, clientId: 'up_1' });
  const stored = f.vault.list().map((info) => info.id).sort();
  assert.equal(stored.length, 2);
  // The reply was lost: Send again (new clientId), then once more from the PC's For-you list.
  const again = await phone.call<{ taskId?: string }>('blocks.answer', { messageId: message.id, blockIndex: 0, answer: { values: { user: 'ada', password: 'second-pw-2' } }, clientId: 'up_2' });
  assert.equal(again.taskId, todo.id, 'the answered to-do comes back');
  await f.client(OWNER).call('tasks.complete', { id: todo.id, answer: { values: { password: 'third-pw-3' } } });
  assert.deepEqual(f.vault.list().map((info) => info.id).sort(), stored, 'no extra copies');
  const passwordId = f.vault.list().find((info) => info.kind === 'password')!.id;
  assert.equal(await f.vault.use(passwordId, 'ag_ava', 'login.shop.example'), 'first-pw-1', 'the first answer stands');
  for (const value of ['second-pw-2', 'third-pw-3']) assert.ok(!f.everything().includes(value), 'a dropped value is stored nowhere');

  // A form without a to-do behind it (never ingested): a repeat replaces the value under the same id.
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const loose = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_2').id, { body: FORM, state: 'final' });
  const ref = { messageId: loose.id, blockIndex: 0 };
  const one = await captureSecrets(f.services, ref, { values: { password: 'loose-1' } }, { secure: true }) as { values: { password: string } };
  const two = await captureSecrets(f.services, ref, { values: { password: 'loose-2' } }, { secure: true }) as { values: { password: string } };
  assert.equal(two.values.password, one.values.password, 'the same handle');
  assert.equal(f.vault.list().length, 3);
  assert.equal(await f.vault.use(one.values.password.slice('secret://'.length), 'ag_ava', 'login.shop.example'), 'loose-2');

  // Every field is checked before any is stored.
  const fresh = f.ask();
  await assert.rejects(captureSecrets(f.services, { messageId: fresh.message.id, blockIndex: 0 }, { values: { password: 'ok-pw', apiKey: 'x'.repeat(5000) } }, { secure: true }), /at most 4096/);
  assert.equal(f.vault.list().length, 3, 'nothing of the refused answer was stored');
});

test('a failing answer removes the secrets it added; a finished to-do\'s chat block reads as answered after a reload', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const { message, todo } = f.ask();
  const ref = { messageId: message.id, blockIndex: 0 };
  await assert.rejects(answerWithSecrets(f.services, ref, { values: { password: 'doomed-pw' } }, { secure: true }, () => { throw new Error('answer failed'); }), /answer failed/);
  assert.equal(f.vault.list().length, 0, 'no orphaned copy');

  const owner = f.client(OWNER);
  assert.deepEqual(await owner.call('blocks.state', ref), { state: null }, 'open while the to-do is open');
  await owner.call('tasks.complete', { id: todo.id, answer: { values: { user: 'ada', password: 'kept-pw' } } });
  const { state } = await owner.call<{ state: { answered?: boolean; summary?: string } }>('blocks.state', ref);
  assert.equal(state.answered, true, 'answered in the For-you list: the chat form does not invite a second entry');
  assert.ok(state.summary);
  assert.equal(f.vault.list().length, 1);
});
