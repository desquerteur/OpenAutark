// The route files of the secrets catalog (owner 29.10.2026 – a catalog like a skill; runtime/secrets/files.ts,
// file-format.ts): <data>/secrets/<route>.md lists several entries – id, name (## heading), kind, tags, source,
// fields and the description, never a value or hint; written at start and on every vault change; an entry that changes
// its route leaves its old file; a disk edit of a name, description or tags reaches the vault, an edit of kind or source
// is ignored with a quiet notice and a rejected copy; an entry without a vault entry is "value missing" until the
// person stores a value (or deletes it); the legacy per-entry files <id>.md migrate into their route files at start;
// Owns: these assertions only. Never: a real keychain or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { SecretFiles } from '../../../src/runtime/secrets/files.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ROOT_SECRETS } from '../../../src/runtime/root/layout.ts';
import { parseRouteFile, renderRouteFile } from '../../../src/runtime/secrets/file-format.ts';
import { tempDir } from '../store/helpers.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};
const VALUE = 'sk-live-files-test-0000111122223333';

async function setup(t: { after(fn: () => void): void }) {
  const temp = tempDir('wf-secret-files-');
  t.after(temp.cleanup);
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const log = new MemoryLogger();
  const vault = new SecretVault({ db, host, clock });
  const events: unknown[] = [];
  const root = new RootWatcher({ root: temp.dir, clock, log, watch: false });
  root.start();
  const files = new SecretFiles({ dataDir: temp.dir, vault, clock, log, bus: { emit: (_event: string, data: unknown) => { events.push(data); } } as never, root });
  t.after(() => { files.stop(); root.stop(); });
  const file = (name: string) => path.join(temp.dir, ROOT_SECRETS, `${name}.md`);
  const read = (name: string) => readFileSync(file(name), 'utf8');
  /** A person's edit on disk, handed to the owner the way the watcher does. */
  const edit = async (name: string, text: string) => { writeFileSync(file(name), text); root.nudge(ROOT_SECRETS, [`${name}.md`]); await files.flush(); };
  return { dir: temp.dir, db, vault, files, root, events, file, read, edit };
}

