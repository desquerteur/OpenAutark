// browser.console, browser.network, browser.eval, browser.wait and the human check: ring buffers filled by page
// events from the moment a tab exists (credentials cut from addresses, only harmless headers, bodies capped), eval
// with a capped result, waits that end on the
// page's own signal (a MutationObserver stand-in, no polling), and a captcha page reported in one line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTools } from '../../../src/runtime/browser/tools.ts';
import { BODY_MAX, CONSOLE_MAX, PageLog, safeHeaders, safeUrl } from '../../../src/runtime/browser/devtools.ts';
import { HUMAN_CHECK_NOTE, isHumanCheck } from '../../../src/runtime/browser/human-check.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import { cleanupB055, scriptBrowser, ScriptPage, textOf, toolCtx } from './b055-fakes.ts';

after(cleanupB055);

const tool = (tools: ToolDef[], name: string) => tools.find((entry) => entry.name === name)!;

async function opened(url = 'https://app.test/') {
  const rig = scriptBrowser();
  const tools = browserTools(rig.browser);
  const t = toolCtx();
  await tool(tools, 'browser.open').run({ url }, t.ctx);
  return { ...rig, tools, page: rig.page(), ...t };
}

function request(url: string, method = 'GET', type = 'fetch') {
  return { url: () => url, method: () => method, resourceType: () => type, failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }) };
}

test('console: messages and uncaught errors since the tab opened, filtered, newest last', async () => {
  const { tools, page, ctx, browser } = await opened();
  page.emit('console', { type: () => 'log', text: () => 'booted', location: () => ({ url: 'https://app.test/main.js?token=abc', lineNumber: 3 }) });
  page.emit('console', { type: () => 'error', text: () => 'Failed to load chart' });
  page.emit('pageerror', new TypeError('x is undefined'));
  page.emit('download', { suggestedFilename: () => 'a.txt' }); // other events never break the log
  const all = textOf(await tool(tools, 'browser.console').run({}, ctx));
  assert.match(all, /\[log\] booted \(https:\/\/app\.test\/main\.js\?token=%E2%80%A6:3\)\n\[error\] Failed to load chart\n\[error\] Uncaught TypeError: x is undefined/);
  const errors = textOf(await tool(tools, 'browser.console').run({ errorsOnly: true, pattern: 'chart' }, ctx));
  assert.ok(errors.includes('Failed to load chart') && !errors.includes('booted') && !errors.includes('x is undefined'));
  const log = new PageLog();
  const fake = new ScriptPage();
  log.attach(fake);
  for (let i = 0; i < CONSOLE_MAX + 5; i++) fake.emit('console', { type: () => 'log', text: () => `m${i}` });
  assert.equal(log.console.length, CONSOLE_MAX, 'a ring buffer');
  assert.equal(log.console[0]!.text, 'm5');
  await browser.close();
});

