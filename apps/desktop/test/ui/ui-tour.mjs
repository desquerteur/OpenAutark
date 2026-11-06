// UI tour for the visual review (not a test): starts the real desktop app with the demo engine in
// a temp profile, fills it with realistic content over the runtime's own RPC (rich answer blocks,
// a Mermaid flow, every ask widget, tasks, an approval, a second agent, a group chat) and saves
// screenshots of every main view in light, dark and phone width.
// Run: npm run build && node test/ui/ui-tour.mjs <screenshot-dir>

import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'workforce-tour'));
await mkdir(shots, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-tour-'));
const app = await electron.launch({
  executablePath: path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root], cwd: root, env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1' },
});
const page = await app.firstWindow();
const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
await page.waitForSelector('.shell', { timeout: 60_000 });
const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
await size(1280, 820);

const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
const rpc = await connect(info.port, info.token, 'cli');
await rpc.call('settings.update', { onboarding: { step: 'done' } }); // B-044: past the first-run layer on Home
await rpc.call('events.subscribe', { topics: ['chats', 'tasks', 'org'] });
const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
const video = await rpc.call('agents.create', { template: 'video-editor', name: 'Mia', managerId: manager.id });
const firstChat = (await rpc.call('chats.list'))[0];
const group = await rpc.call('chats.create', { title: 'Course launch', agentIds: [manager.id, video.id] });
await rpc.call('events.subscribe', { topics: [`chat:${group.id}`, `chat:${firstChat.id}`] });

let replies = 0;
const say = async (conversationId, body) => {
  await rpc.call('messages.send', { conversationId, body });
  replies += 1;
  const want = replies;
  await rpc.waitFor('message.updated', (message) => message.conversationId === conversationId && message.authorId !== 'human' && message.state === 'final' && rpc.events.filter((frame) => frame.event === 'message.updated' && frame.data.state === 'final' && frame.data.authorId !== 'human').length >= want, 60_000).catch(() => undefined);
};
const ui = (block) => `[[ui:${JSON.stringify(block)}]]`;

await say(group.id, `@Manager plan for the launch ${ui({ type: 'steps', items: [{ title: 'Script the intro', status: 'done' }, { title: 'Record the voice-over', status: 'active' }, { title: 'Edit and publish', status: 'todo' }] })} ${ui({ type: 'stats', items: [{ label: 'Sign-ups', value: '1,240', delta: '+18%', trend: 'up' }, { label: 'Open tasks', value: '7' }] })}`);
await say(group.id, `@Manager numbers ${ui({ type: 'chart', kind: 'bar', data: [{ week: 'W1', views: 120 }, { week: 'W2', views: 340 }, { week: 'W3', views: 610 }], x: 'week', y: 'views' })} ${ui({ type: 'table', columns: ['Channel', 'Reach'], rows: [['YouTube', '12k'], ['Newsletter', '3.1k']] })}`);
await say(group.id, '@Manager flow:\n```mermaid\nflowchart LR\n  Idea --> Script --> Record --> Edit --> Publish\n```');
await say(group.id, `@Manager ${ui({ type: 'record', mode: 'video', script: 'Hi, I am Alex. In this course you will learn how to run a one-person company with AI colleagues.', maxSeconds: 90 })}`);
await say(group.id, `@Manager ${ui({ type: 'choice', question: 'Which thumbnail?', options: ['Bright', 'Dark', 'Minimal'] })} ${ui({ type: 'checklist', items: ['Charge the camera', 'Clean the desk', 'Close other apps'] })}`);
await say(firstChat.id, `${ui({ type: 'timer', label: 'Call the bank', duration: 'PT2H' })} ${ui({ type: 'form', fields: [{ name: 'company', label: 'Company name' }, { name: 'vat', label: 'VAT ID' }], submit: 'Save' })}`);
await say(firstChat.id, 'Create tasks [[tool:tasks.create {"title":"Edit the course trailer","notes":"Cut to 60 seconds"}]] [[tool:tasks.create {"title":"Answer YouTube comments"}]]');
await say(firstChat.id, 'Clean up [[tool:shell.exec {"command":"echo cleanup"}]]');
await rpc.call('todos.add', { text: 'Sign the delivery note' });
await page.waitForTimeout(1500);

