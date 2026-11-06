// Plan logins between the CEO's PCs (devices/sync/logins.ts): two temporary PCs on a fake mesh. A login reaches the
// other PC's own home for that account whole (no temp file left, mode 0600) and the account is checked; the newer
// login wins by its own time, an older one never replaces it; a change the CLI writes (the home's watch) goes on its
// own; a login found in a CLI's default home travels and comes back into that home only when the file there is the
// same account; a PC that has the same login itself (provider and e-mail) takes it into its own account; never over
// a file of another account (in any home); a plan signed out here takes none until one is made here again; nothing
// goes to or comes from an employee's PC, an emptied login never travels, Claude Code on a Mac has none to send or take.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { LoginSync } from '../../../src/runtime/devices/sync/logins.ts';
import { signedOut } from '../../../src/runtime/accounts/cli-homes.ts';
import { memoryDb, recordingBus, silentLog } from './fakes.ts';

const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

const plan = (id: string, provider: Account['provider'], extra: Partial<Account> = {}): Account => ({
  id, provider, label: provider, auth: 'cli', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 0, ...extra,
});

const codexLogin = (refresh: string, at: string, accountId = 'org-1') =>
  JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'id', access_token: `access-${refresh}`, refresh_token: refresh, account_id: accountId }, last_refresh: at });

type Pc = Awaited<ReturnType<typeof makePc>>;

async function makePc(pcs: Map<string, { logins: LoginSync }>, id: string, platform: NodeJS.Platform = 'win32') {
  const root = await mkdtemp(path.join(os.tmpdir(), `logins-${id}-`));
  const db = memoryDb();
  const { bus } = recordingBus();
  const repo = new DevicesRepo(db);
  repo.upsert(record(id, { self: true }));
  const accounts: Account[] = [];
  const checked: string[] = [];
  const calls: string[] = [];
  const watchers = new Map<string, (event: string, name: string | null) => void>();
  const s = {
    db, bus, log: silentLog, paths: { accounts: path.join(root, 'data', 'accounts') },
    accounts: {
      list: () => accounts, get: (accountId: string) => accounts.find((account) => account.id === accountId),
      checkNow: async (accountId: string) => { checked.push(accountId); },
    },
    devices: {
      online: (peer: string) => pcs.has(peer),
      call: async (peer: string, method: string, params: unknown) => {
        const target = pcs.get(peer);
        if (!target) throw new WorkforceError('unavailable', 'offline');
        calls.push(`${id}->${peer}`);
        return target.logins.receive(JSON.parse(JSON.stringify(params)), id);
      },
    },
  } as unknown as RuntimeServices;
  const home = path.join(root, 'user');
  const logins = new LoginSync(s, {
    platform, env: {}, homeDir: home,
    watch: (dir, listener) => { watchers.set(dir, listener); return Object.assign(new EventEmitter(), { close: () => watchers.delete(dir) }) as unknown as FSWatcher; },
  });
  /** An account's own home here. */
  const own = (account: string, provider = 'codex') => path.join(root, 'data', 'accounts', provider, account);
  const pc = { id, root, home, repo, accounts, checked, calls, watchers, logins, own, s };
  pcs.set(id, pc);
  return pc;
}

const put = async (file: string, text: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
const read = (file: string) => readFile(file, 'utf8').catch(() => undefined);
const temps = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.tmp'));
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

/** `b` joined `a` as one of the CEO's PCs. */
function link(a: Pc, b: Pc): void {
  a.repo.upsert(record(b.id));
  b.repo.upsert(record(a.id, { joinedAs: 'ceo' }));
}

test('a plan\'s login reaches the other PC\'s own home whole and the account is checked; the newer login wins, a refresh there comes back', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true }); });
  link(a, b);
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com' }));
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com', state: 'needs_login' })); // its row came with the rows
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));

  assert.equal(await a.logins.catchUp('dev_b'), true);
  const there = path.join(b.own('acc_cx'), 'auth.json');
  assert.equal(await read(there), codexLogin('r1', '2026-11-04T10:00:00Z'), 'the same login, byte for byte');
  assert.deepEqual(await temps(b.own('acc_cx')), [], 'written whole: no temp file stays');
  if (process.platform !== 'win32') assert.equal((await stat(there)).mode & 0o777, 0o600);
  assert.deepEqual(b.checked, ['acc_cx'], 'the account there is checked (it was not signed in)');

  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r0', '2026-11-04T09:00:00Z'));
  await a.logins.catchUp('dev_b');
  assert.equal(await read(there), codexLogin('r1', '2026-11-04T10:00:00Z'), 'an older login never replaces the newer one');

  const offs = [a.logins.attach(), b.logins.attach()];
  assert.ok(b.watchers.has(b.own('acc_cx')), 'B watches the account\'s home');
  await put(there, codexLogin('r2', '2026-11-04T11:00:00Z')); // Codex refreshed on B
  b.watchers.get(b.own('acc_cx'))!('rename', 'auth.json');
  b.watchers.get(b.own('acc_cx'))!('change', 'history.jsonl'); // not a login file: nothing
  await settle();
  assert.equal(await read(path.join(a.own('acc_cx'), 'auth.json')), codexLogin('r2', '2026-11-04T11:00:00Z'), 'the refresh came back at once');
  const sent = b.calls.length;
  a.watchers.get(a.own('acc_cx'))!('rename', 'auth.json'); // A's own write of what came: no echo
  await settle();
  assert.equal(a.calls.filter((call) => call === 'dev_a->dev_b').length, 2, 'A sent only its two link-ups');
  assert.equal(b.calls.length, sent);
  for (const off of offs) off();
});

