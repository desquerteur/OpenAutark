// Grouped secrets in the vault (X05, secrets/groups.ts + service.ts): a login's fields carry the
// group and its scope, nothing lists a value, a 2FA field fills only the current code (one wait
// before a window ends), scope applies to the whole group (owner 29.10.2026: nobody ties a login or a card to sites –
// nothing binds on use; a group carries its route and tags), the redactor knows the key's spellings but
// never a text field, a refused field writes nothing, card hints, the upgrade from a
// version-30 database; form capture of a login with a 2FA key as ONE group (one-time codes in
// fields named TOTP stay passwords); a single secret changes to or from a 2FA key only with a value;
// a key grouped with no-break, thin or double spaces is redacted; the RPC tiers.
// Owns: these assertions only. Never: a real keychain, browser or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { parseTotp, seedVariants, totpCode } from '../../../src/runtime/secrets/totp.ts';
import { answerWithSecrets, captureSecrets, groupIdFor, secretKind, totpLabelled } from '../../../src/runtime/secrets/capture.ts';
import { register as security } from '../../../src/runtime/rpc/handlers/security.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { agent } from '../chat/harness.ts';
import { OWNER, S1_MODULES, rpcFixture } from '../rpc/s1-helpers.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};
const SEED = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Example:ada@example.com?secret=${SEED}&issuer=Example`;
const PASSWORD = 'Pw-very-secret-1';
const USERNAME = 'ada@example.com';

function setup(db = migrated()) {
  const clock = new ManualClock(); // 09:00:00 UTC: a full 30-second window left
  const logs: string[] = [];
  const log = { debug() {}, warn() {}, error() {}, info: (message: string, data?: unknown) => logs.push(`${message} ${JSON.stringify(data ?? {})}`) };
  const sleeps: number[] = [];
  const vault = new SecretVault({ db, host, clock, log, sleep: async (ms) => { sleeps.push(ms); } });
  return { db, clock, logs, sleeps, vault };
}

function migrated() {
  const db = new Db(':memory:');
  migrate(db);
  return db;
}

async function login(vault: SecretVault, extra: { agents?: string[]; source?: string } = {}) {
  const saved = await vault.saveGroup({
    label: 'Example – support', kind: 'login', ...(extra.source ? { source: extra.source } : {}),
    fields: [{ field: 'username', kind: 'text', value: USERNAME }, { field: 'password', kind: 'password', value: PASSWORD }, { field: 'totp', kind: 'totp', value: URI }],
  });
  const id = (name: string) => saved.fields.find((field) => field.field === name)!.id;
  return { saved, user: id('username'), password: id('password'), totp: id('totp') };
}

/** The secret values; a username is a text field, which its hint shows (owner 04.11.2026). */
const leaks = (text: string) => [...seedVariants({ base32: SEED }), PASSWORD].filter((value) => text.includes(value));

test('a login is three fields with the group, its scope and its hints (the username whole); nothing lists a value', async () => {
  const t = setup();
  const { saved } = await login(t.vault, { source: 'example.com' });
  const fields = t.vault.list();
  assert.equal(fields.length, 3);
  for (const field of fields) {
    assert.deepEqual(field.group, { id: saved.group.id, label: 'Example – support', kind: 'login' });
    assert.deepEqual([field.source, field.route], ['example.com', 'logins'], 'source and route are the group\'s');
  }
  assert.deepEqual(fields.map((field) => [field.field, field.kind, field.hint]).sort(), [
    ['password', 'password', undefined], ['totp', 'totp', '6 digits · 30 s'], ['username', 'text', USERNAME],
  ]);
  const columns = t.db.all('SELECT id, label, kind, hint, agents, domains, created_at, last_used_at, group_id, field FROM secrets');
  const everything = JSON.stringify([fields, t.vault.groups(), columns, t.db.all('SELECT * FROM secret_groups'), t.logs]);
  assert.deepEqual(leaks(everything), []);
  assert.deepEqual(t.db.all<{ agents: string; domains: string }>('SELECT agents, domains FROM secrets').map((row) => [row.agents, row.domains]), [['[]', '[]'], ['[]', '[]'], ['[]', '[]']]);
});

test('use() of a 2FA field returns only the current code – for the agent, the person and the system; one wait near the window end', async () => {
  const t = setup();
  const { totp } = await login(t.vault, { source: 'example.com' });
  const params = parseTotp(URI);
  const now = totpCode(params, t.clock.now()).code;
  assert.equal(await t.vault.use(totp, 'ag_mira', 'login.example.com'), now);
  assert.equal(await t.vault.use(totp, 'human'), now);
  assert.equal(await t.vault.use(totp, 'system'), now);
  assert.deepEqual(t.sleeps, []);
  t.clock.advance(28_000); // 2 s left
  const next = totpCode(params, t.clock.now() + 2_000).code;
  assert.notEqual(next, totpCode(params, t.clock.now()).code);
  assert.equal(await t.vault.use(totp, 'ag_mira', 'example.com'), next, 'the next window\'s code');
  assert.deepEqual(t.sleeps, [2_000], 'awaited once');
  assert.deepEqual(leaks(t.logs.join('\n')), []);
  assert.ok(!t.logs.join('\n').includes(now), 'no code in the log');
});

test('scope is the group\'s: a login and a card group bind nothing on use – any site, any shop (owner 29.10.2026)', async () => {
  const t = setup();
  const { user, password, totp } = await login(t.vault, { source: 'example.com' });
  for (const id of [user, password, totp]) assert.ok(await t.vault.use(id, 'ag_ben', 'example.com'), 'every agent');
  for (const id of [user, password, totp]) assert.ok(await t.vault.use(id, 'ag_mira', 'other.example'), 'any site');
  const card = await t.vault.saveGroup({ label: 'Visa', kind: 'card', tags: ['company card'], fields: [{ field: 'number', kind: 'card', value: '4111111111111234' }, { field: 'cvc', kind: 'card', value: '123' }] });
  assert.deepEqual([card.group.route, card.group.tags], ['payment', ['company card']]);
  await t.vault.use(card.fields[0].id, 'ag_mira', 'https://pay.shop.example/checkout');
  assert.equal(await t.vault.use(card.fields[0].id, 'ag_mira', 'other.example'), '4111111111111234', 'another shop');
  assert.equal(await t.vault.use(card.fields[1].id, 'ag_mira', 'third.example'), '123');
  assert.deepEqual(t.db.all<{ domains: string }>('SELECT domains FROM secret_groups').map((row) => row.domains), ['[]', '[]'], 'nothing bound');
});

test('redaction: the key in every spelling and inside a link becomes the 2FA handle – also after init(); text fields never', async () => {
  const t = setup();
  const { totp, user } = await login(t.vault);
  const card = await t.vault.saveGroup({ label: 'Visa', kind: 'card', fields: [{ field: 'number', kind: 'card', value: '4111 1111 1111 1234' }, { field: 'holder', kind: 'text', value: 'Ada Lovelace' }] });
  const text = `a ${SEED} b ${SEED.toLowerCase()} c JBSW Y3DP EHPK 3PXP d ${URI} e ${USERNAME} f Ada Lovelace`;
  for (const vault of [t.vault, setup(t.db).vault]) {
    if (vault !== t.vault) await vault.init();
    const out = vault.redact(text);
    assert.equal(out.split(`secret://${totp}`).length - 1, 4, out);
    assert.ok(out.includes(USERNAME) && out.includes('Ada Lovelace'), 'username and cardholder stay');
    assert.ok(!out.includes(`secret://${user}`) && !out.includes(`secret://${card.fields.find((field) => field.field === 'holder')!.id}`));
    assert.deepEqual(leaks(out).filter((value) => value !== USERNAME), []);
  }
});

