// Electron window check of mini-app to-dos handing files back (X03, wf.upload) with the demo
// engine and Chromium's fake capture devices in an isolated profile:
//   * a mini-app on My day (Home) builds a WAV in the frame and hands it back: the to-do leaves
//     the list, the chat's "Done in mini-app" receipt plays take.wav inline, and the frame's
//     Activity list says "Stored a file for the agent" (wf_upload);
//   * a permissions="microphone" app opens the host recorder after Allow; only Start, Record
//     and Send in the host capture and hand back a WebM; cancellation opens no device.
// Screenshots light, dark and phone width; no renderer errors.
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

// The fake engine's [[app:…|…]] ends at the first "]]": neither app may contain it.
const WAV_APP = '<p>Hands back a generated take.</p><button id="make">Make take</button><p id="out"></p><script>'
  + 'make.onclick = async () => { const n = 1600, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);'
  + ' const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };'
  + ' s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVE"); s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);'
  + ' v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);'
  + ' s(36, "data"); v.setUint32(40, n * 2, true); for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 3) * 8000), true);'
  + ' try { const take = await wf.upload(new Blob([buf], { type: "audio/wav" }), "take.wav"); out.textContent = "Stored " + take.name; await wf.complete({ take }); }'
  + ' catch (error) { out.textContent = "Error: " + error.message; } };</script>';
const MIC_APP = '<button id="go">Record</button><p id="out"></p><script>'
  + 'go.onclick = async () => { try { const take = await wf.record({ mode: "audio", maxSeconds: 30 });'
  + ' out.textContent = "Stored " + take.name; await wf.complete({ take });'
  + ' } catch (error) { out.textContent = "Error: " + error.message; } };</script>';

