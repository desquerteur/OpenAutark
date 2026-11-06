// C7: how the wf terminal client finds the runtime – the per-OS Electron userData dir (injected
// env, no real files), runtime.json checks (missing, invalid, stale pid) and that the owner token
// never leaves the Endpoint except through hello().
// Owns: these assertions only. Never: reads the person's real app data or connects anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  Endpoint, PRODUCT_NAME, defaultDataDir, discover, parseRuntimeInfo, processAlive, type DiscoverEnv,
} from '../../../src/runtime/wf-cli/discover.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TOKEN = 'owner-token-0123456789abcdef0123456789abcdef';

function env(over: Partial<DiscoverEnv> & { files?: Record<string, string>; dead?: number[] } = {}): DiscoverEnv & { reads: string[] } {
  const reads: string[] = [];
  const files = over.files ?? {};
  return {
    platform: over.platform ?? 'win32',
    env: over.env ?? { APPDATA: 'C:\\Users\\Ann\\AppData\\Roaming' },
    home: over.home ?? 'C:\\Users\\Ann',
    cwd: over.cwd ?? 'C:\\work',
    readFile(file) {
      reads.push(file);
      if (over.readFile) return over.readFile(file);
      if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[file];
    },
    alive: (pid) => !(over.dead ?? []).includes(pid),
    reads,
  };
}

test('the product name is package.json productName (Electron names the userData folder after it)', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { productName: string };
  assert.equal(PRODUCT_NAME, pkg.productName);
});

test('default data dir per OS: %APPDATA%, ~/Library/Application Support, $XDG_CONFIG_HOME or ~/.config', () => {
  assert.equal(defaultDataDir({ platform: 'win32', env: { APPDATA: 'D:\\Roaming' }, home: 'C:\\Users\\Ann' }), 'D:\\Roaming\\Autark');
  assert.equal(defaultDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\Ann' }), 'C:\\Users\\Ann\\AppData\\Roaming\\Autark', 'no APPDATA: the roaming folder of home');
  assert.equal(defaultDataDir({ platform: 'darwin', env: { XDG_CONFIG_HOME: '/x' }, home: '/Users/ann' }), '/Users/ann/Library/Application Support/Autark');
  assert.equal(defaultDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/ann/cfg' }, home: '/home/ann' }), '/home/ann/cfg/Autark');
  assert.equal(defaultDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: 'relative/cfg' }, home: '/home/ann' }), '/home/ann/.config/Autark', 'a relative XDG_CONFIG_HOME is ignored');
  assert.equal(defaultDataDir({ platform: 'linux', env: {}, home: '/home/ann' }), '/home/ann/.config/Autark');
});

test('B-072: AUTARK_DATA (set by the app for what its runtime and agents start) names their own company; --data still wins', () => {
  const company = 'C:\\Users\\Ann\\AppData\\Roaming\\Autark Companies\\company-2';
  assert.equal(defaultDataDir({ platform: 'win32', env: { APPDATA: 'D:\\Roaming', AUTARK_DATA: ` ${company} ` }, home: 'C:\\Users\\Ann' }), company);
  assert.equal(defaultDataDir({ platform: 'linux', env: { AUTARK_DATA: '/home/ann/.config/Autark Companies/x' }, home: '/home/ann' }), '/home/ann/.config/Autark Companies/x');
  assert.equal(defaultDataDir({ platform: 'linux', env: { AUTARK_DATA: 'relative/x' }, home: '/home/ann' }), '/home/ann/.config/Autark', 'a relative value is ignored');
  assert.equal(defaultDataDir({ platform: 'win32', env: { APPDATA: 'D:\\Roaming', AUTARK_DATA: '' }, home: 'C:\\Users\\Ann' }), 'D:\\Roaming\\Autark');
  const info = JSON.stringify({ port: 4321, token: TOKEN, pid: 77 });
  const own = env({ env: { APPDATA: 'C:\\Users\\Ann\\AppData\\Roaming', AUTARK_DATA: company }, files: { [`${company}\\runtime.json`]: info } });
  const found = discover({}, own);
  assert.ok(found.ok);
  assert.equal(found.endpoint.dataDir, company);
  const explicit = discover({ data: 'D:\\other' }, own);
  assert.equal(explicit.ok ? explicit.endpoint.dataDir : explicit.dataDir, 'D:\\other');
});