test('one invalid 2FA key writes nothing; removeGroup removes fields and redaction; card hints and stops', async () => {
  const t = setup();
  await assert.rejects(t.vault.saveGroup({
    label: 'Broken', kind: 'login', fields: [{ field: 'password', kind: 'password', value: PASSWORD }, { field: 'totp', kind: 'totp', value: 'not-a-key-0189' }],
  }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && !error.message.includes('not-a-key'));
  assert.deepEqual([t.db.all('SELECT * FROM secret_groups').length, t.db.all('SELECT * FROM secrets').length], [0, 0]);
  await assert.rejects(t.vault.saveGroup({ label: 'Two keys', fields: [{ field: 'a', kind: 'totp', value: SEED }, { field: 'b', kind: 'totp', value: SEED }] }), /at most one 2FA/);
  await assert.rejects(t.vault.saveGroup({ label: 'Bad name', fields: [{ field: 'Pass word', kind: 'password', value: PASSWORD }] }), /Field names/);

  const { saved } = await login(t.vault);
  t.vault.removeGroup(saved.group.id);
  assert.deepEqual([t.vault.groups().length, t.vault.list().length], [0, 0]);
  assert.equal(t.vault.redact(`${PASSWORD} ${SEED}`), `${PASSWORD} ${SEED}`, 'redaction forgotten');

  const card = await t.vault.saveGroup({
    label: 'Company Visa', kind: 'card', fields: [
      { field: 'number', kind: 'card', value: '4111 1111 1111 1234' }, { field: 'expiry', kind: 'card', value: '12/29' },
      { field: 'cvc', kind: 'card', value: '123' }, { field: 'holder', kind: 'text', value: 'Ada Lovelace' },
    ],
  });
  const field = (name: string) => card.fields.find((entry) => entry.field === name)!;
  assert.deepEqual([field('number').hint, field('expiry').hint, field('cvc').hint], ['•••• 1234', undefined, undefined]);
  await assert.rejects(t.vault.saveGroup({ id: card.group.id, kind: 'login' }), /fixed after creation/);
  // An edit with an empty value keeps the stored one; agents given to save() for a field go to the group.
  await t.vault.saveGroup({ id: card.group.id, fields: [{ id: field('cvc').id, field: 'cvc', kind: 'card', value: '' }] });
  assert.equal(await t.vault.use(field('cvc').id, 'human'), '123');
  await t.vault.save({ id: field('cvc').id, label: 'ignored', kind: 'card' });
});

test('migrate() upgrades a version-30 database; its single secrets keep working', async () => {
  const db = new Db(':memory:');
  const dir = new URL('../../../src/runtime/db/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => /^\d{3}-.*\.ts$/.test(name) && Number(name.slice(0, 3)) <= 30).sort()) {
    db.exec(((await import(new URL(file, dir).href)) as { sql: string }).sql);
  }
  db.run(`INSERT INTO meta (key, value) VALUES ('schema', '30') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  db.run(`INSERT INTO secrets (id, label, kind, cipher, agents, domains, created_at) VALUES ('sec_old', 'Old login', 'password', ?, '["*"]', '["shop.example"]', 1)`, [await host.encrypt('old-pw-123')]);
  assert.deepEqual(migrate(db), { from: 30, to: SCHEMA_VERSION });
  const t = setup(db);
  await t.vault.init();
  assert.deepEqual(t.vault.list().map((info) => [info.id, info.group, info.source, info.route]), [['sec_old', undefined, 'shop.example', 'logins']], 'migrations 80/81: the old binding is only where it came from; a route is set');
  assert.equal(await t.vault.use('sec_old', 'ag_mira', 'shop.example'), 'old-pw-123');
  assert.equal(await t.vault.use('sec_old', 'ag_mira', 'other.example'), 'old-pw-123', 'and works on any site');
  assert.equal(t.vault.redact('x old-pw-123'), 'x secret://sec_old');
  assert.deepEqual(t.vault.groups(), []);
  const moved = await t.vault.saveGroup({ label: 'Shop', kind: 'login', fields: [{ id: 'sec_old', field: 'password', kind: 'password' }] });
  assert.deepEqual(moved.fields.map((info) => [info.id, info.field, info.group?.id]), [['sec_old', 'password', moved.group.id]], 'a single secret moves in');
});

test('redaction: a saved key grouped with no-break, thin or double spaces, or in groups of 3, is replaced too – also after init()', async () => {
  const t = setup();
  const { totp } = await login(t.vault);
  for (const vault of [t.vault, setup(t.db).vault]) {
    if (vault !== t.vault) await vault.init();
    for (const spelled of ['JBSW\u00a0Y3DP\u00a0EHPK\u00a03PXP', 'jbsw  y3dp  ehpk  3pxp', 'JBSW\u2009Y3DP\u2009EHPK\u20093PXP', 'JBS WY3 DPE HPK 3PX P']) {
      assert.equal(vault.redact(`key: ${spelled}.`), `key: secret://${totp}.`, JSON.stringify(spelled));
    }
  }
});