const go = async (hash, name, wait = 900) => {
  await page.evaluate((target) => { location.hash = target; }, hash);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};
const theme = async (scheme) => { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(300); };

await theme('light');
await go('#/home', '01-home-light');
await go(`#/chat/${group.id}`, '02-group-chat-light', 1500);
await page.evaluate(() => { document.querySelector('.message-scroller')?.scrollTo(0, 0); });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shots, '03a-group-chat-top-light.png') });
await page.evaluate(() => { const el = document.querySelector('.message-scroller'); el?.scrollTo(0, el.clientHeight * 0.9); });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shots, '03b-group-chat-middle-light.png') });
await go(`#/chat/${firstChat.id}`, '04-manager-chat-light', 1500);
await go('#/tasks', '05-tasks-all-light');
await go('#/day', '06-my-day-light');
await go('#/team', '07-team-light');
await go(`#/team/${video.id}`, '08-agent-light');
for (const section of ['general', 'models', 'permissions', 'devices', 'customize', 'about']) await go(`#/settings/${section}`, `09-settings-${section}-light`); // B-044: no Agents section
await go('#/home', '10-home-light-again');
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shots, '11-palette-light.png') });
await page.keyboard.press('Escape');

await theme('dark');
await go('#/home', '20-home-dark');
await go(`#/chat/${group.id}`, '21-group-chat-dark', 1500);
await go('#/tasks', '22-tasks-dark');
await go('#/settings/permissions', '23-settings-permissions-dark');

await theme('light');
await size(420, 860);
await go('#/home', '30-phone-home', 1200);
await go(`#/chat/${group.id}`, '31-phone-chat', 1500);
await go('#/day', '32-phone-my-day', 1200);
await size(640, 480);
await go(`#/chat/${firstChat.id}`, '40-small-chat', 1200);

// Trust checks (PM5): page code can neither open an owner runtime port nor give consent.
await size(1280, 820);
await go('#/settings/permissions', '50-settings-permissions-trust', 1200);
const trust = await page.evaluate(async () => {
  const api = window.workforce;
  const connect = await api.connect().then(() => 'resolved', (error) => `rejected: ${error.message}`);
  let claim = 'missing';
  try { if (typeof api.claimConnector === 'function') { api.claimConnector(); claim = 'claimed'; } } catch (error) { claim = `threw: ${error.message}`; }
  const option = [...document.querySelectorAll('.mode-option')].find((el) => el.textContent.includes('Full autonomy'));
  option?.click(); // a script-made click (isTrusted false)
  return { connect, claim, clicked: Boolean(option) };
});
await page.waitForTimeout(800);
const modeAfter = (await rpc.call('permissions.get')).mode;
if (!trust.connect.startsWith('rejected')) problems.push(`trust: page connect() ${trust.connect}`);
if (!trust.claim.startsWith('threw')) problems.push(`trust: claimConnector() from page code: ${trust.claim}`);
// The section renders only with settings loaded over the UI's own (claimed) runtime port.
if (!trust.clicked) problems.push('trust: no Full autonomy .mode-option found (UI not connected?)');
if (modeAfter !== 'standard') problems.push(`trust: a script-made click switched the mode to ${modeAfter}`);
if (await page.locator('dialog[open]').count()) { problems.push('trust: a script-made click opened the autonomy confirmation'); await page.keyboard.press('Escape'); }

