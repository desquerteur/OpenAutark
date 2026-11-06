// Password import (owner 29.10.2026, passwords from the browser): the exports of
// Chrome, Firefox, Safari, Bitwarden (CSV and JSON), 1Password, KeePass, LastPass, Dashlane and Proton Pass are read by
// their column names; every login becomes a catalog login (each field its own handle, for every agent, source = the
// registrable domain, never a restriction); a login stored with the same password is skipped, with another password the
// import is added next to it and tagged; nothing stored is overwritten; URLs lose query and fragment; a 2FA key the vault
// cannot read is left out (and counts as failed); the top Manager gets one task and a wake; the agent tool returns
// counts, never a value. Owner 04.11.2026: a .env or flat JSON file gives one single secret per name (kind from the name,
// a value already held is unchanged, one decrypt pass); the agent tool deletes a known browser's or manager's export after
// a complete import (nothing failed or skipped) and keeps a .env, JSON or other CSV file.
// Owns: these assertions only. Never: a real keychain or file outside the temp folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { parseCsv, parseExport, safeUrl } from '../../../src/runtime/secrets/import-parse.ts';
import { DIFFERS_TAG, importSecrets, startReview } from '../../../src/runtime/secrets/import.ts';
import { secretTools } from '../../../src/runtime/tools/builtin/secrets.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';

let decrypts = 0;
const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => { decrypts++; return Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'); },
};

function vault(): { vault: SecretVault; clock: ManualClock; db: Db } {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  return { vault: new SecretVault({ db, host, clock }), clock, db };
}

const CHROME = 'name,url,username,password,note\r\n'
  + 'github.com,https://github.com/login?return_to=%2Ftoken%3Dabc#frag,ada@example.com,"pa,ss""word1",\r\n'
  + 'accounts.google.com,https://accounts.google.com/,ada@gmail.com,googlePass99,"line one\nline two"\r\n'
  + 'nopass.example,https://nopass.example/,ada,,\r\n'
  + 'github.com,https://github.com/login,ada@example.com,"pa,ss""word1",\r\n';