test('a login found in a CLI\'s default home travels and comes back there – never over a file of another account', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true }); });
  link(a, b);
  a.accounts.push(plan('acc_found', 'codex', { detected: true, email: 'lena@example.com' })); // in ~/.codex
  b.accounts.push(plan('acc_found', 'codex', { home: b.own('acc_found'), email: 'lena@example.com', state: 'unknown' }));
  const defaultHome = path.join(a.home, '.codex', 'auth.json');
  await put(defaultHome, codexLogin('r1', '2026-11-04T10:00:00Z'));

  await a.logins.catchUp('dev_b');
  assert.equal(await read(path.join(b.own('acc_found'), 'auth.json')), codexLogin('r1', '2026-11-04T10:00:00Z'), 'B keeps it in its own home for the account');

  await put(path.join(b.own('acc_found'), 'auth.json'), codexLogin('r2', '2026-11-04T11:00:00Z'));
  await b.logins.catchUp('dev_a');
  assert.equal(await read(defaultHome), codexLogin('r2', '2026-11-04T11:00:00Z'), 'the newer login went into ~/.codex: the same account');
  assert.deepEqual(a.checked, [], 'A\'s account was signed in already: no extra check');

  await put(defaultHome, codexLogin('x1', '2026-11-04T08:00:00Z', 'org-2')); // someone signed in another account in ~/.codex
  await put(path.join(b.own('acc_found'), 'auth.json'), codexLogin('r3', '2026-11-04T12:00:00Z'));
  await b.logins.catchUp('dev_a');
  assert.equal(await read(defaultHome), codexLogin('x1', '2026-11-04T08:00:00Z', 'org-2'), 'never over a file whose account differs');
});

test('a PC with the same login itself takes it into its own account (provider and e-mail); Gemini CLI keeps one per PC', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true }); });
  link(a, b);
  a.accounts.push(plan('acc_a', 'codex', { home: a.own('acc_a'), email: 'lena@example.com' }), plan('acc_ga', 'gemini-cli', { detected: true }));
  b.accounts.push(plan('acc_b', 'codex', { detected: true, email: 'lena@example.com', state: 'needs_login' }), plan('acc_gb', 'gemini-cli', { detected: true }));
  await put(path.join(a.own('acc_a'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));
  const geminiCreds = JSON.stringify({ access_token: 'g', refresh_token: 'gr', expiry_date: 1_793_800_000_000 });
  await put(path.join(a.home, '.gemini', 'oauth_creds.json'), geminiCreds);
  await put(path.join(a.home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'lena@example.com', old: [] }));

  await a.logins.catchUp('dev_b');
  assert.equal(await read(path.join(b.home, '.codex', 'auth.json')), codexLogin('r1', '2026-11-04T10:00:00Z'), 'into B\'s own Codex login');
  assert.deepEqual(b.checked, ['acc_b']);
  assert.equal(await read(path.join(b.home, '.gemini', 'oauth_creds.json')), geminiCreds);
  assert.equal(await read(path.join(b.home, '.gemini', 'google_accounts.json')), JSON.stringify({ active: 'lena@example.com', old: [] }), 'both of its files');
});