test('mini-app to-dos hand a generated WAV and a fake-microphone take back to the agent', { timeout: 300_000 }, async (t) => {
  for (const html of [WAV_APP, MIC_APP]) assert.equal(html.includes(']]'), false);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-app-upload-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath,
    // Chromium's fake capture: a fake microphone, no real device is opened.
    args: [root, '--use-fake-device-for-media-stream'],
    cwd: root, timeout: 60_000,
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
  await size(1280, 860);
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } }); // B-044: past the first-run layer on Home (first-run-window covers it)
  await rpc.call('events.subscribe', { topics: ['tasks'] });
  const agents = await rpc.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  const chat = await rpc.call('chats.create', { title: 'Voice-over', agentIds: [manager.id] });

  /** Ava's (the manager's) mini-app to-do from a fake-engine fence. */
  const appTodo = async (attrs, html) => {
    await rpc.call('messages.send', { conversationId: chat.id, body: `Your part [[app:${attrs}|${html}]]` });
    return rpc.waitFor('task.upserted', (item) => item.assigneeKind === 'human' && item.widget?.type === 'app' && item.title === /title="([^"]+)"/.exec(attrs)[1], 90_000);
  };
  /** Opens the to-do on Home › For you and returns its item and the frame inside. */
  const openOnHome = async (todo) => {
    await go('#/home');
    const item = page.locator(`.day-view .todo-item[data-task-id="${todo.id}"]`);
    await item.waitFor({ timeout: 20_000 });
    if ((await item.locator('.todo-open').getAttribute('aria-expanded')) !== 'true') await item.locator('.todo-open').click();
    return item;
  };
  const receiptOf = async (todo) => {
    const messages = await rpc.call('messages.list', { conversationId: chat.id, limit: 100 });
    return messages.find((message) => message.kind === 'answer' && message.taskId === todo.id);
  };

  // 1. A generated WAV handed back from Home › For you.
  const wavTodo = await appTodo('title="Generated take" todo=true reason=physical', WAV_APP);
  const wavItem = await openOnHome(wavTodo);
  const wavFrame = wavItem.locator('iframe.app-frame-iframe.is-ready');
  await wavFrame.waitFor({ timeout: 30_000 });
  await shot('app-upload-01-for-you-light');
  await wavItem.frameLocator('iframe.app-frame-iframe').locator('#make').click();
  await rpc.waitFor('task.upserted', (item) => item.id === wavTodo.id && item.status === 'done', 30_000);
  await wavItem.waitFor({ state: 'detached', timeout: 20_000 });
  const wavReceipt = await receiptOf(wavTodo);
  assert.deepEqual(wavReceipt?.attachments.map((attachment) => [attachment.name, attachment.mime]), [['take.wav', 'audio/wav']]);
  assert.equal(wavReceipt.body, 'Done in mini-app');

  await go(`#/chat/${chat.id}`);
  const receiptView = page.locator(`[data-message-id="${wavReceipt.id}"]`);
  await receiptView.locator('audio.attachment-audio').waitFor({ timeout: 20_000 });
  assert.match((await receiptView.textContent()) ?? '', /Done in mini-app/);
  await shot('app-upload-02-receipt-light');
  // The chat's own copy of the app keeps the frame's Activity: the upload is listed by name and size only.
  const chatFrame = page.locator(`.app-frame[data-block-key="b_${wavTodo.widget.messageId}_${wavTodo.widget.index}"]`);
  await chatFrame.waitFor({ timeout: 20_000 });
  await chatFrame.scrollIntoViewIfNeeded();
  await chatFrame.hover();
  await chatFrame.getByRole('button', { name: 'Activity' }).click();
  const activity = page.locator('.popover.app-activity');
  await activity.waitFor({ timeout: 10_000 });
  const listed = (await activity.textContent()) ?? '';
  assert.ok(listed.includes('Stored a file for the agent') && listed.includes('wf_upload'), listed.slice(0, 300));
  assert.match(listed, /wf_upload · 3 KB/, 'the row shows the 3.2 KB take, not only the message JSON');
  assert.equal(listed.includes('RIFF'), false, 'no payload in the Activity list');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('app-upload-03-activity-dark');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });

  // 2. A microphone app: Allow, record with the fake microphone, hand back a WebM.
  const micTodo = await appTodo('title="Voice-over take" todo=true reason=physical permissions="microphone"', MIC_APP);
  const micItem = await openOnHome(micTodo);
  const allow = micItem.locator('.app-frame-permission button', { hasText: 'Allow' });
  await allow.waitFor({ timeout: 20_000 });
  await size(420, 860);
  await shot('app-upload-04-allow-phone');
  await size(1280, 860);
  const micNow = await openOnHome(micTodo); // the phone layout mounted the item again
  await micNow.locator('.app-frame-permission button', { hasText: 'Allow' }).click();
  await micNow.locator('.app-frame-permission').waitFor({ state: 'detached', timeout: 10_000 });
  await micNow.locator('iframe.app-frame-iframe.is-ready').waitFor({ timeout: 30_000 });
  const inner = micNow.frameLocator('iframe.app-frame-iframe');
  await page.evaluate(() => {
    window.captureCalls = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.captureCalls++; return original(...args); };
  });
  await inner.locator('#go').click();
  const recorder = page.getByRole('dialog', { name: 'Record for mini-app' });
  await recorder.waitFor();
  assert.equal(await page.evaluate(() => window.captureCalls), 0, 'a bridge request never opens a device');
  await recorder.getByRole('button', { name: 'Close', exact: true }).click();
  await inner.locator('#out', { hasText: 'Recording cancelled.' }).waitFor();
  assert.equal(await page.evaluate(() => window.captureCalls), 0, 'cancelling opens no device');
  for (const [width, height, color, name] of [
    [1280, 860, 'light', 'app-upload-05-host-recorder-light'],
    [640, 480, 'light', 'app-upload-06-host-recorder-compact'],
    [420, 860, 'dark', 'app-upload-07-host-recorder-phone-dark'],
  ]) {
    await size(width, height);
    await page.emulateMedia({ colorScheme: color });
    const item = await openOnHome(micTodo);
    await item.frameLocator('iframe.app-frame-iframe').locator('#go').click();
    await recorder.waitFor();
    await shot(name);
    assert.ok(await recorder.evaluate((el) => el.getBoundingClientRect().right <= innerWidth), 'host recorder fits the window');
    await recorder.getByRole('button', { name: 'Close', exact: true }).click();
    await item.frameLocator('iframe.app-frame-iframe').locator('#out', { hasText: 'Recording cancelled.' }).waitFor();
  }
  await size(1280, 860);
  await page.emulateMedia({ colorScheme: 'light' });
  // Crossing the shell breakpoint remounts the frame and cancels its pending request.
  const micAgain = await openOnHome(micTodo);
  const innerAgain = micAgain.frameLocator('iframe.app-frame-iframe');
  await innerAgain.locator('#go').click();
  await recorder.waitFor();
  await t.test('the host records with the fake microphone and the WebM reaches the agent', async () => {
    await recorder.getByRole('button', { name: 'Start microphone', exact: true }).click();
    await recorder.getByRole('button', { name: 'Record', exact: true }).click();
    await page.waitForTimeout(1500);
    await recorder.getByRole('button', { name: 'Stop', exact: true }).click();
    await recorder.locator('audio.w-record-playback').waitFor();
    await recorder.getByRole('button', { name: 'Send', exact: true }).click();
    await rpc.waitFor('task.upserted', (item) => item.id === micTodo.id && item.status === 'done', 30_000);
    const micDone = await rpc.call('tasks.get', { id: micTodo.id });
    assert.match(micDone.result?.evidence?.[0]?.label ?? '', /^recording-.*\.webm$/);
    const micReceipt = await receiptOf(micTodo);
    assert.equal(micReceipt?.attachments.length, 1);
    assert.equal(micReceipt.attachments[0].name, micDone.result.evidence[0].label);
    assert.match(micReceipt.attachments[0].mime, /^(audio|video)\/webm$/, 'a WebM take (the store sniffs WebM as video/webm)');
    assert.ok(micReceipt.attachments[0].size > 0);
    await go(`#/chat/${chat.id}`);
    await page.locator(`[data-message-id="${micReceipt.id}"] .attachments`).waitFor({ timeout: 20_000 });
    await shot('app-upload-05-mic-receipt-light');
  });

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
