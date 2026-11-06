// Secrets export and its way back (owner 04.11.2026): the export
// (secrets/export.ts) writes a login, a single secret and a card as rows of one CSV that starts like Chrome's, skips a group
// of free fields and counts it, writes mode 0600 to ~/Downloads/autark-secrets-<date>.csv by default and never returns a
// value; the import reads it back into another vault with names, descriptions, tags, routes and kinds, and the review task
// covers only entries that came without a description (an earlier import's placeholder counts as none); its brief names
// several logins of one service by their account. A login's or card's field without a column is a row of its own; a path
// inside the data folder gets the default, a taken name a free one; "all" leaves the app's own working credentials.
// The agent tools secrets.export and secrets.delete return a path, names and counts only; the RPC secrets.export is the
// PC's. A login's username hint is its whole text (clipped to 60), and init() brings an older masked hint up to that.
// Owns: these assertions only. Never: a real keychain, the real Downloads folder or the owner's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { defaultExportFile, EXPORT_COLUMNS, exportSecrets } from '../../../src/runtime/secrets/export.ts';
import { GENERIC_EXPORT, parseCsv, parseExport, OWN_EXPORT } from '../../../src/runtime/secrets/import-parse.ts';
import { FEEDBACK_SECRET_IDS, heldByApp } from '../../../src/runtime/secrets/units.ts';
import { RECEIVER_KEY_ID, SERVICE_ACCOUNT_ID } from '../../../src/runtime/feedback/inbox.ts';
import { importSecrets, reviewBrief, startReview } from '../../../src/runtime/secrets/import.ts';
import { storedForm } from '../../../src/runtime/secrets/groups.ts';
import { secretTools } from '../../../src/runtime/tools/builtin/secrets.ts';
import { register as security } from '../../../src/runtime/rpc/handlers/security.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { OWNER, S1_MODULES, rpcFixture } from '../rpc/s1-helpers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};
const SEED = 'JBSWY3DPEHPK3PXP';
const VALUES = ['Pw-openai-1', 'Pw-openai-2', 'sk-export-key-123', '4111111111111111', '987', SEED, 'free-field-secret'];

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock(Date.UTC(2026, 10, 4, 12));
  const vault = new SecretVault({ db, host, clock });
  const services = { db, host, clock, secrets: vault } as unknown as RuntimeServices;
  return { db, clock, vault, services };
}

/** A catalog with two OpenAI logins (one with a 2FA key and notes), a key, a card and a group of free fields. */
async function filled(vault: SecretVault) {
  const a = await vault.saveGroup({
    label: 'OpenAI - max@firma.de', kind: 'login', source: 'openai.com', description: 'The team account for the API dashboard.', tags: ['development', 'ai'],
    fields: [{ field: 'username', kind: 'text', value: 'max@firma.de' }, { field: 'password', kind: 'password', value: 'Pw-openai-1' }, { field: 'totp', kind: 'totp', value: SEED }, { field: 'notes', kind: 'note', value: 'line one\nline "two", three' }],
  });
  const b = await vault.saveGroup({
    label: 'OpenAI - eva@firma.de', kind: 'login', source: 'openai.com', description: 'Eva\'s own account.',
    fields: [{ field: 'username', kind: 'text', value: 'eva@firma.de' }, { field: 'password', kind: 'password', value: 'Pw-openai-2' }],
  });
  const key = await vault.save({ label: 'Deploy key', kind: 'api_key', value: 'sk-export-key-123', description: 'Deploys the shop.', source: 'api.shop.example', route: 'servers', tags: ['ci'] });
  const card = await vault.saveGroup({
    label: 'Company Visa', kind: 'card', description: 'Pays the hosting.',
    fields: [{ field: 'number', kind: 'card', value: '4111111111111111' }, { field: 'expiry', kind: 'card', value: '07/29' }, { field: 'cvc', kind: 'card', value: '987' }, { field: 'holder', kind: 'text', value: 'Max Muster' }],
  });
  const other = await vault.saveGroup({ label: 'Recovery codes', kind: 'other', fields: [{ field: 'codes', kind: 'password', value: 'free-field-secret' }] });
  return { a: a.group.id, b: b.group.id, key: key.id, card: card.group.id, other: other.group.id };
}