test('start writes one file per route listing several entries – name, id, kind, tags, source, fields, description; never a value or hint', async (t) => {
  const f = await setup(t);
  const key = await f.vault.save({ label: 'Stripe key', kind: 'api_key', value: VALUE, hint: '3333', description: 'Refunds and payouts.', source: 'dashboard.stripe.com', tags: ['for the API at api.stripe.com'] });
  const token = await f.vault.save({ label: 'GitHub token', kind: 'token', value: 'ghp_files_test_0001', description: 'CI releases.' });
  const login = await f.vault.saveGroup({ label: 'Support login', kind: 'login', fields: [{ field: 'username', kind: 'text', value: 'ada@example.com' }, { field: 'password', kind: 'password', value: 'Pw-files-4821' }] });
  const counts = await f.files.start();
  assert.equal(counts.written, 2, 'two routes: keys and logins');
  const keys = f.read('keys');
  assert.match(keys, /^---\nroute: keys\n# .*\n---\n## GitHub token\n/);
  assert.ok(keys.includes(`## Stripe key\n- id: ${key.id}\n- kind: api_key\n- tags: for the API at api.stripe.com\n- source: dashboard.stripe.com\n\nRefunds and payouts.`), keys);
  assert.ok(keys.includes(`- id: ${token.id}\n- kind: token\n\nCI releases.`), 'several entries in one route file');
  const logins = f.read('logins');
  assert.match(logins, new RegExp(`## Support login\\n- id: ${login.group.id}\\n- kind: login\\\n- fields: username · text · secret://\\S+; password · password · secret://\\S+`));
  for (const text of [keys, logins]) for (const value of [VALUE, '3333', 'Pw-files-4821', 'ada@example.com', 'a•••', 'ghp_files']) assert.ok(!text.includes(value), value);
  assert.equal(existsSync(f.file(key.id)), false, 'no per-entry files any more');
});

test('every vault change rewrites the route files; an entry that changes its route or moves into a group leaves its old file', async (t) => {
  const f = await setup(t);
  await f.files.start();
  const key = await f.vault.save({ label: 'Deploy key', kind: 'api_key', value: VALUE });
  await f.files.flush();
  assert.match(f.read('keys'), /## Deploy key/);
  await f.vault.save({ id: key.id, label: 'Deploy key', kind: 'api_key', route: 'servers' });
  await f.files.flush();
  assert.equal(existsSync(f.file('keys')), false, 'the empty route file goes');
  assert.match(f.read('servers'), new RegExp(`- id: ${key.id}`));
  const pw = await f.vault.save({ label: 'Mail password', kind: 'password', value: 'Pw-mail-123' });
  await f.vault.saveGroup({ label: 'Mail', kind: 'login', fields: [{ id: pw.id, field: 'password', kind: 'password' }] });
  await f.files.flush();
  const logins = f.read('logins');
  assert.ok(!logins.includes(`- id: ${pw.id}\n`) && logins.includes(`secret://${pw.id}`), 'only as a field of its login');
  f.vault.remove(key.id);
  await f.files.flush();
  assert.equal(existsSync(f.file('servers')), false);
  assert.ok(f.events.length > 0, 'secrets.changed told');
});

test('a disk edit of a name, description or tags is the person\'s edit; kind and source edits are ignored with a quiet notice', async (t) => {
  const f = await setup(t);
  const key = await f.vault.save({ label: 'Stripe key', kind: 'api_key', value: VALUE, description: 'Refunds.', source: 'stripe.com' });
  await f.files.start();
  const text = f.read('keys');
  await f.edit('keys', text.replace('## Stripe key', '## Stripe live key').replace('Refunds.', `Refunds and payouts – never ${VALUE}.`).replace('- source: stripe.com', '- tags: payments; live\n- source: stripe.com'));
  const info = f.vault.list().find((entry) => entry.id === key.id)!;
  assert.deepEqual([info.label, info.description, info.tags], ['Stripe live key', `Refunds and payouts – never secret://${key.id}.`, ['payments', 'live']], 'a value in the text is stored as its handle');
  assert.equal(f.files.notices().length, 0);
  await f.edit('keys', f.read('keys').replace('- source: stripe.com', '- source: evil.example'));
  assert.deepEqual([f.vault.list()[0].source], ['stripe.com'], 'the source is the app\'s');
  assert.deepEqual(f.files.notices().map((notice) => [notice.id, notice.problem]), [['keys', 'read-only']]);
  assert.ok(existsSync(path.join(f.dir, ROOT_SECRETS, 'keys.rejected.md')), 'the person\'s text is kept');
  assert.match(f.read('keys'), /- source: stripe.com/);
  await f.edit('keys', f.read('keys').replace('## Stripe live key', '## '));
  assert.equal(f.vault.list()[0].label, 'Stripe live key', 'an entry without a name is refused');
  assert.equal(f.files.notices()[0].problem, 'invalid');
});

test('a hand-written entry without a vault entry is "value missing" until the person stores a value; delete removes it', async (t) => {
  const f = await setup(t);
  await f.vault.save({ label: 'Existing', kind: 'note', value: 'note-value-1' });
  await f.files.start();
  await f.edit('notes', `${f.read('notes')}\n\n## Wifi at the office\n- id: wifi-office\n- kind: password\n- tags: office\n\nThe guest network password.`);
  const [missing] = f.files.missing();
  assert.deepEqual(missing, { id: 'wifi-office', name: 'Wifi at the office', purpose: 'The guest network password.', kind: 'password', route: 'notes', tags: ['office'] });
  assert.match(f.read('notes'), /## Wifi at the office\n- id: wifi-office/, 'kept in its file');
  await f.vault.save({ id: 'wifi-office', label: missing.name, kind: 'password', value: 'guest-pw-2026', description: missing.purpose, route: missing.route });
  await f.files.flush();
  assert.deepEqual(f.files.missing(), [], 'now the vault\'s entry');
  assert.match(f.read('notes'), /## Wifi at the office\n- id: wifi-office\n- kind: password\n\nThe guest network password\./);
  assert.ok(!f.read('notes').includes('guest-pw-2026'));
  f.vault.remove('wifi-office');
  await f.files.flush();
  assert.ok(!f.read('notes').includes('wifi-office'), 'deleted with the entry');
});

test('legacy per-entry files <id>.md migrate into their route files at start: an edited name is taken over, a file without a value becomes "value missing"', async (t) => {
  const f = await setup(t);
  const key = await f.vault.save({ label: 'Old name', kind: 'api_key', value: VALUE, description: 'Old purpose.' });
  mkdirSync(path.join(f.dir, ROOT_SECRETS), { recursive: true });
  writeFileSync(f.file(key.id), `---\n# note\nid: ${key.id}\nname: "Renamed while closed"\nkind: api_key\ndomains: ["api.example.com"]\nfields: []\naccess: ["all agents"]\n---\nNew purpose.`);
  writeFileSync(f.file('sec_0123456789abcdef01234567'), '---\nid: sec_0123456789abcdef01234567\nname: "Server root"\nkind: password\ndomains: []\nfields: []\naccess: ["all agents"]\n---\nSSH login of the build server.');
  const counts = await f.files.start();
  assert.ok(counts.taken >= 2, JSON.stringify(counts));
  assert.equal(existsSync(f.file(key.id)), false, 'the legacy file is gone');
  assert.equal(existsSync(f.file('sec_0123456789abcdef01234567')), false);
  assert.deepEqual([f.vault.list()[0].label, f.vault.list()[0].description], ['Renamed while closed', 'New purpose.']);
  assert.match(f.read('keys'), /## Renamed while closed/);
  assert.deepEqual(f.files.missing().map((entry) => [entry.id, entry.name, entry.route]), [['sec_0123456789abcdef01234567', 'Server root', 'servers']]);
  assert.match(f.read('servers'), /## Server root\n- id: sec_0123456789abcdef01234567\n- kind: password/);
});

test('parse: names with quotes and headings in a description round-trip', async (t) => {
  const f = await setup(t);
  const key = await f.vault.save({ label: 'Say "hi" key', kind: 'api_key', value: VALUE, description: 'Line one\n## not a heading\nLine three' });
  await f.files.start();
  const parsed = parseRouteFile(f.read('keys'));
  assert.equal(parsed.route, 'keys');
  assert.deepEqual(parsed.entries.map((entry) => [entry.id, entry.name, entry.purpose]), [[key.id, 'Say "hi" key', 'Line one\n## not a heading\nLine three']]);
  assert.equal(renderRouteFile('keys', []), '---\nroute: keys\n' + renderRouteFile('keys', []).split('\n').slice(2).join('\n'));
});
