// Electron window check of Settings (B-066: pages with a left nav; the use rows replaced Abilities) with the demo engine in an
// isolated test profile:
//   * every page of the nav opens, its header has one cell that opens the file behind it, the search narrows the nav;
//   * Models: one fixed row per use, each with a state dot, the provider and model selects and the action slot, all of one
//     height; the word Automatic and the words of the old list ("Use the PC") are gone;
//   * a downloaded speech model that is not in use (seeded in the profile): Speech to text offers Use – the click chooses it
//     (voice.localStt), the row turns ready, nothing above moves;
//   * a use nothing serves (Video): None in both selects, "Set up with AI" opens the Manager's chat with the request typed in, nothing is sent;
//   * Secrets (04.11.2026, no pop-up): one band above the catalog keeps its box whatever it shows; its hint fits two lines (also
//     at phone width) and a right-click lists where each browser exports, every path whole, a row copying its address; a pasted .env splits into rows
//     and Add stores them with kinds from the names; a login and a card are added and edited in the band, an empty input keeps
//     a value; with a list taller than the view a lower row's Edit brings the form into view; a .env through Choose file… (its
//     plain setting skipped) and a dropped file go in (the drop tints, nothing moves); no value is ever on the page; every
//     entry starts selected, None, a row's box and All change only the boxes and the count, Delete asks once and removes the selected ones;
//   * Apps: an MCP server added by address lands in mcp.json, its switch writes "disabled", Remove takes it out; the catalog's search keeps its box;
//   * Feedback: a report in the list and in full; Voice: the model on this PC is removed; Devices: Accept connection requests; Skills: New skill, Delete, the modes;
//   * screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
// Nothing is downloaded here.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';
import { localSpeechModel } from '../../src/shared/model/local-speech-models.ts';
import { MODEL_USES, USE_LABELS } from '../../src/shared/model/models-uses.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const PAGES = ['General', 'Models', 'Calendar', 'Secrets', 'Connectors', 'Skills & memory', 'Devices', 'Feedback', 'About']; // AF-005: Apps is Connectors

