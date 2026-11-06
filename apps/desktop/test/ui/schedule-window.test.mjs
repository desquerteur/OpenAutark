// Electron window check of the composer's schedule mode (D4 – it replaced the small "Send later" dialog), demo engine,
// isolated profile:
//   * owner 04.11.2026: with an empty field no Plus entry is greyed out – Send as important sets the draft's level (picked
//     again: normal), Task fills "/task " in;
//   * composer › Add (Plus) offers "Schedule…" (also with an empty field); it switches the composer into schedule mode: ONE
//     settings block appears above the text inside the frame, the field gets taller, the composer grows from the bottom up
//     (the action row, Plus, Ultra, model and Send cells stay exactly where they were), Send becomes "Schedule" (off without text);
//   * Once: Date + Time (one hour ahead), one-tap times, a past time says so in the one line and turns Schedule off;
//   * Repeat: Days (weekday buttons at a time), Interval (every N minutes/hours/days/weeks), Advanced (cron), optional Starts / Ends;
//     the line says "Sends every Monday at 09:00, next: …"; a bad number or cron rule says why; switching between all of them
//     moves nothing (the block keeps its boxes);
//   * files in the draft are named as a reason (a scheduled message is text only); Esc and × leave the mode, the text stays;
//   * Schedule posts through messages.schedule (one-off, weekdays, interval) and leaves the mode; the Send button's right-click
//     menu reads Send/Schedule as important, silently, Schedule…;
//   * Chat details › Scheduled shows a repeating rule in words; right-click: Pause, Edit, Delete; Edit opens the composer in
//     schedule mode with that message (the draft that was in the field comes back afterwards), saving changes it; an untouched
//     rule is not sent again;
//   * light, dark, 640×480 and phone width (no horizontal page scroll, Schedule inside the window); no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable, measureBoxes } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

/** Local YYYY-MM-DD of a time (the date input's value format). */
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** The first local `weekday` (0 Sunday) at `time` after `now`. */
const nextWeekday = (now, weekday, time) => {
  const [h, m] = time.split(':').map(Number);
  for (let ahead = 0; ahead < 8; ahead++) {
    const d = new Date(now); d.setDate(d.getDate() + ahead); d.setHours(h, m, 0, 0);
    if (d.getDay() === weekday && d.getTime() > now) return d.getTime();
  }
  throw new Error('no such day');
};

