// AF-014 Electron window check of "Agent from folder" with the demo engine in an isolated test profile and a test repo
// (package.json, README.md, CLAUDE.md, AGENTS.md, .claude/skills, .codex/skills, .codex/config.toml):
//   * a folder dropped on the Team list opens the dialog: name and role from package.json, Follows CLAUDE.md · AGENTS.md,
//     the repo's skills, the other tools' settings; Create agent opens the new agent's page;
//   * the agent's home project is the repo, its access mode is "Auto in project folder";
//   * in its chat the agent's system prompt carries the repo's CLAUDE.md and AGENTS.md rules and names its skills
//     (the demo engine's [[prompt:…]] quotes those lines), and its own text says it follows them;
//   * it writes inside the repo by itself; a write outside opens the approval dialog;
//   * a second agent from the same folder is fine; "Group agents by folder" shows both under the folder's name;
//   * the Explorer's request (main's navigate message with the folder) opens the dialog with that folder;
//   * screenshots light and 375 px; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots and the test repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const exists = (file) => stat(file).then(() => true, () => false);

async function testRepo(dir) {
  const files = {
    'package.json': JSON.stringify({ name: 'pineapple-shop', description: 'Online shop for pineapples', devDependencies: { typescript: '5' } }, null, 2),
    'README.md': '# Pineapple Shop\n\nThe online shop for pineapples.\n',
    'CLAUDE.md': '# Project rules\nEvery answer about this shop ends with the code word KIWI-RULE-7.\n',
    'AGENTS.md': '# Agents\nRun the checks with npm test before saying a change is done (AGENTS-RULE-3).\n',
    '.claude/skills/release/SKILL.md': '---\nname: release-pineapples\ndescription: How we ship a pineapple release\n---\n1. Tag. 2. Ship.\n',
    '.codex/skills/db-migrate/SKILL.md': '---\nname: db-migrate\ndescription: Migrate the shop database safely\n---\nSteps.\n',
    '.codex/config.toml': 'model = "gpt"\n',
  };
  for (const [route, text] of Object.entries(files)) {
    const file = path.join(dir, ...route.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

test('agent from folder: drop, suggestions, home project, its CLAUDE.md/AGENTS.md and skills, project access, grouping', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-folder-agent-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  const repo = process.env.SCREENSHOTS ? path.join(shots, 'pineapple-shop') : path.join(profile, 'pineapple-shop');
  await mkdir(shots, { recursive: true });
  await rm(repo, { recursive: true, force: true });
  await testRepo(repo);
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
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
  const until = async (what, check, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(150)) { const value = await check(); if (value) return value; }
    assert.fail(`timed out: ${what}`);
  };

  // Drop the repo folder on the Team list.
  await page.evaluate(() => { location.hash = '#/team'; });
  const nav = page.locator('.team-nav');
  await nav.waitFor({ timeout: 20_000 });
  const url = pathToFileURL(repo).href;
  await nav.evaluate((element, href) => {
    const data = new DataTransfer();
    data.setData('text/uri-list', href);
    element.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, url);
  const dialog = page.locator('dialog.folder-agent-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  await until('the suggestions', async () => (await dialog.getByRole('textbox', { name: 'Name' }).count()) > 0);
  assert.equal(await dialog.getByRole('textbox', { name: 'Name' }).inputValue(), 'Pineapple Shop');
  assert.equal(await dialog.getByRole('textbox', { name: 'Role' }).inputValue(), 'Works on Pineapple Shop: Online shop for pineapples');
  const text = await dialog.textContent();
  assert.match(text, /Follows\s*AGENTS\.md · CLAUDE\.md/);
  assert.match(text, /Skills\s*db-migrate · release-pineapples/);
  assert.match(text, /\.codex\/config\.toml/);
  await shot('folder-agent-dialog-light');
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await until('the new agent\'s page', async () => {
    if (/^#\/team\/ag_/.test(await page.evaluate(() => location.hash))) return true;
    const message = (await page.locator('dialog.folder-agent-dialog .dialog-message').textContent().catch(() => '')) ?? '';
    if (message.trim()) assert.fail(`create failed: ${message}`);
    return false;
  });
  const agentId = (await page.evaluate(() => location.hash)).split('/')[2];

  // Its home project and access.
  const core = await rpc.call('agents.core', { agentId });
  assert.equal(core.home?.path, repo);
  const access = await rpc.call('access.get', { agentId });
  assert.deepEqual([access.mode, access.project], ['project', repo]);
  await page.locator('section.agent-section[aria-label="Access"]').waitFor({ timeout: 15_000 });
  await shot('folder-agent-page-light');

  // Its prompt carries the repo's rules and skills; it writes inside by itself and asks for outside.
  const chat = await rpc.call('chats.create', { title: 'Shop work', agentIds: [agentId] });
  const agentDoes = async (body) => {
    const sent = await rpc.call('messages.send', { conversationId: chat.id, body });
    return until('the agent\'s answer', async () => {
      const messages = await rpc.call('messages.list', { conversationId: chat.id, limit: 50 });
      return messages.find((message) => message.authorId === agentId && message.seq > sent.seq && message.state === 'final')?.body;
    });
  };
  const prompt = await agentDoes('[[prompt:KIWI-RULE-7]] [[prompt:AGENTS-RULE-3]] [[prompt:db-migrate]] [[prompt:release-pineapples]] [[prompt:I follow the project]]');
  assert.match(prompt, /prompt → .*KIWI-RULE-7/, 'CLAUDE.md is in the prompt');
  assert.match(prompt, /prompt → .*AGENTS-RULE-3/, 'AGENTS.md is in the prompt');
  assert.match(prompt, /prompt → .*db-migrate/, 'the Codex skill is listed');
  assert.match(prompt, /prompt → .*release-pineapples/, 'the Claude skill is listed');
  assert.match(prompt, /prompt → .*I follow the project's own instructions/, 'its own text says it follows them');
  const inside = await agentDoes(`[[tool:files.write ${JSON.stringify({ path: path.join(repo, 'notes.md'), content: 'inside' })}]]`);
  assert.doesNotMatch(inside, /does not allow|declined/);
  assert.equal(await readFile(path.join(repo, 'notes.md'), 'utf8'), 'inside');
  const outsideFile = path.join(profile, 'outside', 'x.md');
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  const outside = agentDoes(`[[tool:files.write ${JSON.stringify({ path: outsideFile, content: 'outside' })}]]`);
  const approval = page.locator('dialog.access-request');
  await approval.waitFor({ state: 'visible', timeout: 30_000 });
  assert.match(await approval.textContent(), /outside its project folder/);
  await approval.getByRole('button', { name: 'Deny' }).click();
  assert.match(await outside, /declined/);
  assert.equal(await exists(outsideFile), false);
  assert.match(await page.locator('.composer-actions .access-mode-cell').textContent(), /Project/);

  // A second agent from the same folder (main's Explorer request opens the dialog); both grouped under the folder.
  await app.evaluate(({ BrowserWindow }, folder) => { BrowserWindow.getAllWindows()[0].webContents.send('app:navigate', { agentFromFolder: folder }); }, repo);
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  await until('the suggestions again', async () => (await dialog.getByRole('textbox', { name: 'Name' }).count()) > 0);
  assert.match(await dialog.textContent(), /Already working here\s*Pineapple Shop/);
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Shop Reviewer');
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await until('the second agent', async () => (await rpc.call('agents.list')).some((agent) => agent.name === 'Shop Reviewer'));
  await page.evaluate(() => { location.hash = '#/team'; });
  await page.locator('.side-zone [aria-label="Add"], .team-nav ~ * [aria-label="Add"], [aria-label="Add"]').first().click();
  await page.getByRole('menuitemcheckbox', { name: 'Group agents by folder' }).or(page.getByRole('menuitem', { name: 'Group agents by folder' })).first().click();
  const group = page.locator('.team-folder', { has: page.locator('.team-space-title', { hasText: 'pineapple-shop' }) });
  await group.waitFor({ timeout: 15_000 });
  assert.match(await group.textContent(), /Pineapple Shop[\s\S]*Shop Reviewer|Shop Reviewer[\s\S]*Pineapple Shop/);
  await shot('folder-agent-grouped-light');
  await size(375, 760);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal scroll at 375 px');
  await shot('folder-agent-grouped-375');
  assert.deepEqual(errors.filter((line) => !/favicon|ResizeObserver/.test(line)), [], 'no renderer errors');
});
