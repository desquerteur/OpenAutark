// Electron check of the emergency stop outside the window (23.10., main/work-stop.ts): with the demo
// engine in an isolated profile and the window hidden (close to tray), an agent's turn hangs on a
// native tool ([[hang:bash …]]):
//   * idle: the global shortcut Ctrl+Alt+Shift+X is not registered (the keys stay with other apps);
//   * while the agent works – window hidden – it is registered (the computer-use keys are not taken);
//   * after the stop (work.stop, the call the shortcut and the tray entry make) it is gone again, the
//     state is stopped and the turn ended; after Resume and with nothing running it stays unregistered.
// Pressing the real keys and clicking the real tray menu cannot be driven from Playwright; both call the
// same WorkStopControl.stop() the unit tests cover (test/unit/main/work-stop.test.ts).
// Run: npm run test:ui   (needs a fresh build)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const KEYS = 'Control+Alt+Shift+X';

test('Emergency stop shortcut: registered only while agents work, also with the window hidden; gone after the stop', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-work-stop-'));
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  const page = await app.firstWindow();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const registered = (keys = KEYS) => app.evaluate(({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator), keys);
  const until = async (want, label) => {
    for (let i = 0; i < 75; i++) { if (await registered() === want) return; await page.waitForTimeout(200); }
    assert.fail(`${label}: the shortcut is ${want ? 'not ' : ''}registered`);
  };

  await until(false, 'idle');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide(); });

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Deploy', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`, 'org', 'system'] });
  const working = rpc.waitFor('agent.activity', (event) => event.active.some((run) => run.agentId === manager.id), 30_000);
  await rpc.call('messages.send', { conversationId: chat.id, body: 'Deploy [[hang:bash {"command":"deploy --long"}]]' });
  await working;
  await until(true, 'an agent works, window hidden');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false), false, 'the window stays hidden');
  assert.equal(await registered('Control+Alt+Shift+S'), false, 'the computer-use keys are not taken (no computer use)');

  const stopped = rpc.waitFor('work.state', (state) => state.stopped === true, 15_000);
  const state = await rpc.call('work.stop');
  assert.equal(state.stopped, true);
  await stopped;
  await until(false, 'stopped');
  const idle = rpc.waitFor('agent.activity', (event) => !event.active.some((run) => run.agentId === manager.id), 15_000);
  await idle;

  await rpc.call('work.resume');
  await page.waitForTimeout(800);
  assert.equal(await registered(), false, 'resumed with nothing running: still free');
});
