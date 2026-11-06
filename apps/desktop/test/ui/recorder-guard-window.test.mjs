// Electron window check of the recorder's device choice and take guard (F07) with Chromium's
// fake capture devices (four fake cameras) and the demo engine in an isolated profile:
//   * a video record to-do on Home › Needs you (overdue – B-041: Home lists only what needs the
//     person now): "Start camera" shows the preview and a "Camera" select with every camera;
//     picking another colour camera is remembered and the preview reopens;
//   * Record → (time shows once the recorder really records) → Stop gives a take; expanding a second to-do keeps the recording item open, and
//     five more urgent to-dos do not push it out of view (My day);
//   * collapsing it asks "Discard recording?" – Cancel keeps the take;
//   * after another view and after a reload the item offers "Resume unsent recording", which
//     brings the take back; "Discard" in the dialog drops it for good;
//   * leaving the view while still recording keeps the part recorded so far (offered with its
//     duration, resumable); Retake drops the stored copy.
// Screenshots light, dark and phone width; no renderer errors.
// Chromium runs the fake cameras in its "Video Capture" utility process, which crashes now and then
// on a busy PC (0xC0000005, seen in about one run in three, also between takes). The open camera
// track then ends and the widget ends the take there – its right reaction to a lost camera – so a
// step fails without any app fault. Only when main saw that crash is the whole check repeated once in a
// fresh app; every other failure, and a second crash, fails the test.
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

/** A fresh app in its own profile; `captureCrashes()` lists the Video Capture service crashes main saw. */
async function launch() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-recorder-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath,
    // Chromium's fake capture: four fake cameras and a fake microphone, no real device is opened.
    // The fake cameras cycle pixel formats (I420, Y16, MJPEG, I420). A pick of fake_device_1, the
    // 16-bit depth camera, reopened fake_device_0 – most likely getUserMedia does not pick a depth
    // camera as a colour camera and the `ideal` deviceId keeps the default (inferred, not observed).
    // So the switch goes to fake_device_3, an I420 camera like the default; the track label below
    // shows which camera is really open.
    args: [root, '--use-fake-device-for-media-stream=device-count=4'],
    cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  await app.evaluate(({ app: main }) => {
    globalThis.captureCrashes = [];
    main.on('child-process-gone', (_event, details) => {
      if (/video_capture/i.test(details.serviceName ?? '')) globalThis.captureCrashes.push(`${details.reason} ${details.exitCode}`);
    });
  });
  const run = { app, profile, shots, rpc: null };
  run.captureCrashes = () => app.evaluate(() => globalThis.captureCrashes).catch(() => []);
  run.close = async () => {
    run.rpc?.close?.();
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  };
  return run;
}

test('recorder: device select, take guard and "Resume unsent recording"', { timeout: 480_000 }, async (t) => {
  for (let attempt = 1; ; attempt++) {
    const run = await launch();
    try {
      await recorderCheck(run);
      t.diagnostic(`screenshots: ${run.shots}`);
      return;
    } catch (error) {
      const crashes = await run.captureCrashes();
      if (attempt > 1 || !crashes.length) throw error;
      t.diagnostic(`attempt ${attempt}: Chromium's Video Capture service crashed (${crashes.join('; ')}) – once more in a fresh app`);
    } finally {
      await run.close();
    }
  }
});