test('CSV: quotes, "" escapes, line breaks in fields, CRLF, BOM and ";" delimiters', () => {
  assert.deepEqual(parseCsv('﻿a;b\n"x;1";"y\n""z"""\n'), [['a', 'b'], ['x;1', 'y\n"z"']]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n\r\n'), [['a', 'b'], ['1', '2']]);
});

test('URLs keep scheme, host and path only; app ids are named', () => {
  assert.equal(safeUrl('https://user:pw@site.example/login?token=secret#x'), 'https://site.example/login');
  assert.equal(safeUrl('site.example'), 'https://site.example');
  assert.equal(safeUrl('android://abc==@com.instagram.android/'), 'android app com.instagram.android');
  assert.equal(safeUrl('not a url at all ://'), undefined);
});

test('the formats of the common browsers and managers are recognised by their columns', () => {
  const cases: Array<[string, string, string?]> = [
    ['name,url,username,password,note\nx,https://x.example,u,p,', 'Chrome, Edge or Brave'],
    ['name,url,username,password,note\nx,https://x.example,u,p,', 'Microsoft Edge', 'Microsoft Edge Passwords.csv'],
    ['url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged\nhttps://x.example,u,p,,,{1},1,1,1', 'Firefox'],
    ['Title,URL,Username,Password,Notes,OTPAuth\nX,https://x.example,u,p,,', 'Safari / Apple Passwords'],
    ['folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,X,,,0,https://x.example,u,p,', 'Bitwarden'],
    ['Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nX,https://x.example,u,p,,false,false,,', '1Password'],
    ['"Group","Title","Username","Password","URL","Notes","TOTP"\n"Root","X","u","p","https://x.example","",""', 'KeePass'],
    ['url,username,password,totp,extra,name,grouping,fav\nhttps://x.example,u,p,,,X,Work,0', 'LastPass'],
    ['username,username2,username3,title,password,note,url,category,otpSecret\nu,,,X,p,,https://x.example,,', 'Dashlane'],
    ['type,name,url,email,username,password,note,totp,createTime,modifyTime,vault\nlogin,X,https://x.example,,u,p,,,1,1,Personal', 'Proton Pass'],
  ];
  for (const [text, format, file] of cases) {
    const parsed = parseExport(text, file);
    assert.equal(parsed.format, format, text.split('\n')[0]);
    assert.equal(parsed.items.length, 1, format);
    const item = parsed.items[0];
    assert.ok(item.type === 'login' && item.password === 'p' && item.username === 'u' && item.url === 'https://x.example', format);
  }
  const grouped = parseExport('url,username,password,totp,extra,name,grouping,fav\nhttps://x.example,u,p,,,X,Work,0').items[0];
  assert.ok(grouped.type === 'login' && grouped.folder === 'Work');
});

test('unreadable files are refused with a clear reason', () => {
  assert.throws(() => parseExport('a,b\n1,2'), /No password column/);
  assert.throws(() => parseExport('{"encrypted":true,"items":[]}'), /encrypted/);
  assert.throws(() => parseExport('<?xml version="1.0"?><KeePassFile/>'), /KeePass XML/);
  assert.throws(() => parseExport('{"x":1}'), /no Bitwarden export and no list of names with text values/);
});

test('a .env and a flat JSON file: one value per secret; plain settings, short and empty values skipped; a CSV stays a CSV', () => {
  const env = parseExport([
    '# keys', 'OPENAI_API_KEY=sk-live-1', 'EMPTY_KEY=', 'export DB_PASSWORD="pass word 1"', 'NODE_ENV=production', 'PORT=3000',
    'APP_URL=http://localhost:3000', 'DEBUG=1', 'ADMIN_PIN_TOKEN=1234', 'DATABASE_URL=postgres://app:dbpass-9@db.local/shop',
  ].join('\n'), '.env');
  assert.equal(env.format, '.env file');
  assert.equal(env.skipped, 6, 'EMPTY_KEY, NODE_ENV, PORT, APP_URL, DEBUG and the 4-character token');
  assert.deepEqual(env.items, [
    { type: 'value', name: 'OPENAI_API_KEY', value: 'sk-live-1' }, { type: 'value', name: 'DB_PASSWORD', value: 'pass word 1' },
    { type: 'value', name: 'DATABASE_URL', value: 'postgres://app:dbpass-9@db.local/shop' },
  ]);
  const json = parseExport('{"GITHUB_TOKEN":"ghp_secret_1","region":"eu-central-1"}', 'keys.json');
  assert.equal(json.format, 'JSON file');
  assert.deepEqual(json.items, [{ type: 'value', name: 'GITHUB_TOKEN', value: 'ghp_secret_1' }]);
  assert.equal(json.skipped, 1);
  assert.equal(parseExport(CHROME, 'Chrome Passwords.csv').format, 'Chrome');
});

test('Bitwarden JSON: logins with folder and 2FA, cards; notes and identities skipped', () => {
  const parsed = parseExport(JSON.stringify({
    encrypted: false, folders: [{ id: 'f1', name: 'Work' }],
    items: [
      { type: 1, name: 'Shop', folderId: 'f1', login: { username: 'ada', password: 'shopPass123', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'https://shop.example/login' }] } },
      { type: 3, name: 'Visa', card: { cardholderName: 'Ada L', number: '4111111111111111', expMonth: '7', expYear: '2029', code: '123' } },
      { type: 2, name: 'A note', notes: 'text' },
    ],
  }));
  assert.equal(parsed.format, 'Bitwarden');
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.items[0], { type: 'login', password: 'shopPass123', name: 'Shop', url: 'https://shop.example/login', username: 'ada', totp: 'JBSWY3DPEHPK3PXP', folder: 'Work' });
  assert.deepEqual(parsed.items[1], { type: 'card', number: '4111111111111111', name: 'Visa', holder: 'Ada L', expiry: '07/29', cvc: '123' });
});

