// Secret handles in commands and requests (B-044, secrets/handles.ts, tools/builtin/{command,files,secret-run,web}.ts):
// shell.exec and secrets.run take secret://<id> in env values – resolved at spawn (the child gets the value, the agent's
// arguments and the action never do); owner 29.10.2026 (a catalog with zero restrictions, card
// data included): every secret works in a command and in a header to any host – a password, a login's field, a card,
// a 2FA key (its current code); what comes back has each value the call received masked by its handle (4+ characters,
// raw and encoded); only a value under 4 characters and a secret out of scope are refused; web.fetch sends a handle
// only to the request's host and follows no redirect then. secrets.run comes only
// through the MCP hub, with shell.exec. Owns: these assertions only. Never: a real shell,
// keychain or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { maskValues } from '../../../src/runtime/secrets/handles.ts';
import { fileTools, type ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';
import { secretRunTool } from '../../../src/runtime/tools/builtin/secret-run.ts';
import { webTools, type FetchFn } from '../../../src/runtime/tools/builtin/web.ts';
import { handlesIn } from '../../../src/runtime/secrets/handles.ts';
import { EVERY_MODE } from '../../../src/runtime/tools/registry.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { tempDir } from '../store/helpers.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};
const TOKEN = 'ghp_handles_test_token_00001111';

function setup(t: { after(fn: () => void): void }) {
  const temp = tempDir('wf-secret-handles-');
  t.after(temp.cleanup);
  const db = new Db(':memory:');
  migrate(db);
  const vault = new SecretVault({ db, host, clock: new ManualClock() });
  const spawned: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
  // "print NAME …" writes those env values to stdout (and base64 of the first) – what a command could leak.
  const shell: ShellSpawn = (command, options) => {
    spawned.push({ command, env: options.env });
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout, stderr: null, kill: () => true });
    setImmediate(() => {
      const names = command.startsWith('print ') ? command.slice(6).split(' ') : [];
      if (names.length) {
        const values = names.map((name) => String(options.env?.[name] ?? ''));
        stdout.emit('data', Buffer.from(`${values.join(' | ')}\nb64=${Buffer.from(values[0]).toString('base64')}\n`));
      }
      child.emit('close', 0);
    });
    return child as unknown as ReturnType<ShellSpawn>;
  };
  const fetched: Array<{ url: string; headers: Record<string, string>; redirect: string }> = [];
  let answer = () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  const fetch: FetchFn = async (url, init) => { fetched.push({ url, headers: init.headers, redirect: init.redirect }); return answer(); };
  const services = {
    db, secrets: vault, paths: { data: path.join(temp.dir, 'data'), workspace: path.join(temp.dir, 'work') },
    devices: { self: () => ({ id: 'dev_self', name: 'Desk' }), list: () => [] },
  } as unknown as RuntimeServices;
  const ctx = (agentId = 'ag_mira'): ToolContext => ({
    agent: { id: agentId, name: 'Mira' } as ToolContext['agent'], runId: 'run_1', mode: 'coding', services, signal: new AbortController().signal, status() {},
  });
  const exec = fileTools({ shell }).find((tool) => tool.name === 'shell.exec')!;
  const run = secretRunTool({ shell });
  const [web] = webTools({ fetch });
  return { vault, spawned, fetched, ctx, exec, run, web, answer: (next: () => Response) => { answer = next; } };
}

const text = (out: ToolOutput) => out.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

test('handles are found inside values, each once', () => {
  assert.deepEqual(handlesIn(['Bearer secret://sec_a', 'x secret://sec_b and secret://sec_a', 'plain']), ['sec_a', 'sec_b']);
});

test('shell.exec env: the child gets the value at spawn; a card works; an unknown handle is refused', async (t) => {
  const f = setup(t);
  const token = await f.vault.save({ label: 'GitHub token', kind: 'token', value: TOKEN });
  const args = { command: 'gh release list', env: { GH_TOKEN: `secret://${token.id}`, PAGER: 'cat' } };
  const action = f.exec.describe!(args, f.ctx());
  assert.equal(action.external, false);
  assert.match(action.summary, /^Run: gh release list \(with the stored secret "GitHub token" in its environment – the command can read it and could write it elsewhere; only what it prints is masked\)$/);
  assert.ok(!JSON.stringify(action).includes(TOKEN));
  const out = await f.exec.run(args, f.ctx());
  assert.equal(out.isError, false, text(out));
  assert.equal(f.spawned[0].env?.GH_TOKEN, TOKEN, 'resolved only for the child');
  assert.equal(f.spawned[0].env?.PAGER, 'cat');
  assert.equal(args.env.GH_TOKEN, `secret://${token.id}`, 'the arguments keep the handle');
  assert.equal(f.vault.redact(`echo ${TOKEN}`), `echo secret://${token.id}`, 'output that shows it is redacted from now on');
  const card = await f.vault.save({ label: 'Visa', kind: 'card', value: '4111111111111111', source: 'shop.example' });
  const paid = await f.exec.run({ command: 'print CARD', env: { CARD: `secret://${card.id}` } }, f.ctx());
  assert.equal(f.spawned[1].env?.CARD, '4111111111111111');
  assert.ok(!text(paid).includes('4111111111111111') && text(paid).includes(`secret://${card.id}`), 'the card number is masked in the output');
  assert.throws(() => f.exec.describe!({ command: 'run', env: { K: 'secret://nope' } }, f.ctx()), /not in the secrets catalog/);
  await assert.rejects(f.exec.run({ command: 'run', env: { K: 'secret://nope' } }, f.ctx()), /not in the secrets catalog/);
  assert.throws(() => f.exec.describe!({ command: 'run', env: { 'BAD NAME': 'x' } }, f.ctx()), /not an environment variable name/);
  assert.equal(f.spawned.length, 2, 'nothing refused was started');
});

