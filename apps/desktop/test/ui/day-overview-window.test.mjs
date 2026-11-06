// Real Electron with the fake engine, wave 2's leftovers together:
//   * Models: while models.uses has not answered no row says None (seen through a MutationObserver from the first paint on);
//     Video answers None; a use row's hint carries its full text as tooltip;
//   * Skills & memory: "AI providers";
//   * About's Open and the Models row's menu open settings.json in the file tab; About's right click keeps the system's app;
//   * Ctrl+L on a file tab and a folder tab focuses the path field, no new tab, Esc puts it back, Enter on another path keeps
//     the keyboard in the pane; on My day a new tab as before;
//   * My day in the pane: the briefing's place, the list, Ahead today, Chats that matter, Work (B-078 D10: the report's
//     sentences, no stuck rows); Open Work opens the pane's Work tab and the chat stays, a sentence opens its task's chat;
//     another day leaves the overview out;
//   * a deleted chat's space leaves side-tabs.json with its website tab closed, the other spaces stay;
//   * light, dark and 640x480 screenshots, no horizontal scroll in the pane, no renderer errors.
// Run through the lock: run.sh npm run build, then node --test test/ui/day-overview-window.test.mjs.  SCREENSHOTS=<dir> keeps them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the leftovers: models cells, skill title, settings.json in the tab, Ctrl+L, My day overview, a deleted chat\'s space', { timeout: 420_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-overview-'));
  const out = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(out, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell, .mobile-shell', { timeout: 60_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });

  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 400); win.setContentSize(w, h); }, [width, height]);
    await page.waitForTimeout(400);
  };
  const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
  const scheme = async (value) => { await page.emulateMedia({ colorScheme: value }); await page.waitForTimeout(300); };
  const until = async (what, check, ms = 30_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) assert.fail(`waited for ${what}`);
      await sleep(150);
    }
  };
  const go = (hash) => page.evaluate((value) => { location.hash = value; }, hash);
  const strip = page.locator('.browser-strip');
  const tabs = () => page.locator('.browser-strip-tab').count();
  const shownTab = () => page.locator('.browser-strip-tab.selected').getAttribute('data-tab');
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
  const editingPath = () => page.evaluate(() => document.activeElement?.matches('input.browser-address[aria-label="Path"]') ?? false); // the path at rest is a button with the same name
  await size(1280, 800);

  // ---- Models: nothing says None before the answer
  await page.evaluate(() => {
    window.__usesSeen = [];
    const look = () => {
      for (const row of document.querySelectorAll('.use-row')) {
        if (row.querySelector('.use-dot.pending')) window.__usesSeen.push([...row.querySelectorAll('.select-value')].map((cell) => cell.textContent).join('|'));
      }
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await go('#/settings/models');
  const video = page.locator('.use-row', { hasText: 'Video' }).first();
  await until('Video\'s answer', async () => /None/.test((await video.locator('.set-row-control').textContent()) ?? ''));
  const seen = await page.evaluate(() => window.__usesSeen);
  assert.ok(seen.length > 0, 'the rows were seen before the answer');
  assert.ok(seen.every((cells) => cells === '|'), `only empty cells before the answer, saw: ${[...new Set(seen)].join(', ')}`);
  const hint = video.locator('.set-row-hint');
  assert.equal(await hint.getAttribute('title'), (await hint.textContent()).trim(), 'the full hint as tooltip');
  assert.ok((await hint.getAttribute('title')).length > 0);
  await shot('01-models');

  // ---- the Models row's menu: settings.json in the file tab
  await page.locator('.use-row').first().click({ button: 'right', position: { x: 20, y: 12 } });
  await page.getByRole('menuitem', { name: 'Open settings.json' }).click();
  await page.locator('textarea.file-field').waitFor();
  assert.match(await shownTab(), /^file:.*settings\.json$/);
  await until('its text', async () => /routing|profile/.test(await page.locator('textarea.file-field').inputValue()));
  await shot('02-settings-json-from-models');

  // ---- Ctrl+L on a file tab: the path field, selected; Esc puts it back; no new tab
  const before = await tabs();
  await page.locator('textarea.file-field').click();
  await page.keyboard.press('Control+l');
  await until('the path field focused', editingPath);
  const pathField = page.locator('input.browser-address[aria-label="Path"]');
  assert.match(await pathField.inputValue(), /settings\.json$/);
  assert.ok(await pathField.evaluate((field) => field.selectionStart === 0 && field.selectionEnd === field.value.length), 'the path is selected');
  assert.equal(await tabs(), before, 'no new tab');
  await shot('03-ctrl-l-file');
  await page.keyboard.press('Control+l'); // once more while it is open: still there, still selected
  await page.waitForTimeout(200); // the request is handled after the next paint
  assert.equal(await editingPath(), true);
  await page.keyboard.press('Escape');
  await until('the path at rest', async () => (await pathField.count()) === 0);
  await page.keyboard.press('Control+l');
  await until('Ctrl+L again after Esc', editingPath);
  await page.keyboard.press('Enter'); // the same path: nothing opens, and the keyboard stays in the pane here too
  await until('the path at rest after Enter', async () => (await pathField.count()) === 0);
  await page.keyboard.press('Control+l');
  await until('Ctrl+L again after Enter', editingPath);
  await page.keyboard.press('Escape');
  // another path: this tab goes there and the keyboard stays in the pane, so Ctrl+L brings it straight back
  const settingsPath = await page.locator('.browser-bar button.browser-address').getAttribute('title');
  for (const [file, shows] of [[path.join(profile, 'README.md'), /README\.md$/], [settingsPath, /settings\.json$/]]) {
    await until('the keyboard in the pane', async () => (await focused()) === 'Path');
    await page.keyboard.press('Control+l');
    await pathField.fill(file);
    await page.keyboard.press('Enter');
    await until('the typed path in this tab', async () => shows.test(await shownTab()));
  }
  assert.equal(await tabs(), before, 'the same tab');

  // ---- About: Open opens the same tab; the right click keeps the system's app
  await page.locator('.browser-strip-tab').first().waitFor();
  await strip.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.locator('.new-tab .new-tab-row', { hasText: 'Files' }).first().click();
  await until('the folder tab', async () => /^folder:/.test(await shownTab()));
  const withFolder = await tabs();
  await go('#/settings/about');
  const aboutRow = page.locator('.set-row', { hasText: 'settings.json' }).first();
  await aboutRow.getByRole('button', { name: 'Open', exact: true }).click();
  await until('the file tab shown', async () => /^file:.*settings\.json$/.test(await shownTab()));
  assert.equal(await tabs(), withFolder, 'the tab that was open, no second one');
  await aboutRow.click({ button: 'right', position: { x: 20, y: 12 } });
  assert.equal(await page.getByRole('menuitem', { name: 'Open with system' }).count(), 1);
  await page.keyboard.press('Escape');

  // ---- Ctrl+L on a folder tab
  await page.locator('.browser-strip-tab[data-tab^="folder:"]').click();
  await page.locator('.browser-bar button.browser-address').focus();
  await page.keyboard.press('Control+l');
  await until('the path field on the folder tab', editingPath);
  assert.equal(await tabs(), withFolder);
  await page.keyboard.press('Escape');

  // ---- Skills & memory: the skill's own words with AI capitalised
  await go('#/settings/skills');
  await page.locator('.set-row-label', { hasText: /^AI providers$/ }).first().waitFor();
  assert.equal(await page.locator('.set-row-label', { hasText: /^Ai providers$/ }).count(), 0);

  // ---- My day: seed real things
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Launch plan', agentIds: [manager.id] });
  const stuckTask = await rpc.call('tasks.create', { conversationId: chat.id, title: 'Renew the domain', assigneeKind: 'agent', assigneeId: manager.id });
  await rpc.call('tasks.setStatus', { id: stuckTask.id, status: 'blocked', note: 'No login for the registrar' });
  await rpc.call('tasks.create', { conversationId: chat.id, title: 'Approve the logo', assigneeKind: 'human' });
  const notes = await rpc.call('chats.create', { title: 'Press', agentIds: [manager.id] });
  const finished = await rpc.call('tasks.create', { conversationId: notes.id, title: 'Write the launch note', assigneeKind: 'agent', assigneeId: manager.id });
  // B-078 D10: My day's Work block is the report – the agent's own tasks.complete with alsoHandled (the demo engine runs the tool)
  const handled = 'Booked the room for the launch webinar';
  await rpc.call('messages.send', { conversationId: notes.id, body: `Done [[tool:tasks.complete ${JSON.stringify({ taskId: finished.id, summary: 'The draft is in the chat', alsoHandled: [handled] })}]]` });
  const now = Date.now();
  await rpc.call('calendar.add', { kind: 'event', text: 'Call with the tax advisor', startAt: now + 60 * 60_000, endAt: now + 90 * 60_000 });

  await go(`#/chat/${chat.id}`);
  await page.locator('.browser-strip-tab').first().waitFor();
  await strip.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.locator('.new-tab .new-tab-row', { hasText: 'My day' }).first().click();
  const panel = page.locator('.day-panel');
  await panel.waitFor();
  const reportLine = panel.locator('.day-over .work-report-line', { hasText: handled });
  await reportLine.waitFor({ timeout: 60_000 });
  const heads = await panel.locator('.day-over .day-group-heading').allTextContents();
  assert.ok(heads.includes('Chats that matter') && heads.includes('Work'), `blocks: ${heads}`);
  assert.equal(await panel.locator('.day-over-row', { hasText: 'Launch plan' }).count(), 1, 'the chat with something waiting');
  assert.equal(await panel.locator('.day-over-row', { hasText: 'Renew the domain' }).count(), 0, 'B-078 D10: no stuck rows on My day');
  assert.match(await reportLine.getAttribute('title'), /^Write the launch note · /, 'the sentence names its task');
  assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'no sideways scroll');
  await shot('04-my-day-light');
  await panel.locator('.day-over').last().scrollIntoViewIfNeeded();
  await shot('05-my-day-blocks-light');
  await scheme('dark'); await shot('06-my-day-blocks-dark'); await scheme('light');
  await go('#/day'); // at 640 x 480 the main zone takes the window
  await size(640, 480);
  await page.locator('.day-view .day-over').last().scrollIntoViewIfNeeded();
  await shot('07-my-day-640');
  await size(1280, 800);

  // ---- another day: the overview says what is now, so it stays out
  await go('#/day/2030-01-15');
  await page.locator('.day-view').waitFor();
  await until('the overview gone on another day', async () => (await page.locator('.day-view .day-over').count()) === 0 && (await panel.locator('.day-over').count()) === 0);
  await go('#/day');
  await page.locator('.day-view .work-report-line').first().waitFor();
  await shot('08-my-day-full');

  // ---- Open Work: the pane's Work tab, the chat stays
  await go(`#/chat/${chat.id}`);
  await reportLine.waitFor();
  await panel.getByRole('button', { name: 'Open Work', exact: true }).click();
  await page.locator('.pane-work').waitFor();
  assert.equal(await shownTab(), 'work');
  assert.match(await page.evaluate(() => location.hash), new RegExp(chat.id), 'the main zone stays on the chat');
  await shot('09-work-tab');

  // ---- a report sentence opens its task in its chat
  await page.locator('.browser-strip-tab[data-tab="day"]').click();
  await reportLine.click();
  await until('the chat', async () => (await page.evaluate(() => location.hash)).includes(notes.id));

  // ---- a deleted chat's space leaves the file; the website tab closes through the watcher; the rest stays
  const sideFile = path.join(profile, 'side-tabs.json');
  const readSide = async () => JSON.parse(await readFile(sideFile, 'utf8'));
  const doomed = await rpc.call('chats.create', { title: 'To be deleted', agentIds: [manager.id] });
  const kept = await readSide();
  const globalTabs = JSON.stringify(Object.keys(kept.spaces).sort());
  kept.spaces[`chat:${doomed.id}`] = { shown: 'web-doomed', tabs: [{ id: 'web-doomed', url: 'https://example.invalid/doomed' }, { id: `notes:${doomed.id}`, panel: 'notes', conversationId: doomed.id }] };
  await writeFile(sideFile, JSON.stringify(kept, null, 1));
  await until('main to list the tab', async () => (await page.evaluate(() => window.workforce?.workspaceBrowser?.command({ action: 'list' }).then((reply) => reply.map((item) => item.id)) ?? null))?.includes('web-doomed') ?? false);
  await rpc.call('chats.delete', { id: doomed.id });
  await until('the space to leave the file', async () => !Object.hasOwn((await readSide()).spaces, `chat:${doomed.id}`));
  await until('main to close the tab', async () => !(await page.evaluate(() => window.workforce.workspaceBrowser.command({ action: 'list' }).then((reply) => reply.map((item) => item.id)))).includes('web-doomed'));
  await sleep(500); // a late save or layout must not bring it back
  assert.ok(!Object.hasOwn((await readSide()).spaces, `chat:${doomed.id}`), 'it stays out');
  assert.equal(JSON.stringify(Object.keys((await readSide()).spaces).sort()), globalTabs, 'the other spaces stay');

  // ---- deleting the open chat with its area open: the common way
  const open = await rpc.call('chats.create', { title: 'Open and deleted', agentIds: [manager.id] });
  await go(`#/chat/${open.id}`);
  await page.locator('.chat-header [data-cell="browser"] button').click();
  const area = page.locator('.chat-area');
  await area.locator('.browser-strip').waitFor();
  await area.locator('.browser-strip').getByRole('button', { name: 'New tab', exact: true }).click();
  await area.locator('.new-tab .new-tab-row', { hasText: 'My day' }).first().click();
  await until('the panel in that chat\'s space', async () => Object.hasOwn((await readSide()).spaces, `chat:${open.id}`));
  await rpc.call('chats.delete', { id: open.id });
  await until('its space to leave the file', async () => !Object.hasOwn((await readSide()).spaces, `chat:${open.id}`));
  await sleep(800);
  assert.ok(!Object.hasOwn((await readSide()).spaces, `chat:${open.id}`), 'the window does not write it back');
  await shot('10-after-delete');

  // ---- leaving the deleted chat: its area goes with it (a panel opened there would write the space back)
  await go('#/day');
  await area.waitFor({ state: 'detached' });
  await sleep(500);
  assert.ok(!Object.hasOwn((await readSide()).spaces, `chat:${open.id}`), 'it stays out');

  // ---- Ctrl+L on another app tab stays a new tab (the global pane)
  const pane = page.locator('.global-pane');
  await pane.locator('.browser-strip-tab').first().waitFor();
  await pane.locator('.browser-strip').getByRole('button', { name: 'New tab', exact: true }).click();
  await pane.locator('.new-tab .new-tab-row', { hasText: 'Work' }).first().click();
  await page.locator('.pane-work').waitFor();
  await page.locator('.pane-work button').first().focus();
  await page.keyboard.press('Control+l');
  await until('a new tab', async () => /^web-/.test((await pane.locator('.browser-strip-tab.selected').getAttribute('data-tab')) ?? ''));

  assert.deepEqual(errors, []);
});