const withHome = async <T>(run: (home: string) => Promise<T>): Promise<T> => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-export-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return await run(home); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(home, { recursive: true, force: true });
  }
};

test('export: a login, a single secret and a card are rows of one CSV that starts like Chrome\'s; a free group is skipped and counted; 0600 in Downloads; no value comes back', async () => {
  const t = setup();
  await filled(t.vault);
  await withHome(async (home) => {
    const result = await exportSecrets(t.services);
    assert.equal(result.file, path.join(home, 'Downloads', 'autark-secrets-2026-11-04.csv'));
    assert.deepEqual([result.count, result.skipped], [4, 1], 'two logins, the key and the card; the free group has no row');
    assert.ok(!VALUES.some((value) => JSON.stringify(result).includes(value)), 'the result holds no value');
    if (process.platform !== 'win32') assert.equal(statSync(result.file).mode & 0o777, 0o600);
    const [header, ...rows] = parseCsv(readFileSync(result.file, 'utf8'));
    assert.deepEqual(header, [...EXPORT_COLUMNS]);
    assert.deepEqual(header.slice(0, 5), ['name', 'url', 'username', 'password', 'note'], 'Chrome\'s columns first');
    const row = (name: string) => Object.fromEntries(header.map((column, index) => [column, rows.find((cells) => cells[0] === name)![index]]));
    const max = row('OpenAI - max@firma.de');
    assert.deepEqual([max.url, max.username, max.password, max.kind, max.tags, max.route, max.note], ['https://openai.com', 'max@firma.de', 'Pw-openai-1', 'login', 'development; ai', 'logins', 'line one\nline "two", three']);
    assert.match(max.totp, /^otpauth:\/\/totp\/.*secret=JBSWY3DPEHPK3PXP/);
    const key = row('Deploy key');
    assert.deepEqual([key.kind, key.password, key.route, key.url, key.description], ['api_key', 'sk-export-key-123', 'servers', 'https://api.shop.example', 'Deploys the shop.']);
    const card = row('Company Visa');
    assert.deepEqual([card.kind, card.number, card.expiry, card.cvc, card.holder, card.password, card.route], ['card', '4111111111111111', '07/29', '987', 'Max Muster', '', 'payment']);
    const second = await exportSecrets(t.services);
    assert.equal(path.basename(second.file), 'autark-secrets-2026-11-04 (2).csv', 'an earlier export is never overwritten');
  });
});