test('an import stores logins in the catalog with handles per field, for every agent, values only in the vault', async () => {
  const { vault: v } = vault();
  const result = await importSecrets(v, CHROME, { fileName: 'Chrome Passwords.csv', now: Date.UTC(2026, 9, 29, 12) });
  assert.deepEqual({ ...result }, { format: 'Chrome', added: 2, cards: 0, keys: 0, unchanged: 1, differing: 0, skipped: 1, failed: 0, tag: 'imported from Chrome 2026-10-29' });
  const github = v.groups().find((group) => group.label === 'github.com')!;
  assert.equal(github.kind, 'login');
  assert.equal(github.route, 'logins');
  assert.equal(github.source, 'github.com');
  assert.deepEqual(github.tags, ['imported from Chrome 2026-10-29']);
  assert.match(github.description!, /^Sign-in for github\.com \(https:\/\/github\.com\/login\)\. Imported from Chrome on 2026-10-29/);
  assert.ok(!JSON.stringify(v.groups()).includes('token') && !JSON.stringify(v.list()).includes('pa,ss'), 'no query string, no value in metadata');
  const fields = v.list().filter((info) => info.group?.id === github.id);
  assert.deepEqual(fields.map((info) => info.field).sort(), ['password', 'username']);
  assert.equal(await v.use(fields.find((info) => info.field === 'password')!.id, 'agt_any'), 'pa,ss"word1');
  const google = v.groups().find((group) => group.label === 'accounts.google.com')!;
  const notes = v.list().find((info) => info.group?.id === google.id && info.field === 'notes')!;
  assert.equal(notes.kind, 'note');
  assert.equal(await v.use(notes.id, 'human'), 'line one\nline two');
  assert.equal(v.redact('my pass is googlePass99'), `my pass is secret://${v.list().find((info) => info.group?.id === google.id && info.field === 'password')!.id}`);
});

test('a second import skips what is stored, adds a differing password next to it and overwrites nothing', async () => {
  const { vault: v } = vault();
  await importSecrets(v, CHROME, { now: Date.UTC(2026, 9, 29) });
  const before = v.groups().length;
  const again = await importSecrets(v, CHROME, { now: Date.UTC(2026, 9, 30) });
  assert.equal(again.added, 0);
  assert.equal(again.unchanged, 3);
  assert.equal(v.groups().length, before);
  const changed = await importSecrets(v, 'name,url,username,password\ngithub.com,https://www.github.com/,ada@example.com,newerPass456', { now: Date.UTC(2026, 9, 30) });
  assert.equal(changed.added, 1);
  assert.equal(changed.differing, 1);
  const logins = v.groups().filter((group) => group.source === 'github.com');
  assert.equal(logins.length, 2);
  const newer = logins.find((group) => group.tags?.includes(DIFFERS_TAG))!;
  const older = logins.find((group) => group !== newer)!;
  assert.match(newer.description!, new RegExp(`stored as ${older.id} with another password`));
  const oldPassword = v.list().find((info) => info.group?.id === older.id && info.field === 'password')!;
  assert.equal(await v.use(oldPassword.id, 'human'), 'pa,ss"word1');
});

test('a 2FA key the vault cannot read is left out; the login is still stored and the import counts as not complete', async () => {
  const { vault: v } = vault();
  const result = await importSecrets(v, 'Title,URL,Username,Password,Notes,OTPAuth\nBank,https://bank.example,ada,bankPass777,,not-a-key!!\nMail,https://mail.example,ada,mailPass888,,otpauth://totp/Mail:ada?secret=JBSWY3DPEHPK3PXP&issuer=Mail', { now: 0 });
  assert.deepEqual([result.added, result.failed], [2, 1], 'both logins added; the one without its 2FA key is not stored completely');
  const bank = v.groups().find((group) => group.label === 'Bank')!;
  const mail = v.groups().find((group) => group.label === 'Mail')!;
  assert.deepEqual(v.list().filter((info) => info.group?.id === bank.id).map((info) => info.field).sort(), ['password', 'username']);
  assert.ok(v.list().some((info) => info.group?.id === mail.id && info.field === 'totp' && info.kind === 'totp'));
});

