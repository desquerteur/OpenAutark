// Review round 2 of the secrets catalog (owner 29.10.2026 – a catalog like a skill, zero restrictions): a named
// section without an id in a route file gets one and stays as "value missing" (never silently dropped); a known entry's
// section in another route's file moves the entry there; a description that starts like an info line stays
// description; secrets.save gets its value as given (the leak guard leaves vault arguments alone), never names a
// secret the agent may not use, and saves a server login with a username; typing on the screen takes handles (the
// 'secret' category, the value only at run, what comes back masked).
// Owns: these assertions only. Never: a real keychain, screen or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { SecretFiles } from '../../../src/runtime/secrets/files.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ROOT_SECRETS } from '../../../src/runtime/root/layout.ts';
import { parseRouteFile } from '../../../src/runtime/secrets/file-format.ts';
import { withoutSecretValues } from '../../../src/runtime/secrets/guard.ts';
import { judgeTyped, typedText } from '../../../src/runtime/secrets/handles.ts';
import { secretTools } from '../../../src/runtime/tools/builtin/secrets.ts';
import { VAULT_ARGS } from '../../../src/runtime/tools/registry.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { tempDir } from '../store/helpers.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};
const OLD = 'Summer2024!pw-old';

function vaultSetup() {
  const db = new Db(':memory:');
  migrate(db);
  const vault = new SecretVault({ db, host, clock: new ManualClock() });
  const services = { db, secrets: vault, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as RuntimeServices;
  const ctx = (agentId = 'ag_mira'): ToolContext => ({
    agent: { id: agentId, name: 'Mira' } as ToolContext['agent'], runId: 'run_1', mode: 'general', services, signal: new AbortController().signal, status() {},
  });
  return { db, vault, services, ctx };
}

const tool = (name: string) => secretTools.find((entry) => entry.name === name)!;
const all = (out: ToolOutput) => JSON.stringify(out);

test('route files: a named section without an id gets one and stays "value missing"; a section in another route file moves the entry', async (t) => {
  const temp = tempDir('wf-secret-review-');
  t.after(temp.cleanup);
  const { vault } = vaultSetup();
  const clock = new ManualClock();
  const root = new RootWatcher({ root: temp.dir, clock, log: new MemoryLogger(), watch: false });
  root.start();
  const files = new SecretFiles({ dataDir: temp.dir, vault, clock, log: new MemoryLogger(), root });
  t.after(() => { files.stop(); root.stop(); });
  const file = (name: string) => path.join(temp.dir, ROOT_SECRETS, `${name}.md`);
  const edit = async (name: string, text: string) => { writeFileSync(file(name), text); root.nudge(ROOT_SECRETS, [`${name}.md`]); await files.flush(); };

  const key = await vault.save({ label: 'Deploy key', kind: 'api_key', value: 'deploy-key-value-0001', description: 'Deploys.' });
  await files.start();
  assert.equal(vault.list()[0].route, 'keys');

  // An AI appends an entry without an id to servers.md.
  await edit('servers', '---\nroute: servers\n---\n## Staging DB\n- kind: password\n\nPostgres of the staging box.\n');
  const servers = readFileSync(file('servers'), 'utf8');
  assert.match(servers, /## Staging DB\n- id: sec_staging-db\n/, servers);
  assert.deepEqual(files.missing().map((entry) => [entry.id, entry.name, entry.route]), [['sec_staging-db', 'Staging DB', 'servers']]);

  // The person moves the deploy key's section into servers.md.
  const moved = readFileSync(file('servers'), 'utf8') + `\n\n## Deploy key\n- id: ${key.id}\n- kind: api_key\n\nDeploys to the build server.\n`;
  await edit('servers', moved);
  const after = vault.list().find((entry) => entry.id === key.id)!;
  assert.deepEqual([after.route, after.description], ['servers', 'Deploys to the build server.']);
  await files.flush();
  assert.ok(!readFileSync(file('servers'), 'utf8').includes('deploy-key-value'), 'never a value');
});

test('a description that starts like an info line stays description', () => {
  const parsed = parseRouteFile('---\nroute: keys\n---\n## CI token\n- id: sec_ci\n- kind: token\n\n- access: read-only scope on the org\nUsed by CI.\n');
  assert.equal(parsed.entries[0].purpose, '- access: read-only scope on the org\nUsed by CI.');
});

test('secrets.save: its value passes the guard as given; another agent\'s secret is never named; a server login with a username', async () => {
  const t = vaultSetup();
  const old = await t.vault.save({ label: 'Old', kind: 'password', value: OLD });
  const args = { name: `about ${OLD}`, description: 'x', value: `${OLD}x` };
  const guarded = withoutSecretValues(t.vault, args, VAULT_ARGS.get('secrets.save'));
  assert.deepEqual(guarded, { name: `about secret://${old.id}`, description: 'x', value: `${OLD}x` }, 'the value stays as typed, the rest is redacted');

  const fresh = await tool('secrets.save').run({ name: 'New password', description: 'Mail', value: `${OLD}x`, kind: 'password' }, t.ctx());
  const id = (fresh.structured as { id: string }).id;
  assert.equal(await t.vault.use(id, 'ag_mira'), `${OLD}x`, 'saved as typed, never with a handle inside');
  const same = await tool('secrets.save').run({ name: 'Ben\'s again', description: 'Mail', value: OLD, kind: 'password' }, t.ctx());
  assert.ok(all(same).includes(old.id), 'the value is stored already: its handle comes back');

  const login = await tool('secrets.save').run({ name: 'Build box SSH', description: 'SSH login of the build server', value: 'pw-build-ssh-77', kind: 'password', username: 'deploy' }, t.ctx());
  const out = login.structured as { id: string; route: string; handles: Record<string, string> };
  assert.equal(out.route, 'servers');
  assert.deepEqual(Object.keys(out.handles).sort(), ['password', 'username']);
  assert.ok(!all(login).includes('pw-build-ssh-77'));
  const group = t.vault.groups().find((entry) => entry.id === out.id)!;
  assert.deepEqual([group.kind, group.createdBy], ['login', 'ag_mira']);
});

test('typing on the screen takes handles: the secret category, the value only at run, what comes back masked', async () => {
  const t = vaultSetup();
  const info = await t.vault.save({ label: 'App password', kind: 'password', value: 'pw-desktop-app-31' });
  const ctx = t.ctx();
  const action = judgeTyped(ctx, { summary: 'Type 30 characters', reversible: true, external: false }, `secret://${info.id}`);
  assert.match(action.summary, /typed on screen – a screenshot can show it/);
  assert.throws(() => judgeTyped(t.ctx('ag_ben'), { summary: 'x', reversible: true, external: false }, 'secret://sec_unknown'), /not in the secrets catalog/);
  const typed = await typedText(ctx, `secret://${info.id}\n`);
  assert.equal(typed.text, 'pw-desktop-app-31\n');
  assert.equal(typed.mask('Now: Edit "Password" value=pw-desktop-app-31'), `Now: Edit "Password" value=secret://${info.id}`);
});