// Money (B-044): Settings › Permissions has one "Monthly spending limit (all agents)" row with the
// currency as its suffix – no budgets, rules, grants or other money fields; the agent page still
// shows both budgets (PM2) – the monthly budget (model use and USD purchases) and the purchase budget.
await rpc.call('agents.update', { id: video.id, patch: { budget: { monthlyUsd: 20, monthlyPurchases: 50 } } });
await go('#/settings/permissions', '51-settings-spending-limit', 1200);
const moneyRows = await page.evaluate(() => ({
  limit: [...document.querySelectorAll('.set-row')].filter((row) => row.textContent?.includes('Monthly spending limit (all agents)')).map((row) => ({ inputs: row.querySelectorAll('input').length, suffix: row.querySelector('.set-suffix')?.textContent ?? '' })),
  budgets: document.querySelectorAll('.budget-row').length,
  removed: ['Allow everything', 'Daily cap', 'Guardian approves above', 'Add rule', 'Secret areas'].filter((text) => document.querySelector('.settings-content')?.textContent?.includes(text)),
}));
if (moneyRows.limit.length !== 1 || moneyRows.limit[0].inputs !== 1) problems.push(`money: expected one Monthly spending limit row with one field (${JSON.stringify(moneyRows.limit)})`);
else if (!moneyRows.limit[0].suffix.trim()) problems.push(`money: the limit has no currency suffix ("${moneyRows.limit[0].suffix}")`);
if (moneyRows.budgets) problems.push(`money: Settings still shows ${moneyRows.budgets} budget rows`);
if (moneyRows.removed.length) problems.push(`money: removed rows are back: ${moneyRows.removed.join(', ')}`);
await go(`#/team/${video.id}`, '52-agent-budget', 1200);
const agentBudget = await page.evaluate(() => document.querySelector('.agent-column')?.textContent ?? '');
if (!agentBudget.includes('Model use and USD purchases') || !agentBudget.includes('Purchases')) problems.push('budgets: the agent page does not show both budgets');
if (await page.locator('.agent-budget-bar').count() < 2) problems.push('budgets: the agent page shows fewer than two budget bars');

// Catch-up (C4): 40 new messages while the chat is closed (the answer + 39 chat.send posts) →
// "New messages" divider with the digest, the list opens at it, "↓ N new" below.
await page.evaluate(() => { location.hash = '#/home'; });
const catchUpChat = await rpc.call('chats.create', { title: 'Weekly review', agentIds: [manager.id] });
await rpc.call('events.subscribe', { topics: [`chat:${catchUpChat.id}`] });
await say(catchUpChat.id, `Post the review notes\n${Array.from({ length: 39 }, (_, i) => `[[tool:chat.send {"text":"Review note ${i + 1}"}]]`).join('\n')}`);
await go(`#/chat/${catchUpChat.id}`, '65-catch-up-light', 1500);
if (await page.locator('.unread-divider').count() !== 1) problems.push('catch-up: no single "New messages" divider after 40 new messages');
if (!(await page.locator('.catch-up-digest').count())) problems.push('catch-up: no digest after 40 new messages');
await theme('dark');
await page.screenshot({ path: path.join(shots, '66-catch-up-dark.png') });
await theme('light');

// Status line (B-044, replaces the Guardian and Outside content rows): Settings › Permissions › Mode
// has one reserved status line – empty while a decision model can review, else it says that outside
// actions ask you in Full autonomy; it keeps its height either way.
await go('#/settings/permissions', '67-settings-permission-status', 1200);
const guardian = await rpc.call('permissions.guardian');
const statusLine = await page.evaluate(() => {
  const line = document.querySelector('.set-status-line');
  return line ? { text: line.textContent ?? '', height: line.getBoundingClientRect().height } : undefined;
});
if (!statusLine) problems.push('permission status: no reserved status line in Settings › Permissions');
else {
  if (!guardian.available && !statusLine.text.includes('until a decision model is available')) problems.push(`permission status: no decision model, but the line says "${statusLine.text}"`);
  if (statusLine.height < 12) problems.push(`permission status: the line reserves no height (${statusLine.height}px)`);
}
if (await page.locator('.guardian-row, .quarantine-row').count()) problems.push('permission status: the Guardian / Outside content choices are back');
await size(420, 860);
await go('#/settings/permissions', '68-phone-settings-permission-status', 1200);
await size(1280, 820);