test('29.10.2026: a password saved from a website and a login\'s field work in a command env – no binding, never in the output', async (t) => {
  const f = setup(t);
  const site = await f.vault.save({ label: 'Shop password', kind: 'password', value: 'pw-shop-env-1', source: 'shop.example' });
  const login = await f.vault.saveGroup({ label: 'Mail login', kind: 'login', source: 'mail.example', fields: [
    { field: 'username', kind: 'text', value: 'mira@mail.example' }, { field: 'password', kind: 'password', value: 'pw-mail-env-2' },
  ] });
  const password = login.fields.find((field) => field.field === 'password')!;
  const args = { command: 'deploy', env: { SHOP_PW: `secret://${site.id}`, MAIL_PW: `secret://${password.id}` } };
  const action = f.exec.describe!(args, f.ctx());
  assert.ok(!JSON.stringify(action).includes('pw-shop-env-1') && !JSON.stringify(action).includes('pw-mail-env-2'));
  const out = await f.exec.run(args, f.ctx());
  assert.equal(out.isError, false, text(out));
  assert.deepEqual([f.spawned[0].env?.SHOP_PW, f.spawned[0].env?.MAIL_PW], ['pw-shop-env-1', 'pw-mail-env-2']);
  assert.ok(!text(out).includes('pw-shop-env-1'), 'no value in the result');
  // In a header to any host: no stop, no binding.
  const header = f.web.describe!({ url: 'https://api.other.example/', headers: { 'X-Pw': `secret://${site.id}` } }, f.ctx());
  assert.ok(!header.summary.includes('pw-shop-env-1'));
  await f.web.run({ url: 'https://api.other.example/', headers: { 'X-Pw': `secret://${site.id}` } }, f.ctx());
  assert.equal(f.fetched[0].headers['X-Pw'], 'pw-shop-env-1');
  assert.equal(f.vault.list().find((info) => info.id === site.id)!.source, 'shop.example', 'the source stays information');
});

test('secrets.run: through the MCP hub only, in every mode; it needs a handle', async (t) => {
  const f = setup(t);
  assert.equal(f.run.audience, 'mcp');
  assert.ok(EVERY_MODE.has('secrets.run'));
  const token = await f.vault.save({ label: 'npm token', kind: 'token', value: TOKEN });
  const args = { command: 'npm whoami', env: { NPM_TOKEN: `secret://${token.id}` } };
  assert.equal((await f.run.run(args, f.ctx())).isError, false);
  assert.equal(f.spawned[0].env?.NPM_TOKEN, TOKEN);
  assert.match(text(await f.run.run({ command: 'npm whoami', env: { A: 'b' } }, f.ctx())), /is for commands that need a stored secret/);
});

