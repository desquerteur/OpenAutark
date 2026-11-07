// Settings › Connectors (AF-005) in a real browser – an installed Chrome or Edge through playwright-core (as pwa-browser.test.mjs;
// it never downloads one and skips without one) – on the headless runtime with the demo engine, opened with the owner token
// (#token=, as the desktop window is the owner), in a temp profile, with a local
// MCP server on 127.0.0.1 (test/fixtures/apps/fake-http-server.ts, in this process; no network, no real token – stdio is
// runtime-connectors.test.mjs's, whose servers start below normal priority and need a calm PC):
//   * the nav names the page Connectors and carries data-tour="connectors"; #/settings/connectors opens it;
//   * GitHub's Connect opens the token dialog (Personal access token, Create one) – nothing is sent anywhere;
//   * "Own MCP server" (web address and a token the server checks) and "Paste JSON" (an invalid paste names its problem and
//     keeps Add off; a valid one lists what goes in) both land in mcp.json with handles only and turn Connected;
//   * a row's ⋯ lists its tools, Agents… limits it ("agents": [] in the file, "no agent" in its line) and back,
//     its switch writes "disabled" and back, Remove takes it out;
//   * screenshots light and dark (SCREENSHOTS=<dir> keeps them); no page errors.
// Run: npm run build && node --test test/e2e/connectors-ui.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { detectChannel } from '../../src/runtime/browser/channel.ts';
import { startRuntime } from './lib/runtime-client.mjs';
import { startFakeHttp } from '../fixtures/apps/fake-http-server.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function installedChannel() { try { return detectChannel(); } catch { return undefined; } }
const channel = process.env.WORKFORCE_PWA_CHANNEL || installedChannel();
const TYPED = 'typed-value-never-in-a-file';