test('export: named ids only (a field\'s id names its login), a route, a given folder or file', async () => {
  const t = setup();
  const ids = await filled(t.vault);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-export-'));
  try {
    const password = t.vault.list().find((info) => info.group?.id === ids.b && info.field === 'password')!.id;
    const named = await exportSecrets(t.services, { ids: [ids.key, password, 'sec_unknown'], file: dir });
    assert.equal(path.dirname(named.file), dir, 'a folder gets the default name inside it');
    assert.deepEqual([named.count, named.skipped, named.notFound], [2, 0, ['sec_unknown']], 'an id that is no entry comes back');
    const names = parseCsv(readFileSync(named.file, 'utf8')).slice(1).map((cells) => cells[0]).sort();
    assert.deepEqual(names, ['Deploy key', 'OpenAI - eva@firma.de']);
    const file = path.join(dir, 'pay', 'cards.csv');
    const routed = await exportSecrets(t.services, { route: 'payment', file });
    assert.deepEqual([routed.file, routed.count], [file, 1]);
    const again = await exportSecrets(t.services, { route: 'payment', file });
    assert.equal(again.file, path.join(dir, 'pay', 'cards (2).csv'), 'a given file that is there is never overwritten');
    assert.equal(readFileSync(file, 'utf8'), readFileSync(again.file, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export: a path inside the data folder gets the default file; ids: [] counts as none named', async () => {
  const t = setup();
  await filled(t.vault);
  await withHome(async (home) => {
    const data = path.join(home, 'data');
    const services = { ...t.services, paths: { data } } as unknown as RuntimeServices;
    const result = await exportSecrets(services, { file: path.join(data, 'workspace', 'secrets.csv'), ids: [] });
    assert.equal(result.file, path.join(home, 'Downloads', 'autark-secrets-2026-11-04.csv'));
    assert.ok(!existsSync(path.join(data, 'workspace', 'secrets.csv')), 'nothing under the data folder');
    assert.deepEqual([result.count, result.skipped], [4, 1], 'every entry');
  });
});

test('export: a login\'s or card\'s field without a column is a row of its own and comes back as a single secret', async () => {
  const a = setup();
  await a.vault.saveGroup({
    label: 'Bank', kind: 'login', description: 'Online banking.',
    fields: [{ field: 'username', kind: 'text', value: 'kto-4711' }, { field: 'password', kind: 'password', value: 'bank-pass-1' }, { field: 'pin', kind: 'password', value: 'bank-pin-99' }],
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-export-'));
  try {
    const result = await exportSecrets(a.services, { file: path.join(dir, 'bank.csv') });
    assert.deepEqual([result.count, result.skipped], [1, 0], 'one entry, two rows');
    const text = readFileSync(result.file, 'utf8');
    const [header, ...rows] = parseCsv(text);
    const pin = rows.find((cells) => cells[0] === 'Bank · pin')!;
    assert.deepEqual([pin[header.indexOf('kind')], pin[header.indexOf('password')], pin[header.indexOf('description')]], ['password', 'bank-pin-99', 'Online banking.']);
    const b = setup();
    await importSecrets(b.vault, text, { now: 0 });
    const single = b.vault.list().find((info) => info.label === 'Bank · pin')!;
    assert.equal(await b.vault.use(single.id, 'agt_any'), 'bank-pin-99');
    assert.equal(b.vault.list().filter((info) => info.group?.label === 'Bank').length, 2, 'the login keeps username and password');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('round trip: an entry exported before the review (the import\'s placeholder description) is sorted again', async () => {
  const a = setup();
  await importSecrets(a.vault, 'name,url,username,password\nopenai.com,https://openai.com,max@firma.de,pw-placeholder-1\n', { fileName: 'Chrome Passwords.csv', now: 0 });
  assert.match(a.vault.groups()[0].description ?? '', /not described or checked yet/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-export-'));
  try {
    const { file } = await exportSecrets(a.services, { file: path.join(dir, 'out.csv') });
    const b = setup();
    const result = await importSecrets(b.vault, readFileSync(file, 'utf8'), { now: Date.UTC(2026, 10, 5) });
    assert.deepEqual([result.added, result.described ?? 0], [1, 0], 'the placeholder is no description');
    const created: unknown[] = [];
    const services = {
      org: { list: () => [{ id: 'agt_mgr', name: 'Ava', template: 'manager', createdAt: 1 }] },
      tasks: { create: (input: unknown) => { created.push(input); return { id: 'tsk_1' }; } }, wakes: { wake() {} },
    } as unknown as RuntimeServices;
    assert.equal(startReview(services, result).reviewTaskId, 'tsk_1');
    assert.match(b.vault.groups()[0].description ?? '', /Imported from Autark export on 2026-11-05; not described or checked yet\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('"all" leaves the app\'s own working credentials (an account\'s key, an app\'s sign-in, the feedback key, the Google client secret) unless named', async () => {
  const t = setup();
  await filled(t.vault);
  const accountKey = await t.vault.save({ label: 'Anthropic key', kind: 'api_key', value: 'sk-account-key-1' });
  const appToken = await t.vault.save({ label: 'Notion sign-in', kind: 'token', value: 'app-token-1' });
  const clientSecret = await t.vault.save({ label: 'Google client secret', kind: 'token', value: 'google-client-1' });
  const feedback = await t.vault.save({ id: RECEIVER_KEY_ID, label: 'Feedback team key', kind: 'token', value: 'feedback-key-1' });
  t.db.run('INSERT INTO accounts (id, provider, label, auth, secret_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['acc_1', 'anthropic', 'Anthropic', 'api_key', accountKey.id, 0]);
  t.db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)', ['apps', 'oauth:grant:notion', JSON.stringify({ secretId: appToken.id, label: 'Notion sign-in' }), 0]);
  const services = { ...t.services, settings: { get: () => ({ calendar: { googleSecretId: clientSecret.id } }) } } as unknown as RuntimeServices;
  const held = [accountKey.id, appToken.id, clientSecret.id, feedback.id];
  assert.deepEqual([...FEEDBACK_SECRET_IDS], [RECEIVER_KEY_ID, SERVICE_ACCOUNT_ID]);
  assert.ok(held.every((id) => heldByApp(services).has(id)));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-export-'));
  try {
    const every = await exportSecrets(services, { file: path.join(dir, 'all.csv') });
    assert.equal(every.count, 4, 'the catalog without the app\'s own');
    assert.ok(!/sk-account-key-1|app-token-1|google-client-1|feedback-key-1/.test(readFileSync(every.file, 'utf8')));
    const named = await exportSecrets(services, { ids: [accountKey.id], file: path.join(dir, 'key.csv') });
    assert.equal(named.count, 1, 'named, it goes');
    const removed = structured(await tool('secrets.delete').run({ all: true }, ctxOf(services)));
    assert.equal(removed.count, 5);
    assert.deepEqual(t.vault.list().map((info) => info.id).sort(), [...held].sort(), 'the company keeps working');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only the full set of our columns marks our own export: another CSV with kind and description stays a generic one', () => {
  assert.equal(parseExport('name,kind,description,password\nAdmin,staff,The admin,pw-generic-1').format, GENERIC_EXPORT);
  assert.equal(parseExport(`${EXPORT_COLUMNS.join(',')}\nKey,,,v-123456,,,token,Why,,keys,,,,`).format, OWN_EXPORT);
});

test('round trip: another vault imports the export with names, descriptions, tags, routes and kinds – no review for described entries', async () => {
  const a = setup();
  await filled(a.vault);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-export-'));
  try {
    const { file } = await exportSecrets(a.services, { file: path.join(dir, 'out.csv') });
    const text = readFileSync(file, 'utf8');
    const parsed = parseExport(text, path.basename(file));
    assert.equal(parsed.format, OWN_EXPORT);
    const b = setup();
    const result = await importSecrets(b.vault, text, { fileName: 'out.csv', now: Date.UTC(2026, 10, 5) });
    assert.deepEqual([result.added, result.cards, result.keys, result.described, result.failed, result.skipped], [2, 1, 1, 4, 0, 0]);
    const max = b.vault.groups().find((group) => group.label === 'OpenAI - max@firma.de')!;
    assert.deepEqual([max.kind, max.description, max.route, max.source], ['login', 'The team account for the API dashboard.', 'logins', 'openai.com']);
    assert.deepEqual(max.tags, ['development', 'ai', 'imported from Autark export 2026-11-05']);
    const fields = b.vault.list().filter((info) => info.group?.id === max.id);
    assert.deepEqual(fields.map((info) => info.field).sort(), ['notes', 'password', 'totp', 'username']);
    assert.equal(fields.find((info) => info.field === 'username')!.hint, 'max@firma.de');
    assert.equal(await b.vault.use(fields.find((info) => info.field === 'password')!.id, 'agt_any'), 'Pw-openai-1');
    assert.equal(await b.vault.use(fields.find((info) => info.field === 'notes')!.id, 'agt_any'), 'line one\nline "two", three');
    assert.match(await b.vault.use(fields.find((info) => info.field === 'totp')!.id, 'agt_any'), /^\d{6}$/);
    const key = b.vault.list().find((info) => info.label === 'Deploy key')!;
    assert.deepEqual([key.kind, key.route, key.description, key.source], ['api_key', 'servers', 'Deploys the shop.', 'api.shop.example']);
    assert.equal(await b.vault.use(key.id, 'agt_any'), 'sk-export-key-123');
    const card = b.vault.groups().find((group) => group.label === 'Company Visa')!;
    assert.deepEqual([card.kind, card.route, card.description], ['card', 'payment', 'Pays the hosting.']);
    assert.deepEqual(b.vault.list().filter((info) => info.group?.id === card.id).map((info) => info.field).sort(), ['cvc', 'expiry', 'holder', 'number']);
    const created: unknown[] = [];
    const services = {
      org: { list: () => [{ id: 'agt_mgr', name: 'Ava', template: 'manager', createdAt: 1 }] },
      tasks: { create: (input: unknown) => { created.push(input); return { id: 'tsk_1' }; } }, wakes: { wake() {} },
    } as unknown as RuntimeServices;
    assert.equal(startReview(services, result).reviewTaskId, undefined, 'every entry came described: nothing to sort');
    assert.equal(created.length, 0);
    const again = await importSecrets(b.vault, text, { now: Date.UTC(2026, 10, 5) });
    assert.deepEqual([again.added, again.keys, again.unchanged], [0, 0, 3], 'a second import skips the logins and the key already stored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the review covers only entries without a description; several logins of one service are named by their account', async () => {
  const t = setup();
  const text = [
    EXPORT_COLUMNS.join(','),
    '"Described",https://a.example,ann,pw-described-1,,,login,"Known account",x,logins,,,,',
    'a.example,https://a.example,bob@firma.de,pw-new-1,,,,,,,,,,',
    'a.example,https://a.example,eva@firma.de,pw-new-2,,,,,,,,,,',
  ].join('\n');
  const result = await importSecrets(t.vault, text, { now: 0 });
  assert.deepEqual([result.added, result.described], [3, 1]);
  const created: Array<{ title: string; notes: string }> = [];
  const services = {
    org: { list: () => [{ id: 'agt_mgr', name: 'Ava', template: 'manager', createdAt: 1 }] },
    tasks: { create: (input: { title: string; notes: string }) => { created.push(input); return { id: 'tsk_1' }; } }, wakes: { wake() {} },
  } as unknown as RuntimeServices;
  assert.equal(startReview(services, result).reviewTaskId, 'tsk_1');
  assert.equal(created[0].title, 'Sort the 2 imported entries');
  const brief = reviewBrief(result);
  assert.match(brief, /1 came with their own name and description and stay as they are; the 2 others say "not described"/);
  assert.match(brief, /Several logins of one service are told apart by their account – "OpenAI - max@firma\.de"/);
  assert.doesNotMatch(brief, /Import \d/);
  const undescribed = t.vault.groups().filter((group) => group.label === 'a.example');
  assert.ok(undescribed.every((group) => /not described or checked yet/.test(group.description ?? '')));
  const hints = t.vault.list().filter((info) => info.field === 'username').map((info) => info.hint).sort();
  assert.deepEqual(hints, ['ann', 'bob@firma.de', 'eva@firma.de'], 'secrets.list shows each account');
});

test('other CSVs stay as they were: an unknown kind is a login, a route that cannot name a file is left out', () => {
  const [item] = parseExport('name,url,username,password,kind\nx,https://x.example,u,p,personal').items;
  assert.ok(item.type === 'login' && item.password === 'p' && item.username === 'u');
  const own = parseExport(`${EXPORT_COLUMNS.join(',')}\nKey,,,v-123456,,,token,Why,"a; b",Bad Route!,,,,`);
  assert.deepEqual(own.items, [{ type: 'value', name: 'Key', value: 'v-123456', kind: 'token', description: 'Why', tags: ['a', 'b'] }]);
});

const tool = (name: string) => secretTools.find((entry) => entry.name === name)!;
const ctxOf = (services: RuntimeServices) => ({ services, agent: { id: 'agt_a', name: 'A' } } as unknown as ToolContext);
const structured = (out: ToolOutput) => (out as { structured?: Record<string, unknown> }).structured ?? {};

test('secrets.export (agent tool): the path and counts, never a value', async () => {
  const t = setup();
  await filled(t.vault);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-export-'));
  try {
    assert.match(tool('secrets.export').description, /secrets\.import reads it back/);
    const out = await tool('secrets.export').run({ path: path.join(dir, 'all.csv'), route: 'logins' }, ctxOf(t.services));
    const data = structured(out);
    assert.deepEqual([data.file, data.count, data.skipped], [path.join(dir, 'all.csv'), 2, 0]);
    assert.match(String(data.note), /secrets\.import in the other company/);
    assert.ok(!VALUES.some((value) => JSON.stringify(out).includes(value)), 'no value in the output');
    assert.ok(readFileSync(path.join(dir, 'all.csv'), 'utf8').includes('Pw-openai-2'), 'the file holds them');
    assert.match(tool('secrets.export').description, /opening it with Read or cat would bring every value into my context/);
    const none = structured(await tool('secrets.export').run({ path: dir, ids: [] }, ctxOf(t.services)));
    assert.equal(none.count, 4, 'an empty ids list names nothing: every entry');
    const wrong = structured(await tool('secrets.export').run({ path: dir, ids: ['sec_nope'] }, ctxOf(t.services)));
    assert.deepEqual([wrong.count, wrong.notFound], [0, ['sec_nope']]);
    assert.match(String(wrong.note), /1 of the ids I named are no entry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secrets.delete (agent tool): by id (a group whole, a field alone), by route or all; the names and the linked-PC line come back', async () => {
  const t = setup();
  const ids = await filled(t.vault);
  const run = (args: Record<string, unknown>) => tool('secrets.delete').run(args, ctxOf(t.services));
  assert.match(JSON.stringify(await run({})), /Name the entries/);
  const totp = t.vault.list().find((info) => info.group?.id === ids.a && info.field === 'totp')!.id;
  const first = structured(await run({ ids: [ids.b, totp, 'sec_gone'] }));
  assert.deepEqual(first.removed, ['OpenAI - eva@firma.de', 'totp of OpenAI - max@firma.de']);
  assert.deepEqual(first.notFound, ['sec_gone']);
  assert.match(String(first.note), /linked PCs remove them too/);
  assert.ok(t.vault.groups().some((group) => group.id === ids.a), 'a field alone leaves its login');
  assert.deepEqual(structured(await run({ route: 'payment' })).removed, ['Company Visa']);
  const all = structured(await run({ all: true }));
  assert.deepEqual(all.removed, ['Deploy key', 'OpenAI - max@firma.de', 'Recovery codes']);
  assert.deepEqual([t.vault.list(), t.vault.groups()], [[], []]);
  assert.ok(!VALUES.some((value) => JSON.stringify(all).includes(value)));
});

test('rpc secrets.export: the PC only; ids or all; the path and counts', async (t) => {
  const table = new HandlerTable();
  for (const register of [...S1_MODULES, security]) register(table);
  const f = rpcFixture({ table });
  t.after(f.cleanup);
  const vault = new SecretVault({ db: f.db, host, clock: f.clock });
  Object.assign(f.services, { secrets: vault, host: { ...f.services.host, ...host } });
  const ids = await filled(vault);
  assert.equal(table.get('secrets.export')?.scope, 'owner');
  await withHome(async (home) => {
    const one = await f.server.call('secrets.export', { ids: [ids.key] }, OWNER) as { file: string; count: number; skipped: number };
    assert.deepEqual([path.dirname(one.file), one.count, one.skipped], [path.join(home, 'Downloads'), 1, 0]);
    const every = await f.server.call('secrets.export', undefined, OWNER) as { count: number; skipped: number };
    assert.deepEqual([every.count, every.skipped], [4, 1]);
    assert.ok(!VALUES.some((value) => JSON.stringify([one, every]).includes(value)));
  });
});

test('a text field\'s hint is the whole text, clipped to 60; init() brings an older masked hint up to that', async () => {
  const long = `${'a'.repeat(70)}@firma.de`;
  assert.equal(storedForm('text', ' max@firma.de ').hint, 'max@firma.de');
  assert.equal(storedForm('text', long).hint, `${'a'.repeat(59)}…`);
  assert.equal(storedForm('text', 'Max\n Muster').hint, 'Max Muster');
  const t = setup();
  const ids = await filled(t.vault);
  const user = t.vault.list().find((info) => info.group?.id === ids.a && info.field === 'username')!;
  t.db.run('UPDATE secrets SET hint = ? WHERE id = ?', ['m•••@firma.de', user.id]);
  await new SecretVault({ db: t.db, host, clock: t.clock }).init();
  assert.equal(t.vault.list().find((info) => info.id === user.id)!.hint, 'max@firma.de');
  assert.equal(t.vault.list().find((info) => info.group?.id === ids.card && info.field === 'number')!.hint, '•••• 1111', 'other hints stay');
});

test('the default file never overwrites one that is there', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-export-'));
  try {
    const now = Date.UTC(2026, 10, 4, 12);
    const first = defaultExportFile(now, dir);
    writeFileSync(first, 'x');
    assert.equal(path.basename(defaultExportFile(now, dir)), 'autark-secrets-2026-11-04 (2).csv');
    assert.ok(existsSync(first));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
