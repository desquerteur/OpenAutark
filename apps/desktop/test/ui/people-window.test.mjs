// Electron window check of people of the organisation (F-52; Umbau Einfachheit: the org lives in the Team sidebar, a
// person's actions are the row's right-click menu) with the demo engine in an isolated profile:
//   * Team's Add › Person adds Anna (name, title, reports to you) and goes on to her invite: QR code, then "Show code"
//     (6 digits), Done; she shows in the sidebar's People group;
//   * her browser joins with the invite ticket and the owner allows it → her row's menu › Devices and chats lists the
//     device; Chat details › Members lists her as a person;
//   * a task made in that chat (/task) is given to her in Work's task detail – it lands on her list, not the owner's;
//   * her own app (the PWA in a second window, her person token) shows only her chat and her to-do;
//   * rights (Edit): "Works with your agents" lets her start a chat with an agent (Moodboard, without the owner);
//     without "Starts chats and groups" chats.create is refused and her open app drops "+ Chat" at once (no reload);
//     she leaves a chat herself (its right-click menu › Leave, confirm): it leaves her list, the owner sees the member
//     line; Devices and chats offers Join for Moodboard; Remove of her device signs her browser out at once with her
//     own wording ("Your access to this organisation was removed.", Enter invite code); Remove access → "Access
//     removed", she left her chats (Moodboard: "Left · …" with Join), "Invite again" is offered;
//   * screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

async function postRpc(port, method, params) {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, method, params }) });
  const frame = await response.json();
  if (frame.error) throw new Error(frame.error.message);
  return frame.result;
}