test('settings › connectors: catalog, own server, pasted JSON, tools, agents, switch and remove', {
  timeout: 300_000,
  skip: channel ? false : 'No installed Google Chrome or Microsoft Edge was found – this test uses an installed browser and never downloads one.',
}, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-connectors-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const guarded = await startFakeHttp({ token: TYPED }); // answers 401 unless Authorization: Bearer <TYPED>
  const open = await startFakeHttp();
  const runtime = await startRuntime({ dataDir: path.join(profile, 'data'), keepData: true });
  let browser;
  t.after(async () => {
    await browser?.close().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await guarded.close(); await open.close();
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  await runtime.client.call('settings.update', { onboarding: { step: 'done' } });
  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${runtime.port}/#token=${encodeURIComponent(runtime.token)}`); // the owner, as the desktop window
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const dialog = page.locator('dialog[open]').last();
  const answer = (label) => page.locator('dialog[open]').last().locator('button.button').filter({ hasText: new RegExp(`^${label}$`) }).click();
  const row = (scope, label) => page.locator(`${scope} .set-row`, { has: page.locator('.set-row-label', { hasText: new RegExp(`^${label}$`) }) });
  const appRow = (name) => page.locator('.apps-row', { has: page.locator('.set-row-label', { hasText: new RegExp(`^${name}$`) }) });
  const hint = async (name) => (await appRow(name).locator('.set-row-hint').textContent()) ?? '';
  const until = async (check, what, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(150)) if (await check()) return;
    assert.fail(`timed out: ${typeof what === 'function' ? await what() : what}`);
  };
  const mcpFile = path.join(runtime.dataDir, 'connectors', 'mcp.json');
  const mcpText = () => readFile(mcpFile, 'utf8');
  const mcp = async () => JSON.parse(await mcpText()).mcpServers;
  const more = async (name, item) => { await appRow(name).getByRole('button', { name: `More for ${name}` }).click(); await page.getByRole('menuitem', { name: item, exact: true }).click(); };

  // The page: Connectors in the nav, with its tour name; the older-name link opens it.
  await page.evaluate(() => { location.hash = '#/settings/connectors'; });
  await page.locator('.settings-content[data-section="apps"]').waitFor({ timeout: 15_000 });
  const navItem = page.locator('.settings-nav-item[data-tour="connectors"]');
  assert.equal((await navItem.textContent())?.trim(), 'Connectors');
  await page.locator('.settings-top h2', { hasText: 'Connectors' }).waitFor({ timeout: 10_000 });
  await row('.apps-list', 'GitHub').waitFor({ timeout: 15_000 }); // the catalog shows once apps.list answered
  for (const name of ['GitHub', 'Google', 'Notion', 'Slack', 'Discord']) assert.equal(await row('.apps-list', name).count(), 1, `${name} in the catalog`);
  await shot('connectors-01-page');

  // GitHub by click: the token dialog, and nothing beyond it (no token, no request to GitHub).
  await row('.apps-list', 'GitHub').getByRole('button', { name: 'Connect', exact: true }).click();
  await dialog.locator('h2, .dialog-title', { hasText: 'Connect GitHub' }).first().waitFor({ timeout: 5_000 });
  assert.equal(await dialog.locator('label', { hasText: 'Personal access token' }).count(), 1);
  assert.equal(await dialog.locator('button.button', { hasText: 'Create one' }).count(), 1);
  assert.equal(await dialog.locator('button.button', { hasText: /^Connect$/ }).isDisabled(), true, 'Connect waits for the token');
  await shot('connectors-02-github-token');
  await answer('Cancel');
  // Google asks for the two keys of the person's own OAuth client.
  await row('.apps-list', 'Google').getByRole('button', { name: 'Connect', exact: true }).click();
  assert.equal(await dialog.locator('input[type="password"]').count(), 2);
  await shot('connectors-03-google-keys');
  await answer('Cancel');

  // Own MCP server: a web address with a token and a header.
  await row('#apps-add', 'Own MCP server').getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.locator('#apps-address').fill(guarded.url);
  await dialog.locator('#apps-name').fill('Form server');
  await dialog.locator('#apps-server-token').fill(TYPED);
  await dialog.getByLabel('Name 1', { exact: true }).fill('X-Team');
  await dialog.getByLabel('Value 1', { exact: true }).fill('core');
  await shot('connectors-04-own-server');
  await answer('Connect');
  await appRow('Form server').waitFor({ timeout: 20_000 });
  await until(async () => (await hint('Form server')).includes('Connected · '), async () => `the form server connects – its line: ${await hint('Form server')}
${runtime.stderr().slice(-2000)}`, 90_000);
  const formEntry = (await mcp())['Form server'];
  assert.equal(formEntry.url, guarded.url);
  assert.match(formEntry.headers.Authorization, /^Bearer secret:\/\//, 'the file holds the handle – the server let it in, so it got the value');
  assert.match(formEntry.headers['X-Team'], /^secret:\/\//);

  // Paste JSON: an invalid paste names its problem and keeps Add off; a valid one goes in.
  await row('#apps-add', 'Paste JSON').getByRole('button', { name: 'Paste', exact: true }).click();
  await dialog.locator('#apps-import').fill('{"mcpServers": {"a": {"command": "npx",}}}');
  await dialog.locator('.apps-import-check.error', { hasText: 'Not valid JSON' }).waitFor({ timeout: 5_000 });
  assert.equal(await dialog.locator('button.button', { hasText: /^Add$/ }).isDisabled(), true);
  await dialog.locator('#apps-import').fill(JSON.stringify({ mcpServers: { broken: { args: ['x'] } } }));
  await dialog.locator('.apps-import-check.error', { hasText: '"broken": needs "command"' }).waitFor({ timeout: 5_000 });
  await shot('connectors-05-json-error');
  await dialog.locator('#apps-import').fill(JSON.stringify({ mcpServers: { pasted: { type: 'http', url: open.url, headers: { 'X-Api-Key': TYPED } } } }, null, 2));
  await dialog.locator('.apps-import-check li', { hasText: 'pasted: at 127.0.0.1' }).waitFor({ timeout: 5_000 });
  await shot('connectors-06-json-ok');
  await answer('Add');
  await appRow('pasted').waitFor({ timeout: 20_000 });
  await until(async () => (await hint('pasted')).includes('Connected · '), async () => `the pasted server connects – its line: ${await hint('pasted')}`, 90_000);
  assert.ok(!(await mcpText()).includes(TYPED), 'no typed value in mcp.json');
  await shot('connectors-07-connected');

  // A row's ⋯: its tools; who may use it; then back to every agent.
  await more('Form server', 'Show tools');
  await dialog.locator('.apps-tools li', { hasText: 'echo' }).waitFor({ timeout: 5_000 });
  await shot('connectors-08-tools');
  await answer('Done');
  await more('Form server', 'Agents…');
  await dialog.getByRole('radio', { name: 'Only these agents' }).click();
  await shot('connectors-09-agents');
  await answer('Save');
  await until(async () => Array.isArray((await mcp())['Form server'].agents) && (await mcp())['Form server'].agents.length === 0, '"agents": [] in the file');
  await until(async () => (await hint('Form server')).includes('no agent'), 'the line says so');
  assert.ok((await hint('Form server')).includes('Connected'), 'still connected – nothing connected again');
  await more('Form server', 'Agents…');
  await dialog.getByRole('radio', { name: 'Every agent' }).click();
  await answer('Save');
  await until(async () => !('agents' in (await mcp())['Form server']), 'every agent again: the key goes');

  // The switch and Remove.
  await appRow('pasted').getByRole('switch').click();
  await until(async () => (await mcp()).pasted.disabled === true, 'disabled in the file');
  await until(async () => (await hint('pasted')).includes('Off'), 'the row says Off');
  await appRow('pasted').getByRole('switch').click();
  await until(async () => !('disabled' in (await mcp()).pasted), 'on again');
  await until(async () => (await hint('pasted')).includes('Connected'), 'connected again');
  await more('pasted', 'Remove');
  await answer('Remove');
  await until(async () => !('pasted' in (await mcp())), 'removed from the file');
  await appRow('pasted').waitFor({ state: 'detached', timeout: 10_000 });

  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('connectors-10-dark');
  assert.deepEqual(errors.filter((text) => !/^Banner not shown/.test(text)), [], 'no page errors');
});
