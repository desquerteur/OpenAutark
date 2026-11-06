// Electron window check of providers as a file (B-066 G) with the demo engine in an isolated test profile:
//   * settings.json shows the comment above `providers` (every known service, the protocols) with no connection yet;
//   * an entry written into the file on disk becomes an account within a second; its row appears in Settings › Models;
//   * the add form: one "Other" with a Protocol select that only "Other" can change; Add writes an entry with a handle, never the key;
//   * a use row lists the file's connection although nothing it lists serves the use; with no listed model the model cell turns into
//     a text field in the same box, Enter writes "<id>:<name>"; "Other…" does the same, Esc goes back; nothing around it moves;
//   * a decision connection shows up in Decisions and nowhere else; removing a connection removes its entry;
//   * screenshots light, dark and 640×480; no horizontal scroll; no renderer errors. No network call leaves this PC.
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
import { MODEL_USES } from '../../src/shared/model/models-uses.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('settings: providers as a file, free model names, protocols', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-providers-file-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
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
  await size(1280, 900);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const until = async (what, check) => {
    for (let i = 0; i < 100; i += 1) { const value = await check(); if (value) return value; await page.waitForTimeout(150); }
    assert.fail(`waited for ${what}`);
  };
  const choose = async (scope, label, option) => {
    await scope.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option }).first().click();
  };

  // The file before any connection: what the AI sees when it opens it.
  const file = path.join(profile, 'settings.json');
  const before = await readFile(file, 'utf8');
  for (const words of ['Known services (id | url | protocol | key page):', 'deepinfra | https://api.deepinfra.com/v1/openai | openai-chat | https://deepinfra.com/dash/api_keys', 'ollama | http://127.0.0.1:11434/v1 | openai-chat', '  decision: POST <url>/systemone']) {
    assert.ok(before.includes(words), `the comment names: ${words}`);
  }
  assert.ok(before.includes('"providers": {}'), 'no connection yet');

  // An entry written on disk becomes an account.
  const entry = '"providers": {\n    "mine": { "name": "My server", "protocol": "openai-chat", "url": "https://llm.example.test/v1", "models": ["my-chat", { "id": "x-vec-2", "uses": ["embeddings"] }] }\n  }';
  await writeFile(file, before.replace('"providers": {}', entry));
  const mine = await until('the account of the entry', async () => (await rpc.call('accounts.list')).find((account) => account.id === 'mine'));
  assert.deepEqual([mine.provider, mine.label, mine.baseUrl], ['compatible', 'My server', 'https://llm.example.test/v1']);

  await page.evaluate(() => { location.hash = '#/settings/models'; });
  const rows = page.locator('#settings-uses .use-row');
  await rows.first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelectorAll('#settings-uses .use-dot').length > 0 && document.querySelectorAll('#settings-uses .use-dot.pending').length === 0, undefined, { timeout: 60_000 });
  await page.getByText('My server', { exact: true }).first().waitFor({ timeout: 15_000 });
  const row = (use) => rows.nth(MODEL_USES.indexOf(use));

  // The add form: one Other, a Protocol select; a named service shows its protocol read-only.
  await page.getByRole('button', { name: 'API key', exact: true }).click();
  const form = page.locator('.add-account');
  await form.waitFor();
  const protocol = form.getByRole('combobox', { name: 'Protocol', exact: true });
  assert.equal(await protocol.isDisabled(), true, 'OpenAI\'s is fixed');
  await form.getByRole('combobox', { name: 'Provider', exact: true }).click();
  const options = await page.getByRole('option').locator('.select-option-label').allTextContents();
  assert.deepEqual(options.filter((name) => name.startsWith('Other')), ['Other']);
  await page.getByRole('option', { name: 'Other' }).click();
  assert.equal(await protocol.isDisabled(), false);
  await shot('providers-form-other-light');
  await choose(form, 'Protocol', 'Anthropic messages');
  await form.locator('input[type=url]').fill('https://claude.example.test/v1');
  const add = form.getByRole('button', { name: 'Add', exact: true });
  assert.equal(await add.isDisabled(), true, 'Anthropic\'s protocol needs its key');
  await form.locator('input[type=password]').fill('sk-test-window-0000000000');
  await add.click();
  const added = await until('the entry of the form', async () => (await rpc.call('settings.get')).providers?.['claude-example-test']);
  assert.equal(added.protocol, 'anthropic');
  assert.match(added.key, /^secret:\/\//, 'a handle');
  assert.ok(!(await readFile(file, 'utf8')).includes('sk-test-window'), 'the key never reaches the file');
  assert.equal((await rpc.call('accounts.list')).find((account) => account.id === 'claude-example-test').provider, 'anthropic');
  await form.waitFor({ state: 'detached' });

  // Images: nothing lists one, the connection takes a name in the same box, nothing moves.
  const images = row('image');
  await images.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const box = async (locator) => { const b = await locator.boundingBox(); return [Math.round(b.x), Math.round(b.width), Math.round(b.height)]; };
  const modelCell = images.getByRole('combobox', { name: 'Images: model', exact: true });
  const cellBefore = await box(modelCell);
  const name = images.getByRole('textbox', { name: 'Images: model name', exact: true });
  await expectStable(page, ['#settings-uses'], async () => {
    await choose(images, 'Images: provider', 'My server');
    await name.waitFor();
  });
  const fieldBox = await box(name);
  assert.deepEqual([fieldBox[0], fieldBox[1]], [cellBefore[0], cellBefore[1]], 'the same box');
  assert.ok(Math.abs(fieldBox[2] - cellBefore[2]) <= 1, `the same height (${fieldBox[2]} / ${cellBefore[2]})`);
  assert.ok(await name.evaluate((input) => document.activeElement === input), 'the field has the focus');
  await shot('providers-use-name-field');
  await name.fill('art-custom');
  await name.press('Enter');
  await until('routing.image', async () => (await rpc.call('settings.get')).routing.image === 'mine:art-custom');
  await until('the row shows the name', async () => /art-custom/.test((await images.locator('.set-row-control').textContent()) ?? ''));
  const uses = await until('models.uses names it', async () => { const now = (await rpc.call('models.uses')).find((entry) => entry.use === 'image'); return now.modelId === 'mine:art-custom' ? now : undefined; });
  assert.equal(uses.accountId, 'mine');
  assert.equal(uses.gone, undefined);

  // "Other…" on a listed connection (with nothing picked the row shows what runs: the model `uses` names); Esc goes back without writing.
  const embeddings = row('embeddings');
  await embeddings.scrollIntoViewIfNeeded();
  await until('the row shows the model', async () => /x-vec-2/.test((await embeddings.locator('.set-row-control').textContent()) ?? ''));
  await choose(embeddings, 'Embeddings: model', 'Other…');
  const other = embeddings.getByRole('textbox', { name: 'Embeddings: model name', exact: true });
  await other.fill('never-written');
  await other.press('Escape');
  await embeddings.getByRole('combobox', { name: 'Embeddings: model', exact: true }).waitFor();
  assert.equal((await rpc.call('settings.get')).routing.embeddings, 'auto');

  // A decision connection: Decisions lists it, Work does not. Its address is this PC's closed port.
  await rpc.call('settings.update', { providers: { typesafe: { name: 'Decision server', protocol: 'decision', url: 'http://127.0.0.1:9/v1', models: ['jev-latest'] } } });
  await until('its account', async () => (await rpc.call('accounts.list')).find((account) => account.id === 'typesafe'));
  await row('decision').getByRole('combobox', { name: 'Decisions: provider', exact: true }).click();
  assert.ok((await page.getByRole('option').allTextContents()).some((text) => text.includes('Decision server')));
  await page.keyboard.press('Escape');
  await row('work').getByRole('combobox', { name: 'Work: provider', exact: true }).click();
  assert.ok(!(await page.getByRole('option').allTextContents()).some((text) => text.includes('Decision server')));
  await page.keyboard.press('Escape');
  await until('models.uses: the connection decides', async () => (await rpc.call('models.uses')).find((entry) => entry.use === 'decision').modelId === 'typesafe:jev-latest');

  await shot('providers-uses-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('providers-uses-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(640, 480);
  await page.waitForTimeout(500);
  await row('video').scrollIntoViewIfNeeded();
  await shot('providers-uses-640x480');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll (${overflow}px)`);
  await size(1280, 900);

  // Removing a connection removes its entry; the file reads the same again.
  await rpc.call('accounts.remove', { id: 'claude-example-test' });
  assert.equal((await rpc.call('settings.get')).providers?.['claude-example-test'], undefined);
  assert.equal((await rpc.call('accounts.list')).some((account) => account.id === 'claude-example-test'), false);
  assert.ok(!(await readFile(file, 'utf8')).includes('claude-example-test'));

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
