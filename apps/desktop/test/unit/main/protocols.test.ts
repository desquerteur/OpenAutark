import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { ProtocolHandlers, PRIVILEGED_SCHEMES, registerProtocolHandlers } from '../../../src/main/protocols/handlers.ts';
import { APP_CSP, SANDBOX_CSP, routeAppUrl, routeSandboxUrl } from '../../../src/main/protocols/rules.ts';

const root = mkdtempSync(path.join(os.tmpdir(), 'wf-protocols-'));
after(() => rmSync(root, { recursive: true, force: true }));

const ui = path.join(root, 'app', 'ui');
const blobs = path.join(root, 'data', 'blobs');
mkdirSync(path.join(ui, 'sandbox'), { recursive: true });
mkdirSync(path.join(root, 'data'), { recursive: true });
writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>Workforce</title>');
writeFileSync(path.join(ui, 'main.js'), 'console.log(1)');
writeFileSync(path.join(ui, 'sandbox', 'wf.js'), 'window.wf = {}');
writeFileSync(path.join(root, 'data', 'secret.txt'), 'top secret');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 92 }, (_, i) => i)]);
const BLOB_ID = 'ab'.padEnd(64, 'c');
mkdirSync(path.join(blobs, 'ab', 'cc'), { recursive: true });
writeFileSync(path.join(blobs, 'ab', 'cc', BLOB_ID), PNG);

const htmlCalls: Array<[string, number]> = [];
const handlers = new ProtocolHandlers({
  uiDir: ui,
  sandboxLibDir: path.join(ui, 'sandbox'),
  blobsDir: blobs,
  pageHtml: async () => '',
  appHtml: async (messageId, blockIndex) => {
    htmlCalls.push([messageId, blockIndex]);
    if (blockIndex === 9) throw new WorkforceError('not_found', 'Mini-app not found.');
    if (blockIndex === 8) throw new WorkforceError('unavailable', 'The runtime is not running.');
    return '<button id="go">Go</button><script>wf.ready()</script>';
  },
});

const get = (url: string, init: RequestInit = {}) => new Request(url, init);

test('app:// serves the UI with the app CSP and maps / to index.html', async () => {
  const response = await handlers.app(get('app://app/'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('content-security-policy'), APP_CSP);
  assert.match(await response.text(), /Workforce/);
  const script = await handlers.app(get('app://app/main.js'));
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(script.headers.get('content-security-policy'), null);
});

test('app:// serves only the shipped UI: traversal, other hosts and the old overlay path are refused', async () => {
  assert.equal((await handlers.app(get('app://app/%2e%2e/data/secret.txt'))).status, 404);
  assert.equal((await handlers.app(get('app://app/..%5cdata%5csecret.txt'))).status, 404);
  assert.equal((await handlers.app(get('app://app/custom/theme.css'))).status, 404, 'theme.css reaches the window through theme.get, not a URL');
  assert.equal((await handlers.app(get('app://other/index.html'))).status, 404);
  assert.equal((await handlers.app(get('app://app/missing.js'))).status, 404);
  assert.equal((await handlers.app(get('app://app/index.html', { method: 'POST', body: 'x' }))).status, 405);
  const head = await handlers.app(get('app://app/index.html', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.deepEqual(routeAppUrl('app://app/main.js'), { kind: 'ui', pathname: '/main.js' });
});

test('wf-sandbox:// wraps ```app HTML with the sandbox CSP and the helper script', async () => {
  const response = await handlers.sandbox(get('wf-sandbox://app/msg_01jab3k9z7mx2c4q/2'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), `${SANDBOX_CSP}; sandbox allow-scripts allow-forms`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.match(body, /<script src="wf-sandbox:\/\/lib\/wf\.js"><\/script>/);
  assert.match(body, /<button id="go">Go<\/button>/);
  assert.deepEqual(htmlCalls.at(-1), ['msg_01jab3k9z7mx2c4q', 2]);
  assert.equal((await handlers.sandbox(get('wf-sandbox://app/msg_01jab3k9z7mx2c4q/9'))).status, 404);
  assert.equal((await handlers.sandbox(get('wf-sandbox://app/msg_01jab3k9z7mx2c4q/8'))).status, 503);
  assert.equal((await handlers.sandbox(get('wf-sandbox://app/not-an-id/1'))).status, 404);
  const lib = await handlers.sandbox(get('wf-sandbox://lib/wf.js'));
  assert.equal(lib.status, 200);
  assert.equal(await lib.text(), 'window.wf = {}');
  assert.equal((await handlers.sandbox(get('wf-sandbox://lib/other.js'))).status, 404);
});

test('wf-sandbox:// knows only lib, app and page hosts', () => {
  assert.deepEqual(routeSandboxUrl('wf-sandbox://lib/wf.js'), { kind: 'lib', file: 'wf.js' });
  assert.equal(routeSandboxUrl('wf-sandbox://plugin-clock/clock/'), null, 'overlay plugins are gone');
  assert.equal(routeSandboxUrl('wf-sandbox://other/x'), null);
});

test('wf-file:// streams blobs with sniffed MIME and single-range support', async () => {
  const whole = await handlers.file(get(`wf-file://${BLOB_ID}`));
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'image/png');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('content-length'), String(PNG.length));
  assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), PNG);

  const part = await handlers.file(get(`wf-file://${BLOB_ID}`, { headers: { Range: 'bytes=8-15' } }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 8-15/${PNG.length}`);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), PNG.subarray(8, 16));

  const tail = await handlers.file(get(`wf-file://${BLOB_ID}`, { headers: { Range: 'bytes=-4' } }));
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), PNG.subarray(PNG.length - 4));

  const invalid = await handlers.file(get(`wf-file://${BLOB_ID}`, { headers: { Range: 'bytes=500-' } }));
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${PNG.length}`);
  assert.equal((await handlers.file(get('wf-file://not-a-hash'))).status, 400);
  assert.equal((await handlers.file(get(`wf-file://${'d'.repeat(64)}`))).status, 404);
});

test('scheme registration covers all three protocols', () => {
  assert.deepEqual(PRIVILEGED_SCHEMES.map(entry => entry.scheme), ['app', 'wf-sandbox', 'wf-file']);
  assert.ok(PRIVILEGED_SCHEMES.every(entry => entry.privileges.standard && entry.privileges.secure));
  const registered: string[] = [];
  registerProtocolHandlers({ handle: scheme => { registered.push(scheme); } }, handlers);
  assert.deepEqual(registered, ['app', 'wf-sandbox', 'wf-file']);
});