// Skill modes (CTX4): Settings › Knowledge & skills › Skills – a skill saved for the Video mode
// says so in its row; its editor's mode picker reads "Video" and opens the "Skill modes" menu
// (Every mode + one row per mode, only Video checked). Light, dark and phone width, no horizontal
// page scroll. Saving and clearing modes is checked by test/ui/skill-modes-window.test.mjs.
await rpc.call('skills.save', { name: 'trailer-cuts', description: 'Cutting a course trailer: hook first, 60 seconds, captions always.', body: '1. Open with the hook.\n2. Cut to 60 seconds.\n3. Burn in captions.', modes: ['video'] });
const skillGroup = page.locator('section.set-group', { has: page.locator('h3', { hasText: /^Skills$/ }) });
const skillRow = skillGroup.locator('.skill-row', { has: page.locator('.set-row-label', { hasText: /^trailer-cuts$/ }) });
const modePicker = skillGroup.locator('.skill-editor').getByRole('button', { name: /^Modes: / });
const modeMenu = page.getByRole('menu', { name: 'Skill modes' });
const openModeMenu = async (name) => {
  if (!(await modePicker.count())) await skillRow.getByRole('button', { name: 'Edit trailer-cuts' }).click();
  await modePicker.scrollIntoViewIfNeeded();
  await modePicker.click();
  await modeMenu.waitFor({ timeout: 5_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};
try {
  await page.evaluate(() => { location.hash = '#/settings/knowledge'; });
  await skillRow.waitFor({ timeout: 15_000 });
  await skillRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, '69-settings-skills-light.png') });
  const hint = (await skillRow.locator('.set-row-hint').textContent()) ?? '';
  if (!hint.includes('modes: Video')) problems.push(`skill modes: the Video skill's row does not say "modes: Video" (${hint.slice(0, 160)})`);
  await skillRow.getByRole('button', { name: 'Edit trailer-cuts' }).click();
  const label = ((await modePicker.textContent()) ?? '').trim();
  if (label !== 'Video') problems.push(`skill modes: the picker reads "${label}", expected "Video"`);
  await openModeMenu('70-skill-modes-menu-light');
  const menuRows = await modeMenu.getByRole('menuitem').evaluateAll((items) => items.map((item) => ({ label: item.querySelector('.menu-label span')?.textContent ?? '', checked: Boolean(item.querySelector('.menu-check')) })));
  if (menuRows[0]?.label !== 'Every mode' || menuRows.length < 3) problems.push(`skill modes: the menu shows ${JSON.stringify(menuRows.map((row) => row.label))} (Every mode + one row per mode expected)`);
  const checked = menuRows.filter((row) => row.checked).map((row) => row.label);
  if (checked.join() !== 'Video') problems.push(`skill modes: the menu checks ${JSON.stringify(checked)}, expected only Video`);
  await page.keyboard.press('Escape');
  await theme('dark');
  await openModeMenu('71-skill-modes-menu-dark');
  await page.keyboard.press('Escape');
  await theme('light');
  await size(420, 860);
  await page.waitForTimeout(600);
  await openModeMenu('72-phone-skill-modes');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) problems.push(`skill modes: ${overflow}px horizontal page scroll at phone width`);
  await page.keyboard.press('Escape');
  await skillGroup.locator('.skill-editor').getByRole('button', { name: 'Cancel' }).click();
} catch (error) { problems.push(`skill modes: ${String(error?.message ?? error).split('\n')[0]}`); }
await size(1280, 820);