test('a .env import: single secrets named after their keys, kinds from the names, values only in the vault, a held value unchanged', async () => {
  const { vault: v } = vault();
  await v.save({ label: 'Old key', kind: 'api_key', value: 'sk-already-here' });
  await importSecrets(v, 'name,url,username,password\nShop,https://shop.example,ada,shopPass123', { now: 0 });
  const text = 'OPENAI_API_KEY=sk-already-here\nGITHUB_TOKEN=ghp_secret_1\nDB_PASSWORD=dbPass-42\nGITHUB_TOKEN_COPY=ghp_secret_1\nSHOP_PASSWORD=shopPass123\n';
  decrypts = 0;
  const result = await importSecrets(v, text, { fileName: '.env', now: Date.UTC(2026, 10, 4) });
  assert.deepEqual({ ...result }, { format: '.env file', added: 0, cards: 0, keys: 2, unchanged: 3, differing: 0, skipped: 0, failed: 0, tag: 'imported from .env file 2026-11-04' });
  assert.equal(decrypts, 3, 'each stored value is decrypted once (the key, the login\'s username and password), not once per pair');
  const token = v.list().find((info) => info.label === 'GITHUB_TOKEN')!;
  const password = v.list().find((info) => info.label === 'DB_PASSWORD')!;
  assert.deepEqual([token.kind, token.route, password.kind, password.route], ['token', 'keys', 'password', 'logins']);
  assert.equal(token.id, 'sec_github-token');
  assert.deepEqual(token.tags, ['imported from .env file 2026-11-04']);
  assert.match(token.description!, /^Imported from \.env on 2026-11-04; not described yet\.$/);
  assert.equal(token.createdBy, undefined, "the person's secrets stay theirs");
  assert.equal(await v.use(password.id, 'agt_any'), 'dbPass-42');
  assert.equal(v.list().filter((info) => info.label === 'OPENAI_API_KEY').length, 0, 'a value already stored is not stored twice');
  assert.ok(!JSON.stringify(v.list()).includes('ghp_secret_1') && !JSON.stringify(v.list()).includes('dbPass-42'), 'no value in metadata');
  const json = await importSecrets(v, '{"STRIPE_KEY":"sk_test_9"}', { fileName: 'keys.json', now: 0 });
  assert.deepEqual([json.format, json.keys], ['JSON file', 1]);
});