test('a single secret changes to or from a 2FA key or a text field only with a new value', async () => {
  const t = setup();
  const pw = await t.vault.save({ label: 'Shop', kind: 'password', value: PASSWORD });
  for (const kind of ['totp', 'text'] as const) await assert.rejects(t.vault.save({ id: pw.id, label: 'Shop', kind }), /needs its value again/);
  assert.deepEqual([t.vault.list()[0].kind, t.vault.redact(PASSWORD)], ['password', `secret://${pw.id}`], 'unchanged, still redacted');
  const key = await t.vault.save({ label: 'Key', kind: 'totp', value: URI });
  await assert.rejects(t.vault.save({ id: key.id, label: 'Key', kind: 'password' }), /needs its value again/);
  assert.equal(await t.vault.use(key.id, 'human'), totpCode(parseTotp(URI), t.clock.now()).code, 'still only the code, never the stored JSON');
  await t.vault.save({ id: key.id, label: 'Key', kind: 'password', value: 'new-pw-12345' });
  assert.deepEqual([await t.vault.use(key.id, 'human'), t.vault.redact(SEED)], ['new-pw-12345', SEED]);
  await t.vault.save({ id: pw.id, label: 'Shop', kind: 'token' });
  assert.equal(await t.vault.use(pw.id, 'human'), PASSWORD, 'other kind changes as before');
});