test('network: requests with status and time; credentials cut; details show safe headers only and a capped body', async () => {
  const { tools, page, ctx, browser } = await opened();
  const api = request('https://api.test/v1/items?page=2&access_token=SECRET1&sig=abc');
  page.emit('request', api);
  page.emit('response', {
    request: () => api, status: () => 200,
    headers: () => ({ 'content-type': 'application/json', 'set-cookie': 'sid=SECRET2', authorization: 'Bearer SECRET3', 'x-api-key': 'SECRET4' }),
    text: async () => `{"items":[${'1,'.repeat(BODY_MAX)}1]}`,
  });
  const broken = request('https://cdn.test/app.js', 'GET', 'script');
  page.emit('request', broken);
  page.emit('requestfailed', broken);
  const list = textOf(await tool(tools, 'browser.network').run({}, ctx));
  assert.match(list, /r1 GET 200 https:\/\/api\.test\/v1\/items\?page=2&access_token=%E2%80%A6&sig=%E2%80%A6 \(fetch, \d+ ms\)/);
  assert.match(list, /r2 GET failed: net::ERR_CONNECTION_REFUSED https:\/\/cdn\.test\/app\.js \(script/);
  assert.ok(!list.includes('SECRET1'));
  assert.ok(!textOf(await tool(tools, 'browser.network').run({ failedOnly: true }, ctx)).includes('r1 '), 'failedOnly');
  const details = textOf(await tool(tools, 'browser.network').run({ requestId: 'r1' }, ctx));
  assert.match(details, /content-type: application\/json\n\(other headers are not shown\)\n---\n\{"items"/);
  for (const secret of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET4', 'set-cookie', 'authorization', 'x-api-key']) assert.ok(!details.includes(secret), secret);
  assert.match(details, /… \(body cut\)/);
  await assert.rejects(tool(tools, 'browser.network').run({ requestId: 'r99' }, ctx), /No request r99/);
  assert.deepEqual(safeHeaders({ Cookie: 'a', 'Content-Length': '12', Location: 'https://x.test/?code=123' }), { 'content-length': '12', location: 'https://x.test/?code=%E2%80%A6' });
  assert.equal(safeUrl('https://user:pw@x.test/a#frag'), 'https://x.test/a');
  await browser.close();
});

test('eval: debugging result capped', async () => {
  const { tools, page, ctx, browser } = await opened();
  page.onEvaluate = async () => ({ count: 3 });
  assert.match(textOf(await tool(tools, 'browser.eval').run({ expression: 'document.querySelectorAll("li").length' }, ctx)), /---\n\{"count":3\}/);
  page.onEvaluate = async () => { throw new Error('ReferenceError: foo is not defined\n    at eval'); };
  assert.match(textOf(await tool(tools, 'browser.eval').run({ expression: 'foo' }, ctx)), /Error: ReferenceError: foo is not defined$/);
  assert.equal(tool(tools, 'browser.eval').category, 'device', 'a script can act: judged like a device step');
  await browser.close();
});

test('wait: ends on the page\'s own signal (text, change, idle, url) and answers with the change list', async () => {
  const { tools, page, ctx, browser } = await opened();
  page.snapshot = '- button "Load" [ref=e1]';
  await tool(tools, 'browser.snapshot').run({}, ctx);
  page.onEvaluate = async (expression) => {
    assert.match(expression, /MutationObserver/);
    assert.match(expression, /"text":"Done"/);
    page.snapshot = '- button "Load" [ref=e1]\n- text: Done';
    return true;
  };
  const text = textOf(await tool(tools, 'browser.wait').run({ text: 'Done', timeoutMs: 2000 }, ctx));
  assert.match(text, /^Waited [\d.]+ s: it came · page changed\./);
  assert.match(text, /\+ text: Done/);
  // A navigation while waiting for a change counts as the change (the page's context went away).
  page.onEvaluate = async () => { throw new Error('Execution context was destroyed, most likely because of a navigation'); };
  assert.match(textOf(await tool(tools, 'browser.wait').run({ change: true }, ctx)), /it came/);
  page.onLoadState = async (state) => { if (state === 'networkidle') throw new Error('Timeout 100ms exceeded'); };
  assert.match(textOf(await tool(tools, 'browser.wait').run({ idle: true, timeoutMs: 100 }, ctx)), /it did not come in time/);
  page.waitForURL = async (match) => { page.urlValue = 'https://app.test/done'; assert.equal(match(new URL(page.urlValue)), true); };
  assert.match(textOf(await tool(tools, 'browser.wait').run({ url: '/done' }, ctx)), /it came/);
  await assert.rejects(tool(tools, 'browser.wait').run({ text: 'a', change: true }, ctx), /exactly one of text, url, change or idle/);
  await browser.close();
});

test('human check: detected from what the page shows, never from a footer; reported as one line, nobody is notified', async () => {
  assert.equal(isHumanCheck({ title: 'Just a moment...', url: 'https://shop.test/', snapshot: '' }), true);
  assert.equal(isHumanCheck({ title: 'Login', url: 'https://shop.test/', snapshot: '- iframe "reCAPTCHA" [ref=e4]:\n  - checkbox "I\'m not a robot" [ref=f1e2]' }), true);
  assert.equal(isHumanCheck({ title: 'Login', url: 'https://shop.test/', snapshot: '- iframe "Widget containing a Cloudflare security challenge" [ref=e3]' }), true);
  assert.equal(isHumanCheck({ title: 'x', url: 'https://shop.test/', snapshot: '- heading "Verify you are human" [level=1] [ref=e1]' }), true);
  assert.equal(isHumanCheck({ title: 'Login', url: 'https://shop.test/', snapshot: '- paragraph: This site is protected by reCAPTCHA and the Google Privacy Policy.' }), false);
  assert.equal(isHumanCheck({ title: 'Captchas explained', url: 'https://blog.test/', snapshot: '- heading "How captchas work" [ref=e1]' }), false);
  const { tools, page, ctx, notified, browser } = await opened('https://shop.test/login');
  page.snapshot = '- iframe "reCAPTCHA" [ref=e4]:\n  - checkbox "I\'m not a robot" [ref=f1e2]';
  const text = textOf(await tool(tools, 'browser.snapshot').run({}, ctx));
  assert.ok(text.endsWith(HUMAN_CHECK_NOTE), text);
  assert.deepEqual(notified, []);
  await browser.close();
});