test('Schedule mode: settings above the text, Once and Repeat, Edit from the list, nothing moves', { timeout: 420_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-schedule-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await size(1280, 820);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Video comments', agentIds: [manager.id] });
  const list = () => rpc.call('schedules.list', { conversationId: chat.id });

  const composer = page.locator('textarea.composer-input');
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await composer.waitFor({ timeout: 20_000 });
  const bar = page.locator('.schedule-bar');
  const line = page.locator('.schedule-line');
  const send = page.locator('button.send-button');
  const date = bar.getByLabel('Date', { exact: true });
  const timeField = bar.getByLabel('Time', { exact: true });
  const radio = (name) => bar.getByRole('radio', { name, exact: true });
  const lineIs = (pattern) => page.waitForFunction(([source]) => new RegExp(source).test(document.querySelector('.schedule-line')?.textContent ?? ''), [pattern.source], { timeout: 10_000 });
  /** The Schedule button's state after the page rendered the last change. */
  const sendIs = (disabled) => page.waitForFunction(([want]) => document.querySelector('button.send-button')?.disabled === want, [disabled], { timeout: 10_000 });
  const openFromPlus = async () => {
    await page.locator('.composer-plus').click();
    const menu = page.getByRole('menu', { name: 'Add' });
    await menu.waitFor({ timeout: 5_000 });
    await menu.getByRole('menuitemcheckbox', { name: /Schedule…/ }).click();
    await bar.waitFor({ timeout: 5_000 });
  };
  const menuLabels = async () => {
    const menu = page.locator('[role="menu"]').last();
    await menu.waitFor({ timeout: 5_000 });
    return (await menu.locator('[role^="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
  };

  // ---- owner 04.11.2026: with an empty field nothing in the Plus menu is greyed out – the levels set the draft's level
  // (a second pick sets it back, the tick shows it), Task fills "/task " in
  const plusMenu = async () => {
    await page.locator('.composer-plus').click();
    const menu = page.getByRole('menu', { name: 'Add' });
    await menu.waitFor({ timeout: 5_000 });
    return menu;
  };
  let plus = await plusMenu();
  assert.equal(await plus.locator('[role^="menuitem"]:disabled').count(), 0, 'no entry is greyed out with an empty field');
  await shot('schedule-00-plus-empty');
  await plus.getByRole('menuitemcheckbox', { name: /Send as important/ }).click();
  await page.locator('.composer.important').waitFor({ timeout: 5_000 });
  plus = await plusMenu();
  assert.equal(await plus.getByRole('menuitemcheckbox', { name: /Send as important/ }).locator('.menu-check').count(), 1, 'the tick shows the level');
  assert.equal(await plus.getByRole('menuitemcheckbox', { name: /Send as important/ }).getAttribute('aria-checked'), 'true', 'and is heard as ticked');
  await plus.getByRole('menuitemcheckbox', { name: /Send as important/ }).click();
  await page.waitForFunction(() => !document.querySelector('.composer.important'), undefined, { timeout: 5_000 });
  plus = await plusMenu();
  await plus.getByRole('menuitem', { name: 'Task', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea.composer-input')?.value === '/task ', undefined, { timeout: 5_000 });
  await composer.fill('');

  // ---- entering the mode: grows from the bottom up, nothing else moves
  const cells =['.composer-actions', '.composer-plus', '.ultra-switch', '.model-chip', '.send-button', '.chat-header'];
  const [frameBefore, inputBefore] = await measureBoxes(page, ['.composer', '.composer-input']);
  assert.equal(await send.getAttribute('aria-label'), 'Send');
  await expectStable(page, cells, openFromPlus);
  const [frameAfter, inputAfter, barBox] = await measureBoxes(page, ['.composer', '.composer-input', '.schedule-bar']);
  assert.ok(Math.abs((frameAfter.y + frameAfter.height) - (frameBefore.y + frameBefore.height)) < 0.5, 'the composer\'s bottom edge stays');
  assert.ok(frameAfter.height > frameBefore.height + 150, `the composer grew upwards (${frameBefore.height} -> ${frameAfter.height})`);
  assert.ok(Math.abs(frameAfter.x - frameBefore.x) < 0.5 && Math.abs(frameAfter.width - frameBefore.width) < 0.5, 'same left edge and width');
  assert.ok(inputAfter.height >= inputBefore.height + 50, `the text area is taller (${inputBefore.height} -> ${inputAfter.height})`);
  assert.ok(barBox.y >= frameAfter.y && barBox.y + barBox.height <= inputAfter.y + 0.5, 'the settings sit above the text, inside the frame');
  assert.equal(await send.getAttribute('aria-label'), 'Schedule', 'Send became Schedule');
  assert.equal(await send.isDisabled(), true, 'nothing to schedule yet');
  assert.match(await composer.getAttribute('placeholder'), /^Scheduled message for /);
  assert.equal(await radio('Once').getAttribute('aria-checked'), 'true');
  assert.equal(await date.inputValue(), day(Date.now() + 3_600_000), 'one hour ahead (or tomorrow late at night)');
  await lineIs(/^Sends (today|tomorrow) at \d\d:\d\d$/);
  await shot('schedule-01-once-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('schedule-02-once-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // ---- Once: one-tap times, a past time
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 30, 0, 0);
  await bar.getByRole('button', { name: 'Tomorrow 09:00' }).click();
  assert.equal(await date.inputValue(), day(tomorrow.getTime()));
  assert.equal(await timeField.inputValue(), '09:00');
  await lineIs(/^Sends tomorrow at 09:00$/);
  await timeField.fill('09:30');
  const draft = 'Check the video comments\n- Answer questions\n- Flag spam';
  await composer.fill(draft);
  const frame = ['.schedule-bar', '.composer', '.composer-input', '.composer-actions', '.schedule-line', '.send-button'];
  const past = Date.now() - 2 * 3_600_000;
  await expectStable(page, frame, async () => { await date.fill(day(past)); await timeField.fill(hhmm(past)); });
  assert.equal((await line.textContent())?.trim(), 'Pick a time in the future.');
  assert.equal(await send.isDisabled(), true, 'Schedule waits for a future time');
  await shot('schedule-03-past-light');
  await date.fill(day(tomorrow.getTime()));
  await timeField.fill('09:30');
  await sendIs(false);

  // ---- every choice keeps the block's boxes
  for (const name of ['Repeat', 'Interval', 'Advanced', 'Days', 'Once']) {
    await expectStable(page, frame, () => radio(name).click());
    if (name === 'Repeat') await lineIs(/^Sends every day at 09:00, next: /);
  }
  await expectStable(page, frame, async () => { await radio('Repeat').click(); await bar.getByLabel('Starts').fill(`${day(tomorrow.getTime())}T08:00`); });
  await radio('Once').click();
  await date.fill(day(tomorrow.getTime()));

  // ---- Schedule once
  await send.click();
  await bar.waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal(await composer.inputValue(), '', 'the draft went with it');
  assert.equal(await send.getAttribute('aria-label'), 'Send');
  let rows = await list();
  assert.equal(rows.length, 1, 'one scheduled message');
  assert.equal(rows[0].kind, 'message');
  assert.equal(rows[0].payload.body, draft);
  assert.equal(rows[0].spec.at, tomorrow.getTime(), 'at the picked local time');
  assert.equal(rows[0].runs, 0, 'nothing sent yet');
  await page.locator('.message-scroller').getByText(/^Scheduled · /).first().waitFor({ timeout: 15_000 });

  // ---- the Send button's menu, then weekdays
  await composer.fill('Weekly status ping');
  await send.click({ button: 'right' });
  assert.deepEqual(await menuLabels(), ['Send as important', 'Send silently', 'Schedule…']);
  await page.locator('[role="menu"]').last().getByRole('menuitemcheckbox', { name: /Schedule…/ }).click();
  await bar.waitFor({ timeout: 5_000 });
  await send.click({ button: 'right' });
  assert.deepEqual(await menuLabels(), ['Schedule as important', 'Schedule silently', 'Schedule…'], 'in the mode the levels schedule');
  await page.keyboard.press('Escape');
  await radio('Repeat').click();
  await radio('Days').click();
  const dayButton = (name) => bar.getByRole('button', { name, exact: true });
  for (const name of ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) await dayButton(name).click();
  assert.equal(await dayButton('Monday').getAttribute('aria-pressed'), 'true');
  assert.equal(await dayButton('Friday').getAttribute('aria-pressed'), 'false');
  await lineIs(/^Sends every Monday at 09:00, next: .+$/);
  await shot('schedule-04-days-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('schedule-05-days-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await dayButton('Monday').click(); // no day at all
  await lineIs(/^Pick at least one day.$/);
  await sendIs(true);
  await dayButton('Monday').click();
  await send.click();
  await bar.waitFor({ state: 'detached', timeout: 5_000 });
  rows = await list();
  const weekly = rows.find((row) => row.payload.body === 'Weekly status ping');
  assert.ok(weekly, 'the weekly message is scheduled');
  assert.deepEqual([weekly.spec.times, weekly.spec.days, weekly.spec.tz, weekly.spec.catchUp], [['09:00'], [1], Intl.DateTimeFormat().resolvedOptions().timeZone, 'once']);
  assert.equal(weekly.nextAt, nextWeekday(Date.now(), 1, '09:00'), 'the next Monday 09:00 local');

  // ---- an interval, a bad number
  await composer.fill('Check the build');
  await openFromPlus();
  await radio('Repeat').click();
  await radio('Interval').click();
  const number = bar.getByLabel('Every', { exact: true });
  await number.fill('0');
  await lineIs(/^Enter how often/);
  await sendIs(true);
  await number.fill('2');
  await bar.getByLabel('Unit').selectOption('hours');
  await lineIs(/^Sends every 2 hours, next: .+$/);
  await shot('schedule-06-interval-light');
  await send.click();
  await bar.waitFor({ state: 'detached', timeout: 5_000 });
  rows = await list();
  const interval = rows.find((row) => row.payload.body === 'Check the build');
  assert.equal(interval?.spec.everyMs, 7_200_000);
  assert.ok(Math.abs(interval.spec.at - (Date.now() + 7_200_000)) < 120_000, 'anchored one interval ahead');

  // ---- Advanced (cron), start and end, a rule the runtime refuses, Esc
  await composer.fill('Monday cron');
  await openFromPlus();
  await radio('Repeat').click();
  await radio('Advanced').click();
  const cron = bar.getByLabel('Cron', { exact: true });
  await cron.fill('0 9 * * 1');
  await lineIs(/^Sends every Monday at 09:00, next: .+$/);
  await cron.fill('0 9 *');
  await lineIs(/^A cron rule has 5 fields/);
  await sendIs(true);
  await cron.fill('61 9 * * 1');
  await lineIs(/Invalid cron expression/);
  await sendIs(true); // the runtime refused the rule: Schedule stays off
  await cron.fill('0 9 * * 1');
  const ends = new Date(); ends.setDate(ends.getDate() + 14);
  const clear = bar.getByRole('button', { name: 'Clear', exact: true });
  assert.equal(await clear.isVisible(), false, 'nothing to clear yet');
  await bar.getByLabel('Ends').fill(day(ends.getTime()));
  await lineIs(/^Sends every Monday at 09:00 until /);
  await expectStable(page, frame, () => clear.click());
  await lineIs(/^Sends every Monday at 09:00, next: /);
  await cron.press('Escape');
  await bar.waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal(await composer.inputValue(), 'Monday cron', 'Esc leaves the mode and keeps the text');

  // ---- files: a scheduled message is text only
  const file = path.join(profile, 'notes.txt');
  await writeFile(file, 'some notes');
  await composer.fill('Message with a file');
  await openFromPlus();
  await page.setInputFiles('.composer-area input[type=file]:not([accept])', file);
  await lineIs(/text only/);
  await sendIs(true); // files cannot be scheduled
  await shot('schedule-07-files-light');
  await page.getByRole('button', { name: 'Remove notes.txt' }).click();
  await lineIs(/^Sends (today|tomorrow) at /);
  await sendIs(false);
  await bar.getByRole('button', { name: 'Leave schedule mode' }).click();
  await bar.waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal(await composer.inputValue(), 'Message with a file');
  await composer.fill('');

  // ---- Chat details › Scheduled: rules in words, right-click Pause / Edit / Delete
  await page.locator('.chat-title-button').first().click();
  const section = page.locator('.chat-details section[aria-label="Scheduled"]');
  await section.waitFor({ timeout: 10_000 });
  await section.scrollIntoViewIfNeeded();
  const row = (text) => section.locator('.details-schedule').filter({ hasText: text });
  await row('Weekly status ping').waitFor({ timeout: 10_000 });
  assert.equal((await row('Weekly status ping').locator('.details-schedule-rule').textContent())?.trim(), 'Every Monday at 09:00');
  assert.equal((await row('Check the build').locator('.details-schedule-rule').textContent())?.trim(), 'Every 2 hours');
  assert.equal(await row('Check the video comments').locator('.details-schedule-rule').count(), 0, 'a one-off has only its next run');
  assert.equal(await section.locator('.switch').count(), 0, 'one way to pause: the row\'s menu');
  await shot('schedule-08-details-light');

  await composer.fill('my unsent draft');
  await row('Weekly status ping').click({ button: 'right' });
  assert.deepEqual(await menuLabels(), ['Pause', 'Edit', 'Delete']);
  await page.locator('[role="menu"]').last().getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await bar.waitFor({ timeout: 5_000 });
  assert.equal(await composer.inputValue(), 'Weekly status ping');
  assert.equal(await radio('Repeat').getAttribute('aria-checked'), 'true');
  assert.equal(await radio('Days').getAttribute('aria-checked'), 'true');
  assert.equal(await dayButton('Monday').getAttribute('aria-pressed'), 'true');
  assert.equal(await dayButton('Tuesday').getAttribute('aria-pressed'), 'false');
  assert.equal(await bar.getByLabel('Time', { exact: true }).inputValue(), '09:00');
  await lineIs(/^Editing · Sends every Monday at 09:00, next: /);
  assert.equal(await page.locator('.ultra-switch').getAttribute('aria-hidden'), 'true', 'an edit cannot change the Ultra hint: the cell is inert');
  await shot('schedule-09-edit-light');
  await composer.fill('Weekly status ping (edited)');
  await bar.getByLabel('Time', { exact: true }).fill('10:00');
  await send.click();
  await bar.waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal(await composer.inputValue(), 'my unsent draft', 'what was in the field comes back');
  rows = await list();
  assert.equal(rows.length, 3, 'edited in place, not added');
  const edited = rows.find((entry) => entry.id === weekly.id);
  assert.equal(edited.payload.body, 'Weekly status ping (edited)');
  assert.deepEqual(edited.spec.times, ['10:00']);
  assert.equal(edited.nextAt, nextWeekday(Date.now(), 1, '10:00'));

  // an untouched rule is not sent again: the interval keeps its anchor
  await row('Check the build').click({ button: 'right' });
  await page.locator('[role="menu"]').last().getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await bar.waitFor({ timeout: 5_000 });
  await composer.fill('Check the build (and the tests)');
  await send.click();
  await bar.waitFor({ state: 'detached', timeout: 5_000 });
  rows = await list();
  const reworded = rows.find((entry) => entry.id === interval.id);
  assert.equal(reworded.payload.body, 'Check the build (and the tests)');
  assert.equal(reworded.spec.at, interval.spec.at, 'the interval kept its anchor');
  assert.equal(reworded.nextAt, interval.nextAt);

  // Esc during an edit gives the field back, too
  await row('Check the video comments').click({ button: 'right' });
  await page.locator('[role="menu"]').last().getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await bar.waitFor({ timeout: 5_000 });
  assert.equal(await composer.inputValue(), draft);
  await composer.press('Escape');
  await bar.waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal(await composer.inputValue(), 'my unsent draft');

  await row('Check the build').click({ button: 'right' });
  await page.locator('[role="menu"]').last().getByRole('menuitem', { name: 'Pause', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.chat-details .details-schedule')].some((element) => element.textContent?.includes('Paused')), undefined, { timeout: 10_000 });
  assert.equal((await list()).find((entry) => entry.id === interval.id).active, false);
  await row('Check the build').click({ button: 'right' });
  assert.deepEqual(await menuLabels(), ['Resume', 'Edit', 'Delete']);
  await page.keyboard.press('Escape');

  await row('Check the video comments').click({ button: 'right' });
  await page.locator('[role="menu"]').last().getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.chat-details .details-schedule')].some((element) => element.textContent?.includes('Check the video comments')), undefined, { timeout: 10_000 });
  assert.equal((await list()).length, 2);

  // ---- small windows: 640×480 and phone width – the mode fits and Schedule stays inside the window
  const fits = async (label, shotName) => {
    if (shotName) await shot(shotName);
    assert.ok(await overflow() <= 1, `${label}: no horizontal page scroll (${await overflow()}px)`);
    const [frameBox, sendBox, barSize] = await measureBoxes(page, ['.composer', 'button.send-button', '.schedule-bar']);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(frameBox.y >= 0 && frameBox.y + frameBox.height <= viewport.height + 0.5, `${label}: the composer is inside the window (${frameBox.y} + ${frameBox.height} of ${viewport.height})`);
    assert.ok(sendBox.x + sendBox.width <= viewport.width + 0.5 && sendBox.y >= 0, `${label}: Schedule is inside the window`);
    assert.ok(barSize.width > 0, `${label}: the settings are shown`);
    // what a row holds stays inside the row's right edge (the segmented choices scroll inside their own box)
    const wide = await page.evaluate(() => [...document.querySelectorAll('.schedule-bar .schedule-row')].flatMap((row) => {
      const edge = row.getBoundingClientRect().right + 1;
      const held = [...row.children].flatMap((child) => (child.matches('.segmented') ? [child] : [child, ...child.children]));
      return held.filter((element) => element.getBoundingClientRect().right > edge).map((element) => `${row.className} > ${element.tagName.toLowerCase()}.${element.className}`);
    }));
    assert.deepEqual(wide, [], `${label}: no row of the settings runs past its edge`);
  };
  await page.locator('.chat-title-button').first().click(); // close the details panel
  await composer.fill('Small window message');
  await openFromPlus();
  await size(640, 480);
  await page.waitForTimeout(500);
  await fits('640×480 once', 'schedule-10-640x480-once');
  await radio('Repeat').click();
  await fits('640×480 repeat', 'schedule-11-640x480-repeat');
  await size(420, 860);
  await page.waitForTimeout(700);
  await fits('phone repeat days', 'schedule-12-phone-days');
  await radio('Interval').click();
  await fits('phone interval', 'schedule-13-phone-interval');
  await radio('Advanced').click();
  await fits('phone advanced', 'schedule-14-phone-advanced');
  await radio('Once').click();
  await fits('phone once', 'schedule-15-phone-once');
  await size(1280, 820);
  await page.waitForTimeout(400);
  await bar.getByRole('button', { name: 'Leave schedule mode' }).click();
  await bar.waitFor({ state: 'detached', timeout: 5_000 });

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