// ------------------------------------------------------------------ form capture and RPC

const FORM = '```ui\n{"type":"form","title":"Example login","fields":[{"name":"password","label":"Password","kind":"secret","domain":"https://login.example.com/"},{"name":"totp","label":"2FA setup key","kind":"secret","domain":"example.com"},{"name":"code","label":"6-digit code","kind":"secret"}]}\n```';

function rig() {
  const table = new HandlerTable();
  for (const register of [...S1_MODULES, security]) register(table);
  const f = rpcFixture({ table });
  f.org.add(agent('ag_ava', 'Ava'));
  const vault = new SecretVault({ db: f.db, host, clock: f.clock });
  Object.assign(f.services, { secrets: vault });
  const ask = (body = FORM) => {
    const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
    return f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_1').id, { body, state: 'final' });
  };
  return { ...f, table, vault, ask };
}

test('capture: password + 2FA key of one form become ONE login for the asking agent; a retry replaces; a bad key stores nothing', async (t) => {
  const f = rig();
  t.after(f.cleanup);
  const ref = { messageId: f.ask().id, blockIndex: 0 };
  const answer = { values: { password: PASSWORD, totp: URI } };
  const one = await captureSecrets(f.services, ref, answer, { secure: true }) as { values: Record<string, string> };
  const two = await captureSecrets(f.services, ref, { values: { password: 'Second-pw-22', totp: URI } }, { secure: true }) as { values: Record<string, string> };
  assert.deepEqual(two.values, one.values, 'the same handles');
  const [group] = f.vault.groups();
  assert.equal(f.vault.groups().length, 1, 'no duplicate');
  assert.equal(group.id, groupIdFor(`${ref.messageId}:0`));
  assert.deepEqual([group.kind, group.label, group.source], ['login', 'Example login', 'example.com'], 'the form\'s domain is where it came from, no binding; for every agent');
  assert.deepEqual(f.vault.list().map((info) => info.kind).sort(), ['password', 'totp']);
  assert.equal(await f.vault.use(one.values.password.slice(9), 'ag_ava', 'login.example.com'), 'Second-pw-22');

  const fresh = { messageId: f.ask().id, blockIndex: 0 };
  await assert.rejects(captureSecrets(f.services, fresh, { values: { password: 'pw-x-1234', totp: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PX0' } }, { secure: true }), /2FA setup key/);
  assert.equal(f.vault.groups().length, 1, 'nothing stored for the refused answer');
  assert.equal(secretKind({ name: 'code', label: '6-digit code' }, '123456'), 'password', 'a one-time code is not a seed');
  assert.equal(secretKind({ name: 'key', label: 'Secret' }, URI), 'totp');
  await assert.rejects(answerWithSecrets(f.services, fresh, answer, { secure: true }, () => { throw new Error('answer failed'); }), /answer failed/);
  assert.equal(f.vault.groups().length, 1, 'a failed answer removes the group it created');
});

const CODES = '```ui\n{"type":"form","title":"Sign-in codes","fields":[{"name":"totp","label":"6-digit code","kind":"secret"},{"name":"otp","label":"TOTP code","kind":"secret"},{"name":"app","label":"Code from your authenticator key app","kind":"secret"}]}\n```';

test('capture: one-time codes in fields named TOTP or authenticator are stored as passwords, and the answer goes through', async (t) => {
  const f = rig();
  t.after(f.cleanup);
  const ref = { messageId: f.ask(CODES).id, blockIndex: 0 };
  const answer = { values: { totp: '123456', otp: '654321', app: '11223344' } };
  const answered = await answerWithSecrets(f.services, ref, answer, { secure: true }, (captured) => captured) as { values: Record<string, string> };
  assert.ok(Object.values(answered.values).every((value) => /^secret:\/\/sec_/.test(value)), JSON.stringify(answered));
  assert.deepEqual(f.vault.list().map((info) => info.kind), ['password', 'password', 'password']);
  for (const field of [{ name: 'totp', label: '6-digit code' }, { name: 'code', label: 'TOTP code' }, { label: 'Code from your authenticator key app' }]) {
    assert.deepEqual([secretKind(field, '123456'), totpLabelled(field)], ['password', false], JSON.stringify(field));
  }
  assert.equal(secretKind({ name: 'totp', label: 'TOTP' }, SEED), 'totp', 'a key that parses next to a 2FA word');
  assert.deepEqual([secretKind({ name: 'key', label: '2FA key under the QR code' }, SEED), totpLabelled({ label: '2FA key under the QR code' })], ['totp', true], '"QR code" is no one-time code');
  assert.deepEqual([totpLabelled({ name: 'totp', label: 'Authenticator setup key' }), totpLabelled({ name: 'api', label: 'API key' })], [true, false]);
  await assert.rejects(captureSecrets(f.services, { messageId: f.ask().id, blockIndex: 0 }, { values: { totp: 'not a key at all' } }, { secure: true }), /2FA setup key/, 'a setup-key field still refuses what is neither a key nor a code');
});

const device = (secure = true): ClientScope => ({ kind: 'device', deviceId: 'dev_phone', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure });

test('rpc: groups and saveGroup on the permissions tier over HTTPS, deleteGroup on the PC; a phone only creates; no value comes back', async (t) => {
  const f = rig();
  t.after(f.cleanup);
  assert.deepEqual(f.table.get('secrets.groups')?.scope, { capability: 'permissions', secure: true });
  assert.deepEqual(f.table.get('secrets.saveGroup')?.scope, { capability: 'permissions', secure: true });
  assert.equal(f.table.get('secrets.deleteGroup')?.scope, 'owner');
  const create = { label: 'Shop', kind: 'login', fields: [{ field: 'username', kind: 'text', value: USERNAME }, { field: 'password', kind: 'password', value: PASSWORD }, { field: 'totp', kind: 'totp', value: URI }] };
  await assert.rejects(f.server.call('secrets.saveGroup', create, device(false)), /./, 'plain LAN http');
  const saved = await f.server.call('secrets.saveGroup', create, device()) as { group: { id: string }; fields: Array<{ id: string; field: string }> };
  const field = saved.fields[0];
  for (const params of [{ id: saved.group.id, label: 'Mine now' }, { label: 'x', fields: [{ id: field.id, field: field.field, kind: 'text', value: 'y' }] }, { label: 'x', remove: [field.id] }]) {
    await assert.rejects(f.server.call('secrets.saveGroup', params, device()), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
  }
  await assert.rejects(f.server.call('secrets.deleteGroup', { id: saved.group.id }, device()), /./);
  const results = JSON.stringify([saved, await f.server.call('secrets.groups', undefined, device()), await f.server.call('secrets.list', undefined, OWNER)]);
  assert.deepEqual(leaks(results), []);
  assert.deepEqual(await f.server.call('secrets.deleteGroup', { id: saved.group.id }, OWNER), { ok: true });
  assert.deepEqual(f.vault.list(), []);
});