// Mini-app (F08): the agent reads the app guide through ui.help, then an ```app block in a chat –
// its frame, the Activity list (names and sizes of its bridge calls, never their data), the
// open-link confirm (cancelled, nothing opens) and "Open larger". Light, dark and phone width.
try {
  const appChat = await rpc.call('chats.create', { title: 'Mini-app check', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: [`chat:${appChat.id}`] });
  await say(appChat.id, 'Read the guide [[tool:ui.help {"topic":"app"}]]');
  const listed = await rpc.call('messages.list', { conversationId: appChat.id, limit: 20 });
  if (!listed.some((message) => message.authorId !== 'human' && message.body.includes('ui.help → ## app (sandboxed mini-tool)'))) problems.push('mini-app: ui.help {"topic":"app"} did not return the app guide');
  const html = '<p id="out">Pick one</p><button id="pick">Pick</button> <button id="link">Docs</button> <button id="burst">Burst</button>'
    + '<script>wf.ready.then(() => wf.state.set({ secret: "STATE-SECRET-42" }));'
    + 'pick.onclick = () => wf.send("picked", { secret: "EVENT-SECRET-7" }).then(() => { out.textContent = "Picked"; });'
    + 'burst.onclick = () => { for (let i = 0; i < 12; i++) (i % 2 ? wf.state.set({ n: i }) : wf.send("tick", { n: i })).catch(() => {}); };'
    + 'link.onclick = () => parent.postMessage({ jsonrpc: "2.0", id: 99, method: "ui/open-link", params: { url: "https://example.com/?q=LINK-SECRET" } }, "*");</script>';
  await say(appChat.id, `Try it [[app:title="Picker" expand=true|${html}]]`);
  await go(`#/chat/${appChat.id}`, '73-mini-app-light', 1500);
  const frame = page.locator('.app-frame[data-block-key]').last();
  await frame.locator('iframe.app-frame-iframe.is-ready').waitFor({ timeout: 20_000 });
  const inner = frame.frameLocator('iframe.app-frame-iframe');
  await inner.locator('#pick').click();
  await inner.locator('#out', { hasText: 'Picked' }).waitFor({ timeout: 10_000 });
  const activityText = async (name) => {
    await frame.hover();
    await frame.getByRole('button', { name: 'Activity' }).click();
    const list = page.locator('.popover.app-activity');
    await list.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
    const text = (await list.textContent()) ?? '';
    await page.keyboard.press('Escape');
    return text;
  };
  const first = await activityText('74-mini-app-activity-light');
  for (const needle of ['Connected', 'Saved its state', 'wf_state_set', 'Sent an event to the agent', 'wf_event']) {
    if (!first.includes(needle)) problems.push(`mini-app: the Activity list misses "${needle}" (${first.slice(0, 200)})`);
  }
  await inner.locator('#link').click();
  const linkConfirm = page.locator('dialog[open]', { hasText: 'Open link from mini-app?' });
  await linkConfirm.waitFor({ timeout: 5_000 });
  if (!((await linkConfirm.textContent()) ?? '').includes('https://example.com/?q=LINK-SECRET')) problems.push('mini-app: the link confirm does not show the URL');
  await page.screenshot({ path: path.join(shots, '75-mini-app-open-link.png') });
  await linkConfirm.getByRole('button', { name: 'Cancel' }).click();
  const second = await activityText('76-mini-app-activity-after-link');
  if (!/Asked to open a link[^]*failed/.test(second)) problems.push(`mini-app: the cancelled link is not listed as failed (${second.slice(0, 240)})`);
  for (const secret of ['STATE-SECRET-42', 'EVENT-SECRET-7', 'LINK-SECRET']) if (second.includes(secret)) problems.push(`mini-app: the Activity list shows payload ${secret}`);
  // The Activity line sits under the app, never over it; its list stays on screen while rows
  // arrive (opened at the bottom of the window, then the app makes a burst of different calls).
  const activityButton = frame.getByRole('button', { name: 'Activity' });
  const [appBox, buttonBox] = [await frame.locator('iframe.app-frame-iframe').boundingBox(), await activityButton.boundingBox()];
  if (appBox && buttonBox && buttonBox.y < appBox.y + appBox.height - 1) problems.push('mini-app: the Activity button covers the app');
  await activityButton.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await activityButton.click();
  await page.locator('.popover.app-activity').waitFor({ timeout: 5_000 });
  await inner.locator('#burst').dispatchEvent('click');
  await page.waitForTimeout(600);
  const placed = await page.locator('.popover.app-activity').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), window: innerHeight, rows: element.querySelectorAll('[role=listitem]').length };
  });
  await page.screenshot({ path: path.join(shots, '76b-mini-app-activity-growing.png') });
  if (placed.top < 0 || placed.bottom > placed.window + 1) problems.push(`mini-app: the growing Activity list leaves the window (${JSON.stringify(placed)})`);
  if (placed.rows < 8) problems.push(`mini-app: the open Activity list did not follow the burst (${placed.rows} rows)`);
  await page.keyboard.press('Escape');
  await frame.hover();
  await frame.getByRole('button', { name: 'Open larger' }).click();
  const full = page.locator('dialog.app-fullscreen[open]');
  await full.locator('iframe.app-frame-iframe.is-ready').waitFor({ timeout: 20_000 });
  await page.screenshot({ path: path.join(shots, '77-mini-app-fullscreen.png') });
  await page.keyboard.press('Escape');
  await full.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => problems.push('mini-app: Escape did not close "Open larger"'));
  await theme('dark');
  await activityText('78-mini-app-activity-dark');
  await theme('light');
  await size(420, 860);
  await go(`#/chat/${appChat.id}`, '79-phone-mini-app', 1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) problems.push(`mini-app: ${overflow}px horizontal page scroll at phone width`);
} catch (error) { problems.push(`mini-app: ${String(error?.message ?? error).split('\n')[0]}`); }
await size(1280, 820);