test('Team › People: add, invite, join, chat member, task owner, and the person\'s own app', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-people-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
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
  // The owner's window itself (once her app opens, getAllWindows()[0] may be that second window).
  const mainWindow = await app.browserWindow(page);
  const size = (width, height) => mainWindow.evaluate((win, [w, h]) => { win.setSize(w, h); }, [width, height]);
  const shot = async (name, target = page) => { await target.waitForTimeout(400); await target.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const noOverflow = async (target, what) => {
    const overflow = await target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll ${what} (${overflow}px)`);
  };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  await rpc.call('pwa.enable', { enabled: true, bind: 'localhost' });
  const agents = await rpc.call('agents.list');
  const contextMenu = page.locator('.menu[aria-label="Context menu"]');
  await size(1280, 820);

  // 1. Team: Add › Person (one Add cell in the Team side header) → Add and invite.
  await page.evaluate(() => { location.hash = '#/team'; });
  const add = page.locator('.sidebar [data-cell="add"]');
  await add.waitFor({ timeout: 15_000 });
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Person', exact: true }).click();
  const dialog = page.locator('.person-dialog');
  await dialog.locator('#person-name').fill('Anna Berg');
  await dialog.locator('#person-title').fill('Designer');
  await shot('people-01-add-light');
  await dialog.getByRole('button', { name: 'Add and invite' }).click();
  const invite = page.locator('.person-invite');
  await invite.locator('img.qr').waitFor({ timeout: 15_000 });
  await shot('people-02-invite-qr-light');
  await invite.getByRole('button', { name: 'Show code' }).click();
  assert.match((await invite.locator('.pair-code').textContent()) ?? '', /^\d{3} \d{3}$/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('people-03-invite-code-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await invite.getByRole('button', { name: 'Done' }).click();
  const anna = (await rpc.call('people.list')).find((person) => person.name === 'Anna Berg');
  assert.equal(anna.status, 'invited');
  assert.equal(anna.managerId, 'human', 'reports to you by default');

  // 2. Her browser joins; the owner allows it.
  const ticket = (await rpc.call('people.invite', { id: anna.id })).url.split('#join=')[1];
  const asked = await postRpc(info.port, 'people.join', { ticket, name: 'Laptop · Chrome' });
  const todo = (await rpc.call('todos.list')).find((entry) => entry.title.startsWith('Let Laptop · Chrome join as Anna Berg'));
  assert.ok(todo, 'the owner decides in For you');
  await rpc.call('tasks.complete', { id: todo.id, answer: { choice: 'Allow' } });
  const joined = await postRpc(info.port, 'people.awaitJoin', { ticket: asked.ticket });
  assert.equal(joined.status, 'accepted');
  // Her own row in the sidebar's People group (the right-click menu holds her actions).
  const section = page.locator('.team-nav .team-people');
  const row = section.locator('.team-row.person', { has: page.locator('.row-title', { hasText: /^Anna Berg$/ }) });
  const openCaret = async () => {
    for (const caret of await section.locator('.team-caret[aria-expanded="false"]').all()) await caret.click().catch(() => undefined);
  };
  await section.waitFor({ timeout: 15_000 });
  await openCaret(); // she reports to the owner: open the owner's row
  await row.waitFor({ timeout: 15_000 });
  const personMenu = async (item) => {
    await row.click({ button: 'right' });
    await contextMenu.getByRole('menuitem', { name: item, exact: true }).click();
  };
  await personMenu('Devices and chats');
  const details = page.locator('.person-details');
  await details.locator('.person-list-row', { hasText: 'Laptop · Chrome' }).waitFor({ timeout: 15_000 });
  assert.match((await details.textContent()) ?? '', /stored on this PC/);
  await shot('people-04-access-light');
  await details.getByRole('button', { name: 'Done' }).click();
  await shot('people-05-team-light');

  // 3. A chat with her: Members lists her as a person, with the history rule.
  const chat = await rpc.call('chats.create', { title: 'Launch', agentIds: [agents[0].id], people: [anna.id] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.waitForTimeout(1000);
  if (!await page.locator('.chat-details').first().isVisible().catch(() => false)) await page.locator('.chat-title-button').first().click();
  const members = page.locator('section[aria-label="Members"]');
  await members.locator('.details-member', { hasText: 'Anna Berg' }).waitFor({ timeout: 15_000 });
  await shot('people-06-members-light');

  // 4. A task in that chat, given to Anna through its bubble's task menu, "Send to…" (B-078) – her list, not the owner's.
  const field = page.locator('.composer-area .composer-input');
  await field.fill('/task Pick the colours');
  await field.press('Enter');
  const taskBubble = page.locator('.task-bubble', { hasText: 'Pick the colours' }).first();
  await taskBubble.waitFor({ timeout: 15_000 });
  await taskBubble.click({ button: 'right' });
  const taskMenu = page.locator('.menu[aria-label="Context menu"]');
  await taskMenu.getByRole('menuitem', { name: /Anna Berg/ }).click();
  const hers = await (async () => {
    for (let i = 0; i < 50; i++) {
      const found = (await rpc.call('tasks.list', { assigneeKind: 'human', assigneeId: anna.id })).find((task) => task.title === 'Pick the colours');
      if (found) return found;
      await page.waitForTimeout(200);
    }
    return undefined;
  })();
  assert.ok(hers, 'the task went to Anna');
  assert.ok(!(await rpc.call('todos.list')).some((entry) => entry.id === hers.id), 'not on the owner\'s For you');

  // 5. Her own app: the PWA with her person token in a second window.
  await app.evaluate(({ BrowserWindow }, port) => {
    const win = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { partition: 'persist:people-test' } });
    void win.loadURL(`http://127.0.0.1:${port}/#/`);
  }, info.port);
  // The 'window' event comes before the window has its URL, so look for it among the open windows.
  let pwa;
  for (let i = 0; i < 150 && !pwa; i++) {
    pwa = app.windows().find((win) => win.url().startsWith(`http://127.0.0.1:${info.port}`));
    if (!pwa) await page.waitForTimeout(200);
  }
  assert.ok(pwa, 'her app opens in a second window');
  pwa.on('pageerror', (error) => errors.push(`pwa: ${error.message}`));
  await pwa.evaluate((token) => { localStorage.setItem('wf.token', token); }, joined.token);
  await pwa.reload();
  await pwa.locator('.mobile-shell').waitFor({ timeout: 60_000 }); // 390 px: the phone layout
  await pwa.waitForTimeout(1500);
  const text = (await pwa.textContent('body')) ?? '';
  assert.match(text, /Pick the colours/, 'her to-do');
  await shot('people-07-person-app-phone', pwa);
  await pwa.evaluate(() => { location.hash = '#/chats'; });
  await pwa.waitForTimeout(800);
  await shot('people-08-person-chats-phone', pwa);
  await noOverflow(pwa, 'in the person\'s app at phone width');

  // 5c. Rights (Edit › Works with your agents / Starts chats / Gives tasks): every space, then no chats of her own.
  await page.evaluate(() => { location.hash = '#/team'; });
  await section.waitFor({ timeout: 15_000 });
  await openCaret();
  await row.waitFor({ timeout: 15_000 });
  let edits = 0;
  const rights = async (change) => {
    await personMenu('Edit');
    const edit = page.locator('dialog[open].person-dialog');
    await edit.waitFor({ timeout: 10_000 });
    await change(edit);
    await shot(`people-08d-rights-${++edits}-light`);
    await edit.getByRole('button', { name: 'Save' }).click();
    await edit.waitFor({ state: 'detached', timeout: 10_000 });
  };
  // B-044 visual pass: what she may do lives in her Edit dialog – her row shows no line of permission words
  const scopesOf = async () => (await rpc.call('people.list')).find((person) => person.id === anna.id).scopes;
  assert.doesNotMatch((await row.textContent()) ?? '', /spaces|Starts chats|tasks for agents/, 'no permission jargon on the row');
  assert.deepEqual(await scopesOf(), { spaces: [], startChats: true, assignAgents: true }); // whose agents she works with – not "No agents" (agents may report to her)
  await rights((edit) => edit.getByRole('checkbox', { name: 'Works with your agents' }).check());
  assert.deepEqual(await scopesOf(), { spaces: 'all', startChats: true, assignAgents: true });
  const annaRpc = await connect(info.port, joined.token, 'pwa');
  const moodboard = await annaRpc.call('chats.create', { title: 'Moodboard', agentIds: [agents[0].id] }); // her own chat, without the owner
  await pwa.evaluate(() => { location.hash = '#/chats'; });
  await pwa.locator('.sidebar-action', { hasText: 'Chat' }).first().waitFor({ timeout: 15_000 }); // she may start chats
  await rights(async (edit) => {
    await edit.getByRole('checkbox', { name: 'Starts chats and groups' }).uncheck();
    await edit.getByRole('checkbox', { name: 'Gives tasks to agents' }).uncheck();
  });
  assert.deepEqual(await scopesOf(), { spaces: 'all', startChats: false, assignAgents: false });
  // The rights change closed her live connections (they reconnect with the new rights); a new one is refused chats.create.
  await assert.rejects(annaRpc.call('session.info'), /connection closed/);
  const annaAgain = await connect(info.port, joined.token, 'pwa');
  await assert.rejects(annaAgain.call('chats.create', { title: 'Another', agentIds: [agents[0].id] }), /may not start chats/);
  annaAgain.close();
  // Her open app follows at once, without a reload: the runtime closes her connection on the rights
  // change, the app reconnects with the new session – no "+ Chat" any more.
  await pwa.locator('.sidebar-action', { hasText: 'Chat' }).first().waitFor({ state: 'detached', timeout: 15_000 });
  await pwa.getByText('Moodboard').first().waitFor({ timeout: 15_000 });
  assert.equal(await pwa.locator('.sidebar-action', { hasText: 'Chat' }).count(), 0, 'no "+ Chat" without the right to start chats');
  annaRpc.close();

  // 5c'. She leaves a chat herself: its right-click menu › Leave → confirm → it leaves her list; the owner sees the line.
  const leaving = await rpc.call('chats.create', { title: 'Briefing', agentIds: [agents[0].id], people: [anna.id] });
  const briefingRow = pwa.locator('.chat-row', { hasText: 'Briefing' }).first();
  await briefingRow.waitFor({ timeout: 15_000 });
  await briefingRow.click({ button: 'right' });
  const leave = pwa.locator('.menu[aria-label="Context menu"]').getByRole('menuitem', { name: 'Leave', exact: true });
  await leave.waitFor({ timeout: 15_000 });
  await shot('people-08c2-leave-phone', pwa);
  await leave.click();
  await pwa.locator('dialog[open] .dialog-actions button', { hasText: /^Leave$/ }).click();
  await pwa.evaluate(() => { location.hash = '#/chats'; });
  await pwa.getByText('Moodboard').first().waitFor({ timeout: 15_000 });
  assert.equal(await pwa.getByText('Briefing').count(), 0, 'the chat left her list');
  const lines = await rpc.call('messages.list', { conversationId: leaving.id });
  assert.ok(lines.some((message) => message.kind === 'status' && message.meta?.status?.type === 'member_removed' && message.meta.status.details?.memberId === anna.id), 'the owner sees the member line');

  // 5d. Devices and chats: her chat without the owner offers Join; Remove her device; Remove access → "Left".
  const openDetails = async () => {
    await personMenu('Devices and chats');
    await details.waitFor({ timeout: 10_000 });
  };
  const chatRow = (title) => details.locator('.person-list-row', { has: page.locator('.person-list-text > span', { hasText: new RegExp(`^${title}$`) }) });
  await openDetails();
  await chatRow('Moodboard').waitFor({ timeout: 15_000 });
  assert.equal(await chatRow('Moodboard').getByRole('button', { name: 'Join' }).count(), 1, 'a chat without the owner offers Join');
  assert.equal(await chatRow('Launch').getByRole('button', { name: 'Join' }).count(), 0, 'the owner is in Launch already');
  assert.doesNotMatch((await details.textContent()) ?? '', /Left ·/);
  await details.locator('.person-list-row', { hasText: 'Laptop · Chrome' }).getByRole('button', { name: 'Remove' }).click();
  await page.locator('dialog[open] .dialog-actions button', { hasText: /^Remove$/ }).click();
  await details.getByText('No device yet.').waitFor({ timeout: 15_000 });
  await pwa.locator('.access-request').waitFor({ timeout: 30_000 }); // her browser is signed out at once
  const removedText = (await pwa.locator('.access-request').textContent()) ?? '';
  assert.match(removedText, /Your access to this organisation was removed\./, 'her own wording');
  assert.doesNotMatch(removedText, /This phone was removed|On your PC|Scan QR code/, 'not the owner-phone screen');
  assert.equal(await pwa.getByRole('button', { name: 'Enter invite code' }).count(), 1);
  await shot('people-08e-device-removed-phone', pwa);
  await details.getByRole('button', { name: 'Done' }).click();
  await personMenu('Remove access');
  const revoke = page.locator('dialog[open]');
  assert.match((await revoke.textContent()) ?? '', /Remove Anna Berg's access\?/);
  await revoke.locator('.dialog-actions button', { hasText: /^Remove access$/ }).click();
  await row.locator('.row-preview', { hasText: 'Access removed' }).waitFor({ timeout: 15_000 });
  assert.equal((await rpc.call('people.list')).find((person) => person.id === anna.id).status, 'revoked');
  assert.ok(!(await rpc.call('chats.get', { id: chat.id })).members.some((member) => member.memberId === anna.id && !member.leftAt), 'she left the owner\'s chat');
  await openDetails();
  await chatRow('Moodboard').locator('small', { hasText: /^Left · / }).waitFor({ timeout: 15_000 });
  assert.equal(await chatRow('Moodboard').getByRole('button', { name: 'Join' }).count(), 1, 'the owner may take it over');
  assert.equal(moodboard.title, 'Moodboard');
  await shot('people-08f-left-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('people-08g-left-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await details.getByRole('button', { name: 'Done' }).click();
  await row.click({ button: 'right' });
  assert.equal(await contextMenu.getByRole('menuitem', { name: 'Invite again' }).count(), 1, 'a revoked person can be invited again');
  await page.keyboard.press('Escape');

  // 6. 640×480 and phone width of the owner's Team view.
  await page.evaluate(() => { location.hash = '#/team'; });
  await size(640, 480);
  await page.waitForTimeout(600);
  await shot('people-09-team-640x480');
  await noOverflow(page, 'at 640 px');
  await size(390, 844);
  await page.waitForTimeout(600);
  await shot('people-10-team-phone');
  await noOverflow(page, 'at phone width');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning|ERR_CONNECTION_REFUSED/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