async function recorderCheck(run) {
  const { app, profile, shots } = run;
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  await size(1280, 860);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  const rpc = await connect(info.port, info.token, 'cli');
  run.rpc = rpc;
  await rpc.call('settings.update', { onboarding: { step: 'done' } }); // B-044: past the first-run layer on Home (first-run-window covers it)

  const recording = await rpc.call('tasks.create', { title: 'Record the intro video for the course', assigneeKind: 'human', widget: { type: 'record', mode: 'video', instructions: 'Record the intro video for the course' } });
  assert.equal(recording.widget?.type, 'record');
  assert.equal(recording.widget?.mode, 'video');
  const other = await rpc.call('todos.add', { text: 'Water the plants' });
  // Overdue: Home shows only Needs you (B-041), and an overdue to-do of the person's is one.
  const overdue = Date.now() - 60 * 60_000;
  for (const task of [recording, other]) await rpc.call('tasks.update', { id: task.id, patch: { dueAt: overdue } });
  await page.evaluate(() => { location.hash = '#/home'; });
  const item = page.locator(`.day-view .todo-item[data-task-id="${recording.id}"]`);
  const second = page.locator(`.day-view .todo-item[data-task-id="${other.id}"]`);
  const playback = item.locator('video.w-record-playback');
  await item.waitFor({ timeout: 15_000 });

  // Device choice: four fake cameras → the select appears in the preview's row.
  await item.locator('.todo-open').click();
  await item.getByRole('button', { name: 'Start camera' }).click();
  await item.locator('.w-record-preview').waitFor({ timeout: 20_000 });
  const select = item.getByRole('combobox', { name: 'Camera' });
  await select.waitFor({ timeout: 10_000 });
  await select.click();
  const list = page.getByRole('listbox', { name: 'Camera' });
  await list.waitFor();
  assert.equal(await list.getByRole('option').count(), 4, 'every fake camera is offered');
  const otherCamera = list.getByRole('option', { name: 'fake_device_3', exact: true });
  assert.equal(await otherCamera.getAttribute('aria-selected'), 'false', 'the default camera is in use first');
  const label = (await otherCamera.textContent()).trim();
  await otherCamera.click();
  await item.getByRole('button', { name: 'Record', exact: true }).waitFor({ timeout: 20_000 });
  await item.locator('.w-record-preview').waitFor();
  // The reopened preview's track names the camera that is really open.
  const preview = await item.locator('video.w-record-preview').elementHandle();
  const opened = await page.waitForFunction(({ video, expected }) => {
    const label = video?.srcObject?.getVideoTracks()[0]?.label;
    return label === expected ? label : false;
  }, { video: preview, expected: label }, { timeout: 10_000 });
  assert.equal(await opened.jsonValue(), label, 'the picked camera is open');
  assert.equal((await select.locator('.select-value').textContent()).trim(), label, 'the picked camera is in use');
  assert.ok(await page.evaluate(() => localStorage.getItem('wf.recorder.device.video')), 'and remembered for the next recording');
  await shot('recorder-01-device-light');

  // A take: Record → Stop → playback. The status says "Starting…" until the recorder really records
  // (its encoder can take a second or more to start on a busy PC); the time shows from then on.
  const recordingTime = item.locator('.w-record-status', { hasText: /^\d+:\d\d/ });
  await item.getByRole('button', { name: 'Record', exact: true }).click();
  await recordingTime.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await item.getByRole('button', { name: 'Stop', exact: true }).click();
  await playback.waitFor({ timeout: 15_000 });

  // Expanding another to-do keeps the recording item open.
  await second.locator('.todo-open').click();
  await second.locator('.todo-body').waitFor();
  assert.equal(await item.locator('.todo-open').getAttribute('aria-expanded'), 'true');
  assert.ok(await playback.isVisible(), 'the take stays on screen');

  // Five more urgent overdue to-dos sort before it; My day still shows it.
  const urgent = [];
  for (let i = 1; i <= 5; i++) urgent.push(await rpc.call('tasks.create', { conversationId: recording.conversationId, title: `Check invoice ${i}`, assigneeKind: 'human', priority: 2, dueAt: overdue }));
  await page.locator('.day-view .todo-item', { hasText: 'Check invoice 5' }).waitFor({ timeout: 15_000 });
  assert.ok(await playback.isVisible(), 'still on screen');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('recorder-02-pinned-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // The hold pins a live widget. After navigation Home again shows its first three; clear these
  // priority fixtures before checking the separate persisted-take flow below.
  for (const task of urgent) await rpc.call('tasks.delete', { id: task.id });

  // Collapsing asks first; Cancel keeps the take.
  await item.locator('.todo-open').click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByText('Discard recording?').waitFor({ timeout: 10_000 });
  await shot('recorder-03-discard-light');
  await dialog.locator('.dialog-actions button', { hasText: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await playback.isVisible(), 'Cancel keeps the take');

  // Another view and back: the take waits in IndexedDB.
  await page.evaluate(() => { location.hash = '#/team'; });
  await item.waitFor({ state: 'detached', timeout: 10_000 });
  await page.evaluate(() => { location.hash = '#/home'; });
  await item.waitFor({ timeout: 15_000 });
  await item.locator('.todo-open').click();
  const resume = item.getByRole('button', { name: 'Resume unsent recording' });
  await resume.waitFor({ timeout: 10_000 });
  await shot('recorder-04-resume-light');

  // Phone width (its own layout, so the item mounts again): the offer is still there and fits.
  await size(420, 860);
  const phoneItem = page.locator(`.todo-item[data-task-id="${recording.id}"]`).first();
  await phoneItem.waitFor({ timeout: 15_000 });
  if ((await phoneItem.locator('.todo-open').getAttribute('aria-expanded')) !== 'true') await phoneItem.locator('.todo-open').click();
  await phoneItem.getByRole('button', { name: 'Resume unsent recording' }).waitFor({ timeout: 10_000 });
  await shot('recorder-05-phone');
  await size(1280, 860);

  // A reload keeps it too; Resume brings the take back.
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await page.evaluate(() => { location.hash = '#/home'; });
  await item.waitFor({ timeout: 15_000 });
  await item.locator('.todo-open').click();
  await resume.waitFor({ timeout: 10_000 });
  await resume.click();
  await playback.waitFor({ timeout: 10_000 });

  // Discard in the dialog drops it for good.
  await item.locator('.todo-open').click();
  await dialog.getByText('Discard recording?').waitFor({ timeout: 10_000 });
  await dialog.locator('.dialog-actions button', { hasText: 'Discard' }).click();
  await dialog.waitFor({ state: 'detached' });
  await playback.waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await item.locator('.todo-open').getAttribute('aria-expanded'), 'false', 'the item collapsed');
  await item.locator('.todo-open').click();
  await item.getByRole('button', { name: 'Start camera' }).waitFor({ timeout: 10_000 });
  assert.equal(await resume.count(), 0, 'nothing is left to resume');

  // Leaving while still recording: the widget finishes the take and keeps it (recordTake).
  await item.getByRole('button', { name: 'Start camera' }).click();
  await item.getByRole('button', { name: 'Record', exact: true }).click({ timeout: 20_000 });
  await item.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 10_000 });
  await recordingTime.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { location.hash = '#/team'; });
  await item.waitFor({ state: 'detached', timeout: 10_000 });
  await page.evaluate(() => { location.hash = '#/home'; });
  await item.waitFor({ timeout: 15_000 });
  await item.locator('.todo-open').click();
  await resume.waitFor({ timeout: 10_000 });
  const unsent = (await item.locator('.w-record-resume').textContent()).trim();
  assert.match(unsent, /^Unsent recording · \d+:\d\d$/);
  assert.notEqual(unsent, 'Unsent recording · 0:00', 'the part recorded before leaving is kept');
  await resume.click();
  await playback.waitFor({ timeout: 10_000 });
  await item.getByRole('button', { name: 'Retake' }).click();
  await item.getByRole('button', { name: 'Record', exact: true }).waitFor({ timeout: 20_000 });
  await item.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { location.hash = '#/team'; });
  await item.waitFor({ state: 'detached', timeout: 10_000 });
  await page.evaluate(() => { location.hash = '#/home'; });
  await item.waitFor({ timeout: 15_000 });
  await item.locator('.todo-open').click();
  await item.getByRole('button', { name: 'Start camera' }).waitFor({ timeout: 10_000 });
  assert.equal(await resume.count(), 0, 'Retake dropped the stored take');

  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
}