test('without --data the default dir is read; with --data a relative path resolves against the cwd', () => {
  const info = JSON.stringify({ port: 4321, token: TOKEN, pid: 77 });
  const byDefault = env({ files: { 'C:\\Users\\Ann\\AppData\\Roaming\\Autark\\runtime.json': info } });
  const found = discover({}, byDefault);
  assert.ok(found.ok);
  assert.equal(found.endpoint.port, 4321);
  assert.equal(found.endpoint.url, 'ws://127.0.0.1:4321/ws');
  assert.equal(found.endpoint.dataDir, 'C:\\Users\\Ann\\AppData\\Roaming\\Autark');

  const linux = env({ platform: 'linux', env: {}, home: '/home/ann', cwd: '/srv/work', files: { '/srv/work/profile/runtime.json': info } });
  const explicit = discover({ data: 'profile' }, linux);
  assert.ok(explicit.ok);
  assert.equal(explicit.endpoint.dataDir, '/srv/work/profile');
  assert.deepEqual(linux.reads, ['/srv/work/profile/runtime.json']);
});

test('missing, unreadable, invalid and stale runtime files say what to do and never hand out an endpoint', () => {
  const missing = discover({ data: 'C:\\nowhere' }, env());
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.reason === 'missing');
  assert.match(!missing.ok ? missing.message : '', /C:\\nowhere\\runtime\.json does not exist/);
  assert.match(!missing.ok ? missing.message : '', /--data "C:\\nowhere"/);
  const missingDefault = discover({}, env());
  assert.match(!missingDefault.ok ? missingDefault.message : '', /Start Autark first, or pass --data/);

  const denied = discover({ data: 'C:\\p' }, env({ readFile: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); } }));
  assert.ok(!denied.ok && denied.reason === 'invalid' && /cannot be read \(EACCES\)/.test(denied.message));

  for (const text of ['not json', '[]', '{"port":0,"token":"x"}', '{"port":70000,"token":"x"}', '{"port":12.5,"token":"x"}', '{"port":80}', '{"port":80,"token":""}', `{"port":80,"token":"${'a'.repeat(513)}"}`, '{"port":80,"token":"x","pid":"12"}']) {
    const found = discover({ data: 'C:\\p' }, env({ files: { 'C:\\p\\runtime.json': text } }));
    assert.ok(!found.ok && found.reason === 'invalid', `refused: ${text.slice(0, 40)}`);
  }

  const stale = env({ files: { 'C:\\p\\runtime.json': JSON.stringify({ port: 5000, token: TOKEN, pid: 4242 }) }, dead: [4242] });
  const found = discover({ data: 'C:\\p' }, stale);
  assert.ok(!found.ok && found.reason === 'stopped', 'a dead runtime process: nothing is sent to whatever listens on its old port');
  assert.ok(!JSON.stringify(found).includes(TOKEN) && !(!found.ok && found.message.includes(TOKEN)));
});

test('a runtime file without pid (older runtimes) is accepted', () => {
  assert.deepEqual(parseRuntimeInfo(JSON.stringify({ port: 80, token: 't' })), { port: 80, token: 't', pid: undefined });
});

test('the token stays inside the Endpoint: not in JSON, inspect or string forms; hello() and redact() use it', () => {
  const endpoint = new Endpoint({ dataDir: '/d', port: 9, token: TOKEN, pid: 3 });
  assert.equal(JSON.stringify(endpoint), '{"dataDir":"/d","port":9,"pid":3}');
  assert.ok(!inspect(endpoint, { depth: 5, showHidden: true }).includes(TOKEN));
  assert.ok(!String(endpoint).includes(TOKEN));
  assert.ok(!Object.values(endpoint).some((value) => value === TOKEN));
  assert.deepEqual(endpoint.hello(), { protocol: 1, token: TOKEN, client: 'cli' });
  assert.equal(endpoint.redact(`a ${TOKEN} b ${TOKEN}`), 'a [token] b [token]');
  assert.equal(endpoint.redact('nothing here'), 'nothing here');
});

test('processAlive: this process lives, an exited child does not', () => {
  assert.equal(processAlive(process.pid), true);
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(child.pid);
  assert.equal(processAlive(child.pid), false);
});