test('a project .env: plain settings stay out of the vault (no word of them masked), short values garble no tag', async () => {
  const { vault: v } = vault();
  const text = 'NODE_ENV=production\nAPP_URL=http://localhost:3000\nDEBUG=1\nWORKERS=2\nOTP_DIGITS=6\nAPI_KEY=sk-project-key-1\nSESSION_SECRET=s3ss10n-secret\n';
  const result = await importSecrets(v, text, { fileName: '.env', now: Date.UTC(2026, 10, 4) });
  assert.deepEqual([result.keys, result.skipped], [2, 5]);
  assert.equal(v.redact('Deploy to production on http://localhost:3000 with 1 or 2 workers'), 'Deploy to production on http://localhost:3000 with 1 or 2 workers');
  assert.equal(v.redact('key sk-project-key-1'), 'key secret://sec_api-key', 'the secrets are masked');
  const stored = v.list();
  assert.deepEqual(stored.map((info) => info.label).sort(), ['API_KEY', 'SESSION_SECRET']);
  for (const info of stored) {
    assert.deepEqual(info.tags, [result.tag], `${info.label}: the tag the review lists them by`);
    assert.doesNotMatch(info.description ?? '', /secret:\/\//, `${info.label}: an untouched description`);
  }
});

test('Bitwarden cards land in Payment as cards', async () => {
  const { vault: v } = vault();
  const result = await importSecrets(v, JSON.stringify({ items: [{ type: 3, name: 'Visa', card: { number: '4111111111111111', expMonth: '12', expYear: '2030', code: '999' } }] }), { now: 0 });
  assert.equal(result.cards, 1);
  const card = v.groups()[0];
  assert.equal(card.kind, 'card');
  assert.equal(card.route, 'payment');
});

test('the top Manager gets one review task and a wake; nothing new means no task', async () => {
  const created: Array<Record<string, unknown>> = [];
  const wakes: Array<Record<string, unknown>> = [];
  const services = {
    org: { list: () => [{ id: 'agt_mgr', name: 'Ava', template: 'manager', createdAt: 1 }, { id: 'agt_b', name: 'Ben', template: 'worker', createdAt: 0 }] },
    tasks: { create: (input: Record<string, unknown>) => { created.push(input); return { id: 'tsk_1' }; } },
    wakes: { wake: (input: Record<string, unknown>) => { wakes.push(input); } },
  } as unknown as RuntimeServices;
  const base = { format: 'Chrome', added: 3, cards: 0, keys: 0, unchanged: 0, differing: 1, skipped: 0, failed: 0, tag: 'imported from Chrome 2026-10-29' };
  const done = startReview(services, base);
  assert.equal(done.reviewTaskId, 'tsk_1');
  assert.equal(done.reviewer, 'Ava');
  assert.equal(created.length, 1);
  assert.equal(created[0].assigneeId, 'agt_mgr');
  assert.equal(created[0].conversationId, undefined, 'a chat-free task (B-054)');
  const notes = String(created[0].notes);
  assert.match(notes, /secrets\.list with text "imported from Chrome 2026-10-29"/);
  assert.match(notes, /1 login is tagged/);
  assert.match(notes, /one sign-in per site/);
  assert.match(notes, /A second try after a failure can lock an account/);
  assert.match(notes, /route file <route>\.md in the folder secrets\.list names/, 'names and descriptions are edited in the route file');
  assert.doesNotMatch(notes, /secrets\.describe|\bNever\b|\bnever a\b/, 'no tool that does not exist, references instead of rules');
  assert.deepEqual(wakes.map((wake) => [wake.agentId, wake.reason, wake.taskId]), [['agt_mgr', 'task', 'tsk_1']]);
  assert.equal(startReview(services, { ...base, added: 0 }).reviewTaskId, undefined);
  assert.equal(created.length, 1);
  assert.equal(startReview(services, { ...base, format: '.env file', added: 0, differing: 0, keys: 2 }).reviewTaskId, 'tsk_1', 'single values get the review too');
  assert.equal(created[1].title, 'Sort the 2 imported entries');
  assert.match(String(created[1].notes), /3\. No logins to check\./);
});

test('secrets.import (agent tool) reads a file on the PC by its path and returns counts, one line about the file and the follow-up, never a value', async () => {
  const { vault: v, clock } = vault();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-import-'));
  try {
    const file = path.join(dir, 'Chrome Passwords.csv');
    writeFileSync(file, CHROME.replace('nopass.example,https://nopass.example/,ada,,\r\n', ''));
    const tool = secretTools.find((entry) => entry.name === 'secrets.import')!;
    assert.match(tool.description, /^Import a password export or a key\/value file on this PC into the catalog/);
    assert.match(tool.description, /Give its path – the app reads it, so no value reaches me \(opening it with Read or cat would bring every value into my context\)/);
    const ctx = { services: { secrets: v, clock } as unknown as RuntimeServices, agent: { id: 'agt_a', name: 'A' } } as unknown as ToolContext;
    const out = await tool.run({ path: file }, ctx);
    const text = JSON.stringify(out);
    assert.match(text, /\\"added\\":2/);
    assert.match(text, /route file/);
    assert.doesNotMatch(text, /secrets\.describe|Tell the person to delete/);
    assert.ok(!text.includes('googlePass99') && !text.includes('pa,ss'), 'no value in the output');
    assert.match(text, /\\"file\\":\\"Deleted: every value is in the catalog now/);
    assert.equal(existsSync(file), false, "a known browser's complete export is deleted");
    assert.equal(v.groups()[0].createdBy, undefined, "the person's passwords stay theirs");
    // a .env stays where it is (a working file); a partial import keeps the export
    const env = path.join(dir, '.env');
    writeFileSync(env, 'SHOP_API_KEY=shop-key-77\n');
    const kept = JSON.stringify(await tool.run({ path: env }, ctx));
    assert.match(kept, /\\"keys\\":1/);
    assert.match(kept, /Kept: a \.env or JSON file is a working file of its own/);
    assert.ok(existsSync(env) && !kept.includes('shop-key-77'));
    const broken = path.join(dir, 'Bitwarden.json');
    writeFileSync(broken, JSON.stringify({ items: [{ type: 1, name: 'Bad 2FA', login: { username: 'u', password: 'pw-1', totp: 'not-a-key!!' } }] }));
    const partial = { ...v, saveGroup: async () => { throw new Error('the vault refused it'); }, list: () => v.list(), groups: () => v.groups(), loginPrints: () => v.loginPrints() };
    const refused = JSON.stringify(await tool.run({ path: broken }, { ...ctx, services: { secrets: partial, clock } } as unknown as ToolContext));
    assert.match(refused, /Kept: 1 entry was not stored completely .*so the export stays at/);
    assert.equal(existsSync(broken), true, 'an incomplete import keeps the export');
    const missing = await tool.run({ path: path.join(dir, 'nope.csv') }, ctx);
    assert.match(JSON.stringify(missing), /could not be read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secrets.import keeps the export unless a known export went in whole: a lost 2FA key, skipped entries, a CSV of no known manager', async () => {
  const { vault: v, clock } = vault();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-import-'));
  const tool = secretTools.find((entry) => entry.name === 'secrets.import')!;
  const ctx = { services: { secrets: v, clock } as unknown as RuntimeServices, agent: { id: 'agt_a', name: 'A' } } as unknown as ToolContext;
  const run = async (name: string, content: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    const out = ((await tool.run({ path: file }, ctx)) as { structured?: Record<string, unknown> }).structured ?? {};
    return { out, kept: existsSync(file) };
  };
  try {
    const seed = await run('bitwarden_export.json', JSON.stringify({ items: [{ type: 1, name: 'Bank', login: { username: 'ada', password: 'bankPass777', totp: 'not-a-key!!' } }] }));
    assert.deepEqual([seed.out.added, seed.out.failed, seed.kept], [1, 1, true], 'the login is stored, its 2FA key only in the export, which stays');
    assert.match(String(seed.out.file), /^Kept: 1 entry was not stored completely \(e\.g\. a 2FA key the vault could not read\)/);
    const notes = await run('bitwarden_notes.json', JSON.stringify({ items: [{ type: 1, name: 'Mail', login: { username: 'ada', password: 'mailPass888' } }, { type: 2, name: 'A note', notes: 'text' }] }));
    assert.deepEqual([notes.out.added, notes.out.skipped, notes.kept], [1, 1, true]);
    assert.match(String(notes.out.file), /^Kept: 1 entry was not imported/);
    const users = await run('users.csv', 'name,email,password\nAda,ada@example.com,fixturePass1\n');
    assert.deepEqual([users.out.format, users.out.added, users.kept], ['a password export', 1, true]);
    assert.match(String(users.out.file), /^Kept: not a known password manager's export/);
    const chrome = await run('Chrome Passwords.csv', 'name,url,username,password,note\nshop.example,https://shop.example/,ada,shopPass123,\n');
    assert.deepEqual([chrome.out.format, chrome.out.added, chrome.kept], ['Chrome', 1, false]);
    assert.match(String(chrome.out.file), /^Deleted: /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