test('settings: the pages, their nav and the use rows', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-settings-pages-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  // FastConformer German as downloaded but not chosen (store.ts isInstalled: the manifest and non-empty files)
  const fc = localSpeechModel('fastconformer-de-int8');
  const fcDir = path.join(profile, 'models', 'speech', fc.id);
  await mkdir(fcDir, { recursive: true });
  await writeFile(path.join(fcDir, '.installed.json'), JSON.stringify({ id: fc.id, sha256: fc.download.sha256 }));
  for (const file of fc.files) await writeFile(path.join(fcDir, file), 'x');

  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 120_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });

  // The nav lists every page; each opens, with its one file cell.
  await page.evaluate(() => { location.hash = '#/settings'; });
  const nav = page.locator('.settings-nav-item');
  await nav.first().waitFor({ timeout: 20_000 });
  assert.deepEqual((await nav.allTextContents()).map((text) => text.trim()), PAGES);
  for (const [index, title] of PAGES.entries()) {
    await nav.nth(index).click();
    await page.locator('.settings-top h2', { hasText: title }).waitFor({ timeout: 10_000 });
    assert.ok(await page.locator('.settings-top button[aria-label^="Open "]').count() === 1, `${title} opens its file`);
    await shot(`settings-page-${String(index + 1).padStart(2, '0')}-${title.replace(/\W+/g, '-').toLowerCase()}`);
  }

  // Models: one row per use, no word of the old lists.
  await page.evaluate(() => { location.hash = '#/settings/models'; });
  const rows = page.locator('#settings-uses .use-row');
  await rows.first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelectorAll('#settings-uses .use-dot').length > 0 && document.querySelectorAll('#settings-uses .use-dot.pending').length === 0, undefined, { timeout: 60_000 });
  assert.equal(await rows.count(), MODEL_USES.length);
  const labels = (await rows.locator('.set-row-label > span:not(.dot):not(.sr-only)').allTextContents()).map((text) => text.trim());
  assert.deepEqual(labels, MODEL_USES.map((use) => USE_LABELS[use]));
  const heights = await rows.evaluateAll((list) => list.map((row) => Math.round(row.getBoundingClientRect().height)));
  assert.equal(new Set(heights).size, 1, `every row has the same height (${heights.join(', ')})`);
  const words = await page.locator('.settings-content').textContent();
  for (const gone of ['Automatic', 'Use the PC', 'Abilities', 'Pay-per-use fallback']) assert.ok(!words.includes(gone), `"${gone}" is gone`); // B-072: no fallback row
  await shot('settings-uses-light');

  // Speech to text: the downloaded model is offered (Use); choosing it makes the row ready; nothing above moves.
  const stt = rows.nth(MODEL_USES.indexOf('stt'));
  const use = stt.locator('.account-slot button');
  await use.waitFor({ timeout: 15_000 });
  await stt.scrollIntoViewIfNeeded();
  await expectStable(page, ['#settings-uses .use-row:first-child'], async () => {
    await use.click();
    for (let i = 0; i < 100 && (await rpc.call('settings.get')).voice.localStt !== fc.id; i += 1) await page.waitForTimeout(150);
  });
  assert.equal((await rpc.call('settings.get')).voice.localStt, fc.id, 'the downloaded model is in use');
  await stt.locator('.use-dot.ready').waitFor({ timeout: 30_000 });

  // Video (nothing serves it in the demo profile): None and "Set up with AI".
  const video = rows.nth(MODEL_USES.indexOf('video'));
  const setUp = video.getByRole('button', { name: 'Set up with AI' });
  await setUp.waitFor({ timeout: 10_000 });
  assert.match((await video.locator('.set-row-control').textContent()) ?? '', /None/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('settings-uses-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await setUp.click();
  await page.waitForFunction(() => location.hash.startsWith('#/chat/'), undefined, { timeout: 15_000 });
  const composer = page.locator('textarea.composer-input');
  await composer.waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('textarea.composer-input')?.value.includes('Set up Video'), undefined, { timeout: 10_000 });
  await composer.fill('');

  const open = async (name) => { await page.evaluate((hash) => { location.hash = hash; }, `#/settings/${name}`); await page.locator(`.settings-content[data-section="${name}"]`).waitFor({ timeout: 10_000 }); await page.waitForTimeout(300); };
  const dialog = page.locator('dialog[open]').last();
  const answer = (label) => page.locator('dialog[open]').last().locator('button.button').filter({ hasText: new RegExp(`^${label}$`) }).click();
  const row = (scope, label) => page.locator(`${scope} .set-row`, { has: page.locator('.set-row-label', { hasText: label }) });
  const pick = async (scope, label, option) => { await scope.getByRole('combobox', { name: label }).click(); await page.getByRole('option', { name: option, exact: true }).click(); };
  const until = async (check, what) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await page.waitForTimeout(150)) if (await check()) return;
    assert.fail(`timed out: ${what}`);
  };

  // Secrets (owner 04.11.2026: no pop-up): the band above the catalog keeps its box whatever it shows, so the list never moves.
  await open('secrets');
  const band = page.locator('.secret-band');
  await band.waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('dialog[open]').count(), 0, 'no dialog on the page');
  const steady = ['.secret-band', '.settings-top'];
  const rowsMode = () => band.getByRole('textbox', { name: 'Name 1', exact: true }).waitFor({ timeout: 10_000 });
  const pasteInto = (locator, text) => locator.evaluate((field, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  // The reserved line's hint fits its two lines, also at phone width; a right-click on the band lists where each browser
  // exports, every path whole, and a row copies the address its path starts at (a stub: the PC's clipboard stays as it is).
  const hint = band.locator('.secret-band-line');
  const fits = () => hint.evaluate((line) => line.scrollHeight <= line.clientHeight + 1);
  assert.match(await hint.textContent(), /^Paste a \.env into Name to split it, .* Right-click: where each browser exports\.$/);
  assert.ok(await fits(), 'the hint fits its two lines');
  await size(375, 812);
  await page.waitForTimeout(400);
  assert.ok(await fits(), 'the hint fits its two lines at phone width');
  await shot('settings-secrets-hint-phone');
  await size(1280, 820);
  await page.locator('.settings-top').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.copied = []; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text) => { window.copied.push(text); } }); });
  const sources = page.locator('.menu[aria-label="Context menu"]');
  await expectStable(page, steady, () => hint.click({ button: 'right' }));
  await sources.waitFor({ timeout: 5_000 });
  assert.equal((await sources.locator('.menu-title').textContent())?.trim(), 'Where to export passwords');
  const where = await sources.locator('.menu-label small').evaluateAll((lines) => lines.map((line) => ({ text: line.textContent, whole: line.scrollWidth <= line.clientWidth + 1 })));
  assert.equal(where.length, 5);
  assert.ok(where.every((line) => line.whole), 'every path is readable whole');
  assert.ok(where.some((line) => line.text.includes('NordPass')) && where.some((line) => line.text === 'about:logins › ⋯ › Export passwords'));
  assert.equal(await sources.locator('.icon').count(), 0, 'text only');
  await shot('settings-secrets-export-menu');
  await expectStable(page, steady, () => sources.getByRole('menuitem', { name: /^Chrome, Brave, Opera, Vivaldi/ }).click());
  await band.locator('.secret-band-line.ok', { hasText: 'Copied chrome://password-manager/settings' }).waitFor({ timeout: 5_000 });
  assert.deepEqual(await page.evaluate(() => window.copied), ['chrome://password-manager/settings']);
  // A pasted .env splits into rows; Add stores each with the kind its name suggests.
  await expectStable(page, steady, () => pasteInto(band.getByRole('textbox', { name: 'Name 1', exact: true }), 'SHOP_API_KEY=key-never-shown\nSHOP_TOKEN="token-never-shown"\n# a note\nSHOP_PASS=pass-never-shown'));
  await until(async () => (await band.locator('.secret-kv-row').count()) === 4, 'three rows and the empty one');
  assert.deepEqual(await band.locator('.secret-kv-row input').evaluateAll((inputs) => inputs.map((input) => input.value)), ['SHOP_API_KEY', 'SHOP_TOKEN', 'SHOP_PASS', '']);
  await shot('settings-secrets-rows');
  await band.getByRole('button', { name: 'Add', exact: true }).click();
  await until(async () => (await rpc.call('secrets.list')).filter((info) => info.label.startsWith('SHOP_')).length === 3, 'three secrets stored');
  const shop = await rpc.call('secrets.list');
  assert.deepEqual(['SHOP_API_KEY', 'SHOP_TOKEN', 'SHOP_PASS'].map((label) => shop.find((info) => info.label === label).kind), ['api_key', 'token', 'password']);
  await band.locator('.secret-band-line.ok').waitFor({ timeout: 10_000 });
  assert.equal(await band.locator('.secret-kv-row').count(), 1, 'the band is empty again');
  // A login, then its edit (an empty input keeps the password, a username is changed), then a card – all in the band.
  await expectStable(page, steady, () => band.getByRole('button', { name: 'Login, card or fields…', exact: true }).click());
  await band.locator('#secret-name').fill('Shop login');
  await band.locator('#secret-purpose').fill('The shop, for orders');
  await pick(band, 'Type', 'Login');
  await band.getByRole('textbox', { name: 'Username', exact: true }).fill('me@example.com');
  await band.getByLabel('Password', { exact: true }).fill('hunter2-never-shown');
  await shot('settings-secret-login-new');
  await band.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.secret-entry', { hasText: 'Shop login' }).waitFor({ timeout: 10_000 });
  await rowsMode();
  const login = (await rpc.call('secrets.groups')).find((group) => group.label === 'Shop login');
  assert.equal(login.kind, 'login');
  assert.deepEqual((await rpc.call('secrets.list')).filter((info) => info.group?.id === login.id).map((info) => info.field).sort(), ['password', 'username']);
  await page.getByRole('button', { name: 'Edit Shop login', exact: true }).click(); // the form opens in the band, scrolled into view
  await band.getByRole('textbox', { name: 'Username', exact: true }).fill('new@example.com');
  await shot('settings-secret-login-edit');
  await band.getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => (await rpc.call('secrets.list')).find((info) => info.group?.id === login.id && info.field === 'username')?.hint?.startsWith('n'), 'the username was changed');
  assert.equal((await rpc.call('secrets.list')).filter((info) => info.group?.id === login.id).length, 2, 'the password stays');
  await rowsMode();
  await band.getByRole('button', { name: 'Login, card or fields…', exact: true }).click();
  await band.locator('#secret-name').fill('Company Visa');
  await pick(band, 'Type', 'Payment card');
  await band.getByLabel('Card number', { exact: true }).fill('4242424242424242');
  await shot('settings-secret-card-new');
  await band.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.secret-entry', { hasText: 'Company Visa' }).waitFor({ timeout: 10_000 });
  await rowsMode();
  assert.equal((await rpc.call('secrets.groups')).find((group) => group.label === 'Company Visa').route, 'payment');
  // A list taller than the view: a lower row's Edit brings the band with its form into view.
  for (let at = 1; at <= 16; at++) await rpc.call('secrets.save', { label: `Filler ${String(at).padStart(2, '0')}`, kind: 'api_key', value: `filler-${at}-never-shown`, description: '' });
  const lowest = page.getByRole('button', { name: 'Edit Filler 16', exact: true });
  await lowest.waitFor({ timeout: 10_000 });
  await lowest.click(); // Playwright scrolls the row into view first, so the band is above the view
  const inView = () => band.locator('#secret-name').evaluate((field) => {
    const box = field.getBoundingClientRect();
    const view = field.closest('.settings-body').getBoundingClientRect();
    return box.top >= view.top && box.bottom <= view.bottom;
  }).catch(() => false);
  await until(inView, 'the form in the band is in view after a lower row\'s Edit');
  await band.getByRole('button', { name: 'Cancel', exact: true }).click();
  await rowsMode();
  // A .env through Choose file…, then a dropped one: the line counts them (a plain setting is skipped); the drop tints the zone, nothing moves.
  const envFile = path.join(profile, 'shop.env');
  await writeFile(envFile, 'SHOP_WEBHOOK_SECRET=webhook-never-shown\nNODE_ENV=production\n');
  await band.locator('input[type=file]').setInputFiles(envFile);
  await band.locator('.secret-band-line', { hasText: '1 secret added · 1 skipped (.env file).' }).waitFor({ timeout: 15_000 });
  assert.ok(!(await rpc.call('secrets.list')).some((info) => info.label === 'NODE_ENV'), 'a plain setting stays out of the vault');
  const dropped = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['DROPPED_KEY=dropped-never-shown\n'], 'dropped.env')); return data; });
  await expectStable(page, steady, () => page.locator('.secret-drop').dispatchEvent('dragover', { dataTransfer: dropped }));
  assert.match(await page.locator('.secret-drop').getAttribute('class'), /\bdrop-over\b/);
  await shot('settings-secrets-drop');
  await page.locator('.secret-drop').dispatchEvent('drop', { dataTransfer: dropped });
  await until(async () => (await rpc.call('secrets.list')).some((info) => info.label === 'DROPPED_KEY'), 'the dropped file went in');
  assert.doesNotMatch(await page.locator('.secret-drop').getAttribute('class'), /\bdrop-over\b/);
  assert.ok((await rpc.call('secrets.list')).some((info) => info.label === 'SHOP_WEBHOOK_SECRET'), 'the chosen file went in');
  const secretsText = await page.locator('.settings-content').textContent();
  for (const value of ['hunter2-never-shown', '4242424242424242', 'key-never-shown', 'token-never-shown', 'pass-never-shown', 'webhook-never-shown', 'dropped-never-shown', 'filler-16-never-shown']) {
    assert.ok(!secretsText.includes(value), 'no value on the page');
  }
  await shot('settings-secrets-list');
  // Selection (owner 04.11.2026): every entry starts selected; None, a row's box and All change only the boxes and the
  // count – nothing moves; Delete asks once and removes the selected entries only. (Export is checked in the unit tests:
  // here it would write into this PC's Downloads.)
  const head = page.locator('.set-group-head', { has: page.locator('.secret-selected') });
  const count = head.locator('.secret-selected');
  const total = await page.locator('.secret-entry .secret-pick input').count();
  assert.equal(await count.textContent(), `${total} selected`, 'every entry starts selected');
  const still = ['.secret-band', '.settings-top', '.set-group-head', '.secret-selected', '.secret-entry'];
  const stableClick = async (target) => { await target.scrollIntoViewIfNeeded(); await expectStable(page, still, () => target.click()); };
  await stableClick(head.getByRole('button', { name: 'None', exact: true }));
  await until(async () => (await count.textContent()) === '0 selected', 'None deselects every entry');
  await stableClick(page.getByRole('checkbox', { name: 'Select Filler 01', exact: true }));
  await stableClick(page.getByRole('checkbox', { name: 'Select Filler 02', exact: true }));
  await until(async () => (await count.textContent()) === '2 selected', 'two boxes ticked');
  await shot('settings-secrets-selected');
  await head.getByRole('button', { name: 'Delete', exact: true }).click();
  await answer('Delete');
  await until(async () => !(await rpc.call('secrets.list')).some((info) => /^Filler 0[12]$/.test(info.label)), 'the two selected entries are deleted');
  assert.ok((await rpc.call('secrets.list')).some((info) => info.label === 'Filler 03'), 'the others stay');
  await page.getByRole('checkbox', { name: 'Select Filler 01', exact: true }).waitFor({ state: 'detached', timeout: 10_000 });
  await stableClick(head.getByRole('button', { name: 'All', exact: true }));
  await until(async () => (await count.textContent()) === `${total - 2} selected`, 'All selects every entry again');

  // Apps: by address into mcp.json, off and on through the file, Remove; the search box.
  const mcpFile = path.join(profile, 'connectors', 'mcp.json');
  const mcp = async () => JSON.parse(await readFile(mcpFile, 'utf8')).mcpServers;
  await open('apps');
  await row('#apps-add', 'Own MCP server').getByRole('button', { name: 'Add', exact: true }).click(); // AF-005: was "Add by address"
  await dialog.locator('#apps-address').fill('http://127.0.0.1:9/mcp');
  await dialog.locator('#apps-name').fill('Local test');
  await dialog.locator('#apps-server-token').fill('token-never-in-a-file');
  await shot('settings-apps-address');
  await answer('Connect');
  const appRow = page.locator('.apps-row', { hasText: 'Local test' });
  await appRow.waitFor({ timeout: 20_000 });
  const added = (await mcp())['Local test'];
  assert.equal(added.url, 'http://127.0.0.1:9/mcp');
  assert.match(added.headers.Authorization, /^Bearer secret:\/\//, 'the file holds the handle');
  assert.ok(!(await readFile(mcpFile, 'utf8')).includes('token-never-in-a-file'));
  await appRow.getByRole('switch').click();
  await until(async () => (await mcp())['Local test'].disabled === true, 'disabled in the file');
  await until(async () => (await appRow.locator('.set-row-hint').textContent()).includes('Off'), 'the row says Off');
  await appRow.getByRole('switch').click();
  await until(async () => !('disabled' in (await mcp())['Local test']), 'on again');
  const listBox = await page.locator('.apps-list').boundingBox();
  await page.locator('.apps-search').fill('notion');
  assert.equal(await page.locator('.apps-list .set-row').count(), 1);
  await page.locator('.apps-search').fill('no such app');
  await page.locator('.apps-list').getByRole('button', { name: 'Ask the AI', exact: true }).waitFor({ timeout: 5_000 });
  assert.deepEqual(await page.locator('.apps-list').boundingBox(), listBox, 'the box keeps its place');
  await page.locator('.apps-search').fill('');
  await row('#apps-add', 'Add email').getByRole('button', { name: 'Add', exact: true }).click();
  await shot('settings-apps-mail');
  await answer('Cancel');
  await shot('settings-apps');
  await appRow.click({ button: 'right' });
  assert.ok(await page.getByRole('menuitem', { name: 'Show tools' }).isVisible());
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await answer('Remove');
  await until(async () => !('Local test' in (await mcp())), 'out of the file');
  await appRow.waitFor({ state: 'detached', timeout: 20_000 });

  // Feedback: its own page; a report in the list and in full.
  await rpc.call('feedback.create', { kind: 'idea', text: `A whole idea ${'with many words '.repeat(12)}at its end` });
  await open('feedback');
  const report = page.locator('#settings-feedback .set-row', { hasText: 'A whole idea' });
  await report.waitFor({ timeout: 10_000 });
  await report.getByRole('button', { name: 'Review' }).click();
  assert.match(await dialog.locator('.feedback-review-text').textContent(), /at its end$/);
  await shot('settings-feedback-review');
  await answer('Close');

  // B-078: the Voice page joined Models – the model on this PC is listed once in its last group, with Remove; it goes.
  await open('models');
  const here = page.locator('#settings-speech-models .speech-model-row', { hasText: fc.label });
  await here.waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('#settings-speech-models').getByRole('button', { name: 'Download', exact: true }).count(), 0);
  await shot('settings-voice');
  await here.getByRole('button', { name: 'Remove' }).click();
  await answer('Remove');
  await here.waitFor({ state: 'detached', timeout: 15_000 });
  assert.equal((await rpc.call('settings.get')).voice.localStt, '', 'its choice went with it');

  // Devices: the connection rows are the file's keys.
  await open('devices');
  const accept = row('#settings-connection', 'Accept connection requests').getByRole('switch');
  await accept.waitFor({ timeout: 10_000 });
  await accept.click();
  await until(async () => (await rpc.call('settings.get')).devices.findable === false, 'devices.findable off');
  await accept.click();
  await until(async () => (await rpc.call('settings.get')).devices.findable === true, 'devices.findable on');
  const meeting = page.getByRole('textbox', { name: 'Meeting server', exact: true });
  await meeting.fill('ws://LOCALHOST:9/');
  await meeting.press('Enter');
  await until(async () => (await rpc.call('settings.get')).devices.relay === 'ws://localhost:9', 'the address in its one spelling');
  await meeting.fill('');
  await meeting.press('Enter');
  await until(async () => (await rpc.call('settings.get')).devices.relay === '', 'the meeting server off again');
  await page.locator('#settings-connection').scrollIntoViewIfNeeded();
  await shot('settings-devices-connection');

  // Skills & memory: New skill opens its file in the tab, right click deletes it; the modes are listed. About: both places of a backup.
  await open('skills');
  await page.locator('#settings-modes .set-row').first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'New skill', exact: true }).click();
  await dialog.locator('#skill-name').fill('Weekly Report');
  await dialog.locator('#skill-about').fill('How the weekly report is written');
  await answer('Create');
  const skillRow = page.locator('#settings-skills .file-open-row', { hasText: 'How the weekly report is written' });
  await skillRow.waitFor({ timeout: 15_000 });
  assert.ok((await rpc.call('skills.list')).some((skill) => skill.name === 'weekly-report'));
  await shot('settings-skills-new');
  // The same name again: the dialog says so, and the skill keeps its text.
  await page.getByRole('button', { name: 'New skill', exact: true }).click();
  await dialog.locator('#skill-name').fill('weekly report');
  await dialog.locator('#skill-about').fill('Would overwrite it');
  await answer('Create');
  await dialog.getByText(/exists already/).waitFor({ timeout: 10_000 });
  await answer('Cancel');
  assert.equal((await rpc.call('skills.list')).find((skill) => skill.name === 'weekly-report').description, 'How the weekly report is written');
  await skillRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await answer('Delete');
  await skillRow.waitFor({ state: 'detached', timeout: 15_000 });
  await rpc.call('settings.update', { preferences: { workspaceOpen: false } });
  await open('about');
  for (const label of ['Back up to…', 'Export to…']) assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 1, label);
  await shot('settings-about');

  // 640×480 and phone width: no horizontal scroll; the phone's settings list and a page with Back.
  await page.evaluate(() => { location.hash = '#/settings/models'; });
  for (const [width, height, name] of [[640, 480, 'settings-uses-640x480'], [420, 860, 'settings-uses-phone']]) {
    await size(width, height);
    await page.waitForTimeout(600);
    await page.locator('#settings-uses').first().scrollIntoViewIfNeeded();
    await shot(name);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${width}×${height} (${overflow}px)`);
    for (const section of ['secrets', 'apps', 'devices', 'feedback', 'about']) {
      await open(section);
      await shot(`settings-${section}-${width}`);
      const wide = await page.evaluate(() => { const body = document.querySelector('.settings-body'); return [document.documentElement.scrollWidth - document.documentElement.clientWidth, body ? body.scrollWidth - body.clientWidth : 0]; });
      assert.ok(Math.max(...wide) <= 1, `${section}: no horizontal scroll at ${width}×${height} (${wide.join(', ')})`);
    }
    await open('models');
  }
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.locator('.mobile-main .settings-nav-item').first().waitFor({ timeout: 10_000 });
  await shot('settings-list-phone');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
