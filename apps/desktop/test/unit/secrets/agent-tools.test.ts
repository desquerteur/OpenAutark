// Secrets for agents (PM6; owner 29.10.2026 – a catalog like a skill with zero restrictions, card data included):
// secrets.list (metadata in the agent's scope – route, tags, source –, never values) and secrets.generate
// (crypto.randomInt, in the catalog for every agent, recorded as the agent's, saved from the registrable domain – not
// bound to it –, only the handle comes back); nothing binds on use and nobody can restrict a secret to sites; browser.act
// fills a password or a card on any host; tools.find leads to secrets.import for an export or a .env (04.11.2026).
// Owns: these assertions only. Never: a real browser or keychain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { generatePassword, hostOf, registrableDomain, SecretVault } from '../../../src/runtime/secrets/service.ts';
import { browserTools } from '../../../src/runtime/browser/tools.ts';
import type { BrowserService } from '../../../src/runtime/browser/service.ts';
import { secretTools } from '../../../src/runtime/tools/builtin/secrets.ts';
import { skillTools } from '../../../src/runtime/tools/builtin/skills.ts';
import { rankTools } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const vault = new SecretVault({ db, host, clock: new ManualClock() });
  const logs: string[] = [];
  const log = { debug() {}, info: (message: string, data?: unknown) => logs.push(`${message} ${JSON.stringify(data ?? {})}`), warn() {}, error() {} };
  const services = { db, secrets: vault, log, devices: { self: () => ({ id: 'dev_self', name: 'Desk' }), list: () => [] } } as unknown as RuntimeServices;
  const ctx = (agentId = 'ag_mira'): ToolContext => ({
    agent: { id: agentId, name: agentId === 'ag_mira' ? 'Mira' : 'Ben' } as ToolContext['agent'], runId: 'run_1', mode: 'browser', services, signal: new AbortController().signal, status() {},
  });
  return { db, vault, services, ctx, logs };
}

const tool = (name: string) => secretTools.find((entry) => entry.name === name)!;
const all = (out: ToolOutput) => JSON.stringify(out);

