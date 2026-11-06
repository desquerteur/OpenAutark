// Window check of the 19.10.2026 design changes (not a unit test): the shared Select listbox
// (open), distinguishable avatars for agents with the same initial, the teleprompter of a short
// recording script, Chat details › Telegram (with the connect form, nothing entered), Settings ›
// About › Backup and the agent view's More menu – in light, dark, 640×480 and phone width.
// Starts the real desktop app with the demo engine in an isolated profile; prints problems.
// Run: npm run build && node test/ui/design-tour.mjs <dir>   (the profile stays in <dir>/profile)

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'design-tour'));
const profile = path.join(out, 'profile');
await mkdir(profile, { recursive: true });

const app = await electron.launch({
  executablePath: path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root], cwd: root, timeout: 60_000, env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1' },
});
const page = await app.firstWindow();
const problems = [];
const seen = {};
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
await page.waitForSelector('.shell', { timeout: 60_000 });
const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { BrowserWindow.getAllWindows()[0].setSize(w, h); }, [width, height]);
const shot = async (name, wait = 600) => { await page.waitForTimeout(wait); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
const go = async (hash, wait = 900) => { await page.evaluate((target) => { location.hash = target; }, hash); await page.waitForTimeout(wait); };
const theme = async (scheme) => { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(300); };
const escape = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); };
await size(1280, 820);

const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
const rpc = await connect(info.port, info.token, 'cli');
// A profile kept from an earlier run already has the agents and the chat: reuse them.
const existing = await rpc.call('agents.list');
const manager = existing.find((agent) => agent.template === 'manager');
const agent = async (template, name) => existing.find((item) => item.name === name) ?? rpc.call('agents.create', { template, name, managerId: manager.id });
const mia = await agent('video-editor', 'Mia');
const max = await agent('marketing-lead', 'Max');
const group = (await rpc.call('chats.list')).find((chat) => chat.title === 'Course launch')
  ?? await rpc.call('chats.create', { title: 'Course launch', agentIds: [manager.id, mia.id, max.id] });
await rpc.call('events.subscribe', { topics: [`chat:${group.id}`] });
const record = { type: 'record', mode: 'video', script: 'Welcome to the course. Today: the three steps of a launch.', maxSeconds: 60 };
await rpc.call('messages.send', { conversationId: group.id, body: `@Manager [[ui:${JSON.stringify(record)}]]` });
await rpc.waitFor('message.updated', (message) => message.conversationId === group.id && message.authorId !== 'human' && message.state === 'final', 60_000).catch(() => problems.push('no answer with the record widget'));

/** Opens the chat details panel of the group chat and returns once it is visible. */
const openDetails = async () => {
  await go(`#/chat/${group.id}`, 1200);
  // The title button toggles the panel: click only while it is closed.
  if (!await page.locator('.chat-details').first().isVisible().catch(() => false)) await page.locator('.chat-title-button').first().click();
  await page.locator('section[aria-label="Telegram"]').waitFor({ timeout: 10_000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(out, 'failed-details.png') });
    throw error;
  });
};

const pass = async (suffix) => {
  await go(`#/chat/${group.id}`, 1500);
  seen.avatars = await page.locator('.chat-head-avatar').first().innerText().catch(() => '');
  await shot(`01-group-chat-${suffix}`);
  await go('#/team');
  await shot(`02-team-${suffix}`);
  await go(`#/team/${max.id}`);
  await page.getByRole('button', { name: 'More' }).first().click();
  await shot(`03-agent-more-${suffix}`, 300);
  await escape();
  await openDetails();
  await page.locator('section[aria-label="Telegram"]').scrollIntoViewIfNeeded();
  await shot(`04-details-telegram-${suffix}`);
  await page.getByRole('button', { name: 'Connect Telegram' }).click();
  await shot(`05-telegram-form-${suffix}`, 300);
  await escape();
  await openDetails();
  await page.getByRole('combobox', { name: 'Notifications' }).first().click();
  await page.getByRole('listbox').first().waitFor({ timeout: 5_000 });
  await shot(`06-select-open-${suffix}`, 300);
  await escape();
  await go('#/settings/about');
  await page.getByText('Backup', { exact: true }).first().scrollIntoViewIfNeeded();
  await shot(`07-about-backup-${suffix}`);
};

await theme('light');
await pass('light');
await theme('dark');
await pass('dark');
await theme('light');
await size(640, 480);
await openDetails();
await shot('08-details-640x480', 900);
await go('#/settings/about');
await shot('09-about-640x480');
await size(420, 860);
await go(`#/chat/${group.id}`, 1500);
if (await page.locator('.chat-details').first().isVisible().catch(() => false)) await page.locator('.chat-title-button').first().click();
await page.locator('.w-prompter-text').last().scrollIntoViewIfNeeded().catch(() => problems.push('teleprompter not found at phone width'));
await shot('10-group-chat-phone');
await go(`#/team/${max.id}`);
await shot('11-agent-phone');

rpc.close();
await app.close();
console.log(JSON.stringify({ out, seen, problems }, null, 2));