// Agent › Permissions (PM10): "Always allow" on the tour's pending shell.exec approval stores a
// remembered rule on its agent; the agent page lists it with Remove (a script-made click removes
// nothing, a real click does) – B-044: Settings no longer lists rules on agents –, and the
// composer chip's menu acts on a chat override ("Default (…)" first). Light, dark, phone width.
try {
  const cleanup = (await rpc.call('approvals.list', { status: 'pending' })).find((item) => item.details?.tool === 'shell.exec');
  if (!cleanup) throw new Error('no pending shell.exec approval from the tour');
  await rpc.call('approvals.decide', { id: cleanup.id, approve: true, remember: true });
  const owner = cleanup.agentId;
  const rulesNow = async () => ((await rpc.call('agents.get', { id: owner })).permissions?.rules ?? []).length;
  const storedRules = await rulesNow();
  if (storedRules !== 1) problems.push(`agent permissions: ${storedRules} rules stored after "Always allow", expected 1`);
  const rulesGroup = page.locator('section.set-group', { has: page.locator('h3', { hasText: /^Remembered rules$/ }) });
  const removeButton = rulesGroup.getByRole('button', { name: 'Remove shell.exec · echo in the workspace' });
  await page.evaluate((target) => { location.hash = target; }, `#/team/${owner}`);
  await removeButton.waitFor({ timeout: 10_000 });
  await rulesGroup.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, '90-agent-permissions-light.png') });
  const panel = await page.evaluate(() => [...document.querySelectorAll('.agent-column section.set-group h3')].map((h) => h.textContent));
  for (const title of ['Permissions', 'Remembered rules', 'Secrets & cards it may use']) if (!panel.includes(title)) problems.push(`agent permissions: no "${title}" group (${panel.join(', ')})`);
  await page.evaluate(() => { document.querySelector('.agent-rule-row button')?.click(); }); // a script-made click
  await page.waitForTimeout(800);
  if (await rulesNow() !== storedRules) problems.push('agent permissions: a script-made click removed the rule');
  await theme('dark');
  await page.screenshot({ path: path.join(shots, '91-agent-permissions-dark.png') });
  await theme('light');
  await size(420, 860);
  await page.evaluate((target) => { location.hash = target; }, `#/team/${owner}`);
  await removeButton.waitFor({ timeout: 10_000 });
  await rulesGroup.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, '93-phone-agent-permissions.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) problems.push(`agent permissions: ${overflow}px horizontal page scroll at phone width`);
  await size(1280, 820);
  await removeButton.click(); // a real click
  await rulesGroup.getByText('No remembered rules').waitFor({ timeout: 10_000 }).catch(() => problems.push('agent permissions: the rule row stays after Remove'));
  if (await rulesNow() !== 0) problems.push('agent permissions: Remove did not remove the stored rule');
  await rpc.call('chats.update', { id: group.id, settings: { permissionMode: 'standard' } });
  await go(`#/chat/${group.id}`, '94-chat-override-chip', 1500);
  await page.locator('.permission-chip').click();
  const menu = page.getByRole('menu', { name: 'Permissions' });
  await menu.waitFor({ timeout: 5_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '95-chat-override-menu.png') });
  const items = await menu.getByRole('menuitemradio').evaluateAll((els) => els.map((el) => ({ label: el.querySelector('.menu-label span')?.textContent ?? '', checked: el.getAttribute('aria-checked') === 'true' })));
  if (items[0]?.label !== 'Default (Standard)' || items.length !== 3) problems.push(`chat override: the chip menu shows ${JSON.stringify(items.map((item) => item.label))}`);
  if (items.find((item) => item.checked)?.label !== 'Standard') problems.push('chat override: the chip menu does not check the chat\'s Standard override');
  await menu.getByRole('menuitemradio', { name: /^Default \(Standard\)/ }).click();
  await page.waitForTimeout(800);
  if ((await rpc.call('chats.get', { id: group.id })).settings.permissionMode !== undefined) problems.push('chat override: "Default" in the chip menu did not clear the chat override');
} catch (error) { problems.push(`agent permissions: ${String(error?.message ?? error).split('\n')[0]}`); }
await size(1280, 820);

rpc.close();
await app.close();
console.log(JSON.stringify({ shots, profile, problems }, null, 2));