test('registrable domains, hosts and generated passwords', () => {
  assert.equal(registrableDomain('https://accounts.example.com/signin?x=1'), 'example.com');
  assert.equal(registrableDomain('login.shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('www.bank.com.au'), 'bank.com.au');
  assert.equal(registrableDomain('example.de'), 'example.de');
  assert.equal(registrableDomain('192.168.1.20'), '192.168.1.20');
  assert.equal(registrableDomain('not a host'), undefined);
  // Shared hosting: every tenant is its own site (no binding to all of github.io).
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
  assert.equal(registrableDomain('https://login.alice.github.io/x'), 'alice.github.io');
  assert.equal(registrableDomain('myapp.herokuapp.com'), 'myapp.herokuapp.com');
  assert.equal(registrableDomain('bucket.s3.amazonaws.com'), 'bucket.s3.amazonaws.com');
  assert.equal(registrableDomain('github.io'), 'github.io');
  assert.equal(registrableDomain('docs.github.com'), 'github.com', 'a normal domain is unchanged');
  assert.equal(hostOf('https://WWW.Example.com:8443/path'), 'example.com');
  const password = generatePassword(24);
  assert.equal(password.length, 24);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /[2-9]/);
  assert.match(password, /[!#$%&*+\-=?@_~]/);
  assert.doesNotMatch(generatePassword(30, false), /[!#$%&*+\-=?@_~]/);
  assert.equal(generatePassword(4).length, 12, 'at least 12');
  assert.notEqual(generatePassword(), generatePassword());
});

test('secrets.list shows every secret and never a value – like a skill index with route, tags and source', async () => {
  const t = setup();
  await t.vault.save({ label: 'Shop login', kind: 'password', value: 'hunter2-shop', source: 'shop.example' });
  await t.vault.save({ label: 'Team card', kind: 'card', value: '4111111111111234' });
  await t.vault.save({ label: 'Ben only', kind: 'api_key', value: 'sk-ben-0000' });
  const out = await tool('secrets.list').run({}, t.ctx());
  const result = out.structured as { note: string; secrets: Array<{ id: string; handle: string; name: string; kind: string; route: string; domains?: unknown }> };
  assert.deepEqual(result.secrets.map((entry) => [entry.name, entry.kind, entry.route]), [['Ben only', 'api_key', 'keys'], ['Shop login', 'password', 'logins'], ['Team card', 'card', 'payment']]);
  assert.equal(result.secrets[1].handle, `secret://${result.secrets[1].id}`);
  assert.match(result.secrets[1].handle, /^secret:\/\/sec_/);
  assert.ok(result.secrets.every((entry) => entry.domains === undefined), 'owner 29.10.2026: no site restriction is listed – there is none');
  assert.match(result.note, /cards included/);
  const saved = await t.vault.save({ label: 'Forum password', kind: 'password', value: 'pw-forum-list', source: 'forum.example', tags: ['for the web at forum.example'] });
  const listed = ((await tool('secrets.list').run({ text: 'forum.example' }, t.ctx())).structured as { secrets: Array<{ id: string; tags?: string[]; savedFrom?: string }> }).secrets;
  assert.deepEqual(listed.map((entry) => [entry.id, entry.tags, entry.savedFrom]), [[saved.id, ['for the web at forum.example'], 'forum.example']], 'found by the site it was saved from');
  assert.equal(((await tool('secrets.list').run({ route: 'payment' }, t.ctx())).structured as { count: number }).count, 1, 'by route');
  for (const value of ['hunter2-shop', '4111111111111234', 'sk-ben-0000']) assert.ok(!all(out).includes(value), value);
  assert.equal(tool('secrets.list').category, 'read');
  assert.deepEqual(((await tool('secrets.list').run({ text: 'shop' }, t.ctx())).structured as { count: number }).count, 1);
});

test('secrets.generate: in the catalog for every agent, recorded as the agent\'s, saved from the site (no binding), only the handle comes back', async () => {
  const t = setup();
  const out = await tool('secrets.generate').run({ site: 'https://accounts.example.com/signup', length: 24 }, t.ctx());
  assert.equal(out.isError, undefined);
  const result = out.structured as { handle: string; label: string; savedFrom: string };
  const [info] = t.vault.list();
  assert.equal(result.handle, `secret://${info.id}`);
  assert.equal(result.savedFrom, 'example.com');
  assert.deepEqual([info.kind, info.source, info.label, info.createdBy, info.route, info.tags], ['password', 'example.com', 'Mira · example.com', 'ag_mira', 'logins', ['for the web at example.com']]);
  const value = await t.vault.use(info.id, 'human');
  assert.equal(value.length, 24);
  assert.ok(!all(out).includes(value), 'the value is not in the output');
  assert.ok(!t.logs.join('\n').includes(value), 'nor in the log');
  assert.equal(t.vault.redact(`typed ${value}`), `typed secret://${info.id}`, 'a leak would be redacted');
  assert.equal(await t.vault.use(info.id, 'ag_ben', 'example.com'), value, 'every agent may use it');
  assert.equal(await t.vault.use(info.id, 'ag_mira', 'other-service.example'), value, 'it works on another site too');
  const plain = await tool('secrets.generate').run({ label: 'Build DB', purpose: 'Postgres on the build box' }, t.ctx());
  assert.notEqual(plain.isError, true, 'no web site needed (review intent #9)');
  const server = t.vault.list().find((entry) => entry.label === 'Build DB')!;
  assert.deepEqual([server.source, server.tags?.length ?? 0], [undefined, 0]);
  assert.match(tool('secrets.generate').describe!({ site: 'https://a.b.example.com' }, t.ctx()).summary, /for example\.com$/);
});

test('owner 29.10.2026: no restriction anywhere – nothing binds on use, cards included; nobody can set one', async () => {
  const t = setup();
  for (const [kind, value] of [['password', 'pw-forum-0'], ['api_key', 'sk-any-1'], ['card', '4111111111111234'], ['note', 'note-value-1']] as const) {
    const info = await t.vault.save({ label: `Any ${kind}`, kind, value });
    for (const where of ['https://login.forum.example.co.uk/', 'evil.example', 'https://alice.github.io/', 'mallory.github.io', undefined]) {
      assert.equal(await t.vault.use(info.id, 'ag_mira', where), value, `${kind} on ${where ?? 'no host'}`);
    }
    assert.equal(t.db.get<{ domains: string }>('SELECT domains FROM secrets WHERE id = ?', [info.id])!.domains, '[]', `${kind}: nothing bound`);
  }
  assert.equal('allowHost' in t.vault, false, 'there is no way to restrict a secret to a host');
  assert.equal('approvedOn' in t.vault, false);
  // A person's input cannot carry a restriction: the RPC refuses the key, the vault has no such field.
  const card = await t.vault.save({ label: 'Visa', kind: 'card', value: '4111111111119999', ...({ domains: ['shop.example'] } as object) } as never);
  assert.equal(await t.vault.use(card.id, 'ag_mira', 'other-shop.example'), '4111111111119999');
  assert.equal(await t.vault.use(card.id, 'ag_ben', 'shop.example'), '4111111111119999', 'every agent');
});

test('owner 04.11.2026: an agent looking for a way to bring in a password export or a .env finds secrets.import first', () => {
  const specs = [...secretTools, ...skillTools];
  for (const query of ['import the passwords exported from chrome', 'import a .env file with keys', 'csv export of my logins']) {
    assert.equal(rankTools(specs, query, 3)[0]?.name, 'secrets.import', query);
  }
  assert.match(tool('secrets.import').description, /a \.env file or a flat JSON of names and values/);
});

/** A browser whose page sits on `page.host`. */
function fakeBrowser(page: { host: string }) {
  const filled: string[] = [];
  const browser = {
    pageFacts: () => ({ tab: 't1', host: page.host, url: `https://${page.host}/login` }),
    act: async (_agent: string, input: { secret?: (host: string) => Promise<string> }) => {
      if (input.secret) filled.push(await input.secret(page.host));
      return { tab: 't1', url: `https://${page.host}/login`, title: 'Login', snapshot: '', truncated: false, action: 'fill', changed: true, urlChanged: false };
    },
  } as unknown as BrowserService;
  return { act: browserTools(browser).find((entry) => entry.name === 'browser.act')!, filled };
}