test('web.fetch headers: sent to the request\'s host only, no redirect followed; any host – nobody restricts a secret to sites (owner 29.10.2026)', async (t) => {
  const f = setup(t);
  const key = await f.vault.save({ label: 'API key', kind: 'api_key', value: TOKEN, source: 'api.example.com' });
  const args = { url: 'https://api.example.com/v1/me', headers: { Authorization: `Bearer secret://${key.id}` } };
  const inside = f.web.describe!(args, f.ctx());
  assert.equal(inside.external, false);
  f.answer(() => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/steal' } }));
  const out = await f.web.run(args, f.ctx());
  assert.deepEqual([f.fetched[0].headers.Authorization, f.fetched[0].redirect], [`Bearer ${TOKEN}`, 'manual']);
  assert.match(text(out), /redirect to https:\/\/elsewhere\.example\/steal not followed/);
  assert.ok(!text(out).includes(TOKEN));
  const away = { url: 'https://upload.other.example/x', headers: { 'X-Key': `secret://${key.id}` } };
  const other = f.web.describe!(away, f.ctx());
  assert.equal(other.external, false, 'another host: no stop');
  f.answer(() => new Response('done', { status: 200 }));
  assert.equal((await f.web.run(away, f.ctx())).isError, false);
  assert.equal(f.fetched[1].headers['X-Key'], TOKEN);
  f.answer(() => new Response(`{"headers":{"X-Key":"${TOKEN}","b64":"${Buffer.from(TOKEN).toString('base64')}"}}`, { status: 200 }));
  const echoed = await f.web.run(away, f.ctx());
  assert.ok(!text(echoed).includes(TOKEN) && !text(echoed).includes(Buffer.from(TOKEN).toString('base64')), 'an echoing host gets the value back masked');
  assert.match(text(echoed), new RegExp(`secret://${key.id}`));
  assert.throws(() => f.web.describe!({ url: 'https://api.example.com/', headers: { Host: 'x' } }, f.ctx()), /cannot be set as a header/);
  await f.web.run({ url: 'https://plain.example/' }, f.ctx());
  assert.equal(f.fetched.at(-1)!.redirect, 'follow', 'without a secret redirects are followed as before');
});

test('web.fetch: no part of a secret reaches the model through an error – a line break is refused, a quoted value redacted before it is cut', async (t) => {
  const f = setup(t);
  const pem = await f.vault.save({ label: 'Deploy key', kind: 'note', value: `-----BEGIN KEY-----\n${'A'.repeat(120)}\n-----END KEY-----` });
  const refused = await f.web.run({ url: 'https://api.example.com/', headers: { 'X-Key': `secret://${pem.id}` } }, f.ctx());
  assert.match(text(refused), /holds a line break/);
  assert.equal(f.fetched.length, 0, 'nothing was sent');
  const long = await f.vault.save({ label: 'Long token', kind: 'token', value: `tok_${'b'.repeat(300)}` });
  f.answer(() => { throw new TypeError(`Headers.append: "Bearer tok_${'b'.repeat(300)}" is an invalid header value.`); });
  const failed = await f.web.run({ url: 'https://api.example.com/', headers: { Authorization: `Bearer secret://${long.id}` } }, f.ctx());
  assert.match(text(failed), new RegExp(`Fetch failed: .*secret://${long.id}`));
  assert.ok(!text(failed).includes('tok_bbbb'), 'not even the start of the value');
});

test('owner 29.10.2026: a 2FA key works in a command and a header as its current code, masked in what comes back; a value under 8 characters that shows up withholds the output, under 4 it is refused', async (t) => {
  const f = setup(t);
  const seed = await f.vault.save({ label: 'Shop 2FA', kind: 'totp', value: 'JBSWY3DPEHPK3PXP' });
  const login = await f.vault.saveGroup({ label: 'Mail login', kind: 'login', fields: [
    { field: 'password', kind: 'password', value: 'pw-mail-long-enough' }, { field: 'totp', kind: 'totp', value: 'JBSWY3DPEHPK3PXP' },
  ] });
  const field = login.fields.find((entry) => entry.field === 'totp')!;
  for (const id of [seed.id, field.id]) {
    const out = await f.exec.run({ command: 'print C', env: { C: `secret://${id}` } }, f.ctx());
    const code = String(f.spawned.at(-1)!.env?.C);
    assert.match(code, /^\d{6}$/, 'the child gets the current code');
    assert.ok(!text(out).includes(code) && text(out).includes('Output withheld'), 'a printed code withholds the output');
  }
  const pin = await f.vault.save({ label: 'Door PIN', kind: 'password', value: '4711' });
  const out = await f.exec.run({ command: 'print P', env: { P: `secret://${pin.id}` } }, f.ctx());
  assert.ok(!text(out).includes('4711') && text(out).includes('Output withheld'), 'a printed 4-character value withholds the output');
  const tiny = await f.vault.save({ label: 'Lock code', kind: 'password', value: '471' });
  await assert.rejects(f.exec.run({ command: 'print P', env: { P: `secret://${tiny.id}` } }, f.ctx()), /"Lock code" is shorter than 4 characters.*only in a browser field/);
  await assert.rejects(f.web.run({ url: 'https://echo.example/', headers: { 'X-Pin': `secret://${tiny.id}` } }, f.ctx()), /shorter than 4 characters/);
  assert.equal(f.fetched.length, 0, 'nothing too short was sent');
});

test('maskValues: raw, base64, URL and hex forms, longest first; a short value only withholds when it shows', () => {
  const values = new Map([['sec_a', 'p@ss word'], ['sec_b', 'k7Qz']]);
  const raw = 'p@ss word';
  const text = `${raw} ${Buffer.from(raw).toString('base64')} ${encodeURIComponent(raw)} ${Buffer.from(raw).toString('hex')} abc`;
  assert.equal(maskValues(text, values), 'secret://sec_a secret://sec_a secret://sec_a secret://sec_a abc');
  assert.match(maskValues(`0000
k7Qz
9999`, values), /^\[Output withheld/, 'one line of a listing never points a short value out');
});

test('maskValues: a value printed in parts or inside Basic auth is masked too (review leak H2)', () => {
  const card = '4111111111111111';
  const pass = 'Summer2024!pw';
  const values = new Map([['card', card], ['pw', pass]]);
  const split = maskValues(`${card.slice(0, 8)}
${card.slice(8)}`, values);
  assert.ok(!split.includes(card.slice(0, 8)) && !split.includes(card.slice(8)), split);
  const basic = `Authorization: Basic ${Buffer.from(`mira:${pass}`).toString('base64')}`;
  assert.equal(maskValues(basic, values), 'Authorization: Basic secret://pw');
  assert.equal(maskValues('nothing to see here', values), 'nothing to see here');
});