test('never to or from an employee\'s PC, never an emptied login, and Claude Code on a Mac has none to send or take', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  const mac = await makePc(pcs, 'dev_mac', 'darwin');
  t.after(async () => { for (const pc of [a, b, mac]) await rm(pc.root, { recursive: true, force: true }); });
  a.repo.upsert(record('dev_b', { personId: 'per_lena000001' }));
  b.repo.upsert(record('dev_a', { joinedAs: 'employee' }));
  link(a, mac);
  a.accounts.push(plan('acc_cl', 'claude', { home: a.own('acc_cl', 'claude') }));
  b.accounts.push(plan('acc_cl', 'claude', { home: b.own('acc_cl', 'claude'), state: 'needs_login' }));
  mac.accounts.push(plan('acc_cl', 'claude', { home: mac.own('acc_cl', 'claude'), state: 'needs_login' }));
  const claude = JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1_793_800_000_000, scopes: [], subscriptionType: 'max' } });
  await put(path.join(a.own('acc_cl', 'claude'), '.credentials.json'), claude);

  assert.equal(await a.logins.catchUp('dev_b'), true);
  assert.deepEqual(a.calls.filter((call) => call === 'dev_a->dev_b'), [], 'nothing goes to an employee\'s PC');
  await assert.rejects(b.logins.receive({ logins: [] }, 'dev_a'), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
  await assert.rejects(a.logins.receive({ logins: [] }, 'dev_b'), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden', 'nor from one');

  await a.logins.catchUp('dev_mac');
  assert.equal(await read(path.join(mac.own('acc_cl', 'claude'), '.credentials.json')), undefined, 'a Mac keeps it in the Keychain: nothing written');
  assert.deepEqual(mac.checked, []);
  await put(path.join(mac.own('acc_cl', 'claude'), '.credentials.json'), claude);
  const before = mac.calls.length;
  assert.equal(await mac.logins.catchUp('dev_a'), true);
  assert.equal(mac.calls.length, before, 'nor read there');

  const emptied = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 1_793_900_000_000 } });
  await put(path.join(a.own('acc_cl', 'claude'), '.credentials.json'), emptied);
  const sent = a.calls.length;
  await a.logins.catchUp('dev_mac');
  assert.equal(a.calls.length, sent, 'an emptied login never travels');
});

test('never over a login of another account – also in the plan\'s own home here (signed in with another account, or the same e-mail)', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true }); });
  link(a, b);
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com' }), plan('acc_work', 'codex', { home: a.own('acc_work'), email: 'team@example.com' }));
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com' }), plan('acc_team', 'codex', { home: b.own('acc_team'), email: 'team@example.com' }));
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));
  await put(path.join(a.own('acc_work'), 'auth.json'), codexLogin('w1', '2026-11-04T10:00:00Z', 'org-3'));
  await put(path.join(b.own('acc_cx'), 'auth.json'), codexLogin('y1', '2026-11-04T09:00:00Z', 'org-2')); // B signed this plan in with another account
  await put(path.join(b.own('acc_team'), 'auth.json'), codexLogin('t1', '2026-11-04T09:00:00Z', 'org-4')); // the same e-mail, another workspace

  await a.logins.catchUp('dev_b');
  assert.equal(await read(path.join(b.own('acc_cx'), 'auth.json')), codexLogin('y1', '2026-11-04T09:00:00Z', 'org-2'), 'the newer login of another account stays out');
  assert.equal(await read(path.join(b.own('acc_team'), 'auth.json')), codexLogin('t1', '2026-11-04T09:00:00Z', 'org-4'), 'also in the plan with the same e-mail');
  assert.deepEqual(b.checked, []);
});

test('a plan signed out here takes no login from a linked PC until one is made here again', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true }); });
  link(a, b);
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com', state: 'needs_login' }));
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com' }));
  const mine = path.join(a.own('acc_cx'), 'auth.json');
  const theirs = path.join(b.own('acc_cx'), 'auth.json');
  await put(theirs, codexLogin('r2', '2026-11-04T11:00:00Z'));
  signedOut.mark(a.s.db, 'acc_cx', 1); // the person signed out on A (accounts.logout: the CLI removed the file)

  await b.logins.catchUp('dev_a');
  assert.equal(await read(mine), undefined, 'A stays signed out');
  assert.deepEqual(a.checked, []);

  await put(mine, codexLogin('r3', '2026-11-04T12:00:00Z')); // the person signed in on A again
  await a.logins.catchUp('dev_b');
  assert.equal(signedOut.has(a.s.db, 'acc_cx'), false, 'a login here ends the mark');
  assert.equal(await read(theirs), codexLogin('r3', '2026-11-04T12:00:00Z'), 'and goes to B');
  await put(theirs, codexLogin('r4', '2026-11-04T13:00:00Z'));
  await b.logins.catchUp('dev_a');
  assert.equal(await read(mine), codexLogin('r4', '2026-11-04T13:00:00Z'), 'B\'s refresh reaches A again');
});
