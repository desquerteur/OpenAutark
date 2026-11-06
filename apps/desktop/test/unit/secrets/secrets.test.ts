// SecretVault: encryption via host, the access check (owner 29.10.2026: nothing else – no site restriction, cards
// included), routes and tags of the catalog, the host matcher (domainAllowed – used to name a source, never to restrict),
// redaction of raw and encoded values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { SecretVault, domainAllowed } from '../../../src/runtime/secrets/service.ts';

/** Reversible fake "keychain": XOR so ciphertext never equals plaintext. */
const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), byte => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, byte => byte ^ 0x5a)).toString('utf8'),
};

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  return { db, vault: new SecretVault({ db, host, clock: new ManualClock() }) };
}

test('values are stored encrypted and never listed', async () => {
  const { db, vault } = setup();
  const info = await vault.save({ label: 'Company Visa', kind: 'card', value: '4111 1111 1111 1234' });
  assert.equal(info.hint, '•••• 1234');
  const row = db.get<{ cipher: Uint8Array }>('SELECT cipher FROM secrets WHERE id = ?', [info.id])!;
  assert.ok(!Buffer.from(row.cipher).toString('utf8').includes('4111'));
  assert.ok(!JSON.stringify(vault.list()).includes('4111'));
  assert.equal(await vault.use(info.id, 'human'), '4111 1111 1111 1234');
});

test('no scope: a password and a card work for every agent on every site, nothing binds on use (owner 29.10.2026)', async () => {
  const { vault } = setup();
  const login = await vault.save({ label: 'YouTube login', kind: 'password', value: 'correct-horse-battery', source: 'google.com' });
  assert.equal(await vault.use(login.id, 'ag_other', 'accounts.google.com'), 'correct-horse-battery');
  assert.equal(await vault.use(login.id, 'ag_video', 'evil-google.com'), 'correct-horse-battery');
  const info = await vault.save({ label: 'Shop card', kind: 'card', value: '4111111111111234', source: 'google.com' });
  assert.equal(await vault.use(info.id, 'ag_other', 'accounts.google.com'), '4111111111111234');
  assert.equal(await vault.use(info.id, 'ag_video'), '4111111111111234', 'no destination needed');
  assert.equal(await vault.use(info.id, 'ag_video', 'another-shop.example'), '4111111111111234', 'any shop');
  assert.equal(await vault.use(info.id, 'ag_video', 'https://accounts.google.com/signin'), '4111111111111234');
  assert.equal(vault.list().find((entry) => entry.id === info.id)!.route, 'payment');
  assert.ok(vault.list()[0].lastUsedAt);
});

test('redact replaces raw, base64, url-encoded and hex variants; short values are ignored', async () => {
  const { vault } = setup();
  const key = await vault.save({ label: 'OpenAI key', kind: 'api_key', value: 'sk-test/abc+123=xyz' });
  await vault.save({ label: 'PIN', kind: 'password', value: '1234' });
  const text = [
    'key sk-test/abc+123=xyz',
    Buffer.from('sk-test/abc+123=xyz').toString('base64'),
    encodeURIComponent('sk-test/abc+123=xyz'),
    'pin 1234',
  ].join(' | ');
  const redacted = vault.redact(text);
  assert.equal(redacted.split(`secret://${key.id}`).length - 1, 3);
  assert.ok(redacted.includes('pin 1234'));
  assert.ok(!redacted.includes('sk-test'));
});

test('init primes redaction from stored ciphertexts; remove forgets', async () => {
  const { db, vault } = setup();
  const info = await vault.save({ label: 'Token', kind: 'token', value: 'ghp_abcdefghijklmnop' });
  const fresh = new SecretVault({ db, host, clock: new ManualClock() });
  assert.equal(fresh.redact('x ghp_abcdefghijklmnop'), 'x ghp_abcdefghijklmnop');
  await fresh.init();
  assert.equal(fresh.redact('x ghp_abcdefghijklmnop'), `x secret://${info.id}`);
  fresh.remove(info.id);
  assert.equal(fresh.redact('ghp_abcdefghijklmnop'), 'ghp_abcdefghijklmnop');
  await assert.rejects(fresh.use(info.id, 'human'), /not found/);
});

test('update keeps the value when none is given', async () => {
  const { vault } = setup();
  const info = await vault.save({ label: 'A', kind: 'note', value: 'remember-this-long' });
  await vault.save({ id: info.id, label: 'B', kind: 'note' });
  assert.equal(vault.list()[0].label, 'B');
  assert.equal(await vault.use(info.id, 'human'), 'remember-this-long');
});

test('domainAllowed', () => {
  assert.ok(domainAllowed('google.com', ['google.com']));
  assert.ok(domainAllowed('mail.google.com', ['google.com']));
  assert.ok(!domainAllowed('notgoogle.com', ['google.com']));
  assert.ok(domainAllowed('a.x.com', ['*.x.com']));
  assert.ok(!domainAllowed('x.com', ['*.x.com']));
  assert.ok(domainAllowed('www.x.com', ['*.x.com']));
  // Rules as typed in Settings › Secrets: scheme, path, port, case and www do not matter …
  assert.ok(domainAllowed('bank.example', ['www.bank.example']), 'the judged host (www stripped)');
  assert.ok(domainAllowed('https://www.bank.example/login', ['www.bank.example']), 'the raw page host');
  assert.ok(domainAllowed('bank.example', ['https://Bank.Example:443/login']));
  assert.ok(domainAllowed('login.bank.example', ['https://bank.example/']));
  // … but a www rule names that one site, not every subdomain.
  assert.ok(!domainAllowed('login.bank.example', ['www.bank.example']));
  assert.ok(!domainAllowed('https://good.example@evil.example/', ['good.example']), 'userinfo is not the host');
  assert.ok(!domainAllowed('bank.example', ['not a domain', '']));
  assert.ok(domainAllowed('localhost:3000', ['localhost']));
});

test('routes and tags: chosen automatically, named routes and tags are cleaned, an edit keeps them', async () => {
  const { vault } = setup();
  const ssh = await vault.save({ label: 'Build box', kind: 'password', value: 'pw-build-box-1', description: 'SSH login of the build server' });
  assert.equal(ssh.route, 'servers', 'server words pick servers');
  const named = await vault.save({ label: 'Thing', kind: 'note', value: 'note-value-1', route: ' Home Lab ', tags: ['for the web at a.example', ' x;y ', 'FOR THE WEB AT A.EXAMPLE'] });
  assert.deepEqual([named.route, named.tags], ['home-lab', ['for the web at a.example', 'x,y']]);
  await vault.save({ id: named.id, label: 'Thing 2', kind: 'note' });
  assert.deepEqual([vault.list().find((entry) => entry.id === named.id)!.route, vault.list().find((entry) => entry.id === named.id)!.tags], ['home-lab', ['for the web at a.example', 'x,y']], 'kept on update');
  await assert.rejects(vault.save({ label: 'Bad', kind: 'note', value: 'x', route: 'no/route' }), /no route name/);
  // There is no site restriction to set: an old caller's `domains` is not part of the input any more and stores nothing.
  const old = await vault.save({ label: 'Old caller', kind: 'card', value: '4111111111111234', ...({ domains: ['bank.example'] } as object) } as never);
  assert.equal((old as { domains?: unknown }).domains, undefined);
  assert.equal(await vault.use(old.id, 'ag_any', 'https://elsewhere.example/'), '4111111111111234');
});
