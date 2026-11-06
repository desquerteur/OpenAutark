// Electron window check of the voice settings on Settings › Models (B-078 D17: the Voice page is a group of Models) with the
// demo engine in an isolated test profile:
//   * #/settings/models: the Voice group (#settings-voice) holds "Reading voice" and "Learned words"; the call voice is the
//     "Voice conversation" use row in #settings-uses (provider: the keys that talk, or This PC);
//   * Voice conversation starts on This PC (voice.realtime 'off'); with an OpenAI key (a local OpenAI-shaped model list stands
//     in for OpenAI) the key is offered and picking it saves routing.voice "<key id>:gpt-realtime" and voice.realtime 'auto';
//     back to This PC saves 'off'; the row never moves;
//   * a Google key without a listed Live model: picking it saves gemini-3.8-live, and the row names that key, not the first one;
//   * the speech models group names this PC's models with their actions (nothing is downloaded here);
//   * a line said live is a line of this device's call: the chat shows the call as one bubble ("Call · <time> · running",
//     open while it runs) holding the line and the answer, and with a duration once it ended;
//   * screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

/** An OpenAI-shaped model list on localhost: the key's connection check passes without the internet. */
async function fakeOpenAi() {
  const server = createServer((req, res) => {
    const ok = req.method === 'GET' && req.url === '/v1/models';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { object: 'list', data: [{ id: 'gpt-realtime', object: 'model' }] } : { error: { message: 'not here' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('Settings › Models: the Voice group, the voice conversation use saved, the key named, nothing moves', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-voice-settings-'));
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
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const current = async () => rpc.call('settings.get');
  const voice = async () => (await current()).voice;
  const until = async (check, what) => {
    for (const end = Date.now() + 15_000; Date.now() < end; await page.waitForTimeout(150)) if (await check()) return;
    assert.fail(`timed out: ${what}`);
  };

  await page.evaluate(() => { location.hash = '#/settings/models'; });
  const group = page.locator('#settings-voice');
  await group.waitFor({ timeout: 15_000 });
  const labels = (await group.locator('.set-row-label').allTextContents()).map((text) => text.trim());
  assert.deepEqual(labels.map((label) => label.replace(/ \(\d+\)$/, '')), ['Reading voice', 'Learned words'], 'the Voice group keeps only these two');

  // The call voice: the uses' Voice conversation row.
  const PROVIDER = '[role="combobox"][aria-label="Voice conversation: provider"]';
  const ROW = `#settings-uses .use-row:has(${PROVIDER})`;
  const provider = page.locator(`#settings-uses ${PROVIDER}`);
  const conversation = page.locator(ROW);
  await provider.waitFor({ timeout: 15_000 });
  await provider.scrollIntoViewIfNeeded();
  assert.equal((await voice()).realtime, 'off', 'calls use this PC by default');
  assert.match(await provider.textContent(), /This PC/);
  assert.match(await conversation.locator('.set-row-hint').textContent(), /Talking in a call/);
  // Nothing on this PC yet: the group says where they come from; nothing is downloaded from that group.
  await page.locator('#settings-speech-models .set-row-label', { hasText: 'None yet' }).waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('#settings-speech-models').getByRole('button', { name: 'Download', exact: true }).count(), 0, 'no download in the speech models group');
  await shot('voice-settings-01-light');

  // An OpenAI key: offered for the call voice; picking it saves its realtime model; nothing moves.
  const openai = await fakeOpenAi();
  t.after(() => openai.close());
  const key = await rpc.call('accounts.add', { provider: 'openai', label: 'Voice key', apiKey: 'sk-test-voice-0000000000', baseUrl: openai.url });
  const rows = [ROW, `${ROW} .set-row-hint`, '#settings-voice'];
  await expectStable(page, rows, async () => {
    await provider.click();
    await page.getByRole('option', { name: 'Voice key' }).click();
    await until(async () => (await voice()).realtime === 'auto', 'voice.realtime auto');
    await page.waitForTimeout(200);
  });
  assert.equal((await current()).routing.voice, `${key.id}:gpt-realtime`, 'routing.voice names the key and its realtime model');
  assert.match(await provider.textContent(), /Voice key/);
  assert.match(await conversation.textContent(), /gpt-realtime/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('voice-settings-03-realtime-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Back to this PC's speech.
  await expectStable(page, rows, async () => {
    await provider.click();
    await page.getByRole('option', { name: 'This PC', exact: true }).click();
    await until(async () => (await voice()).realtime === 'off', 'voice.realtime off');
    await page.waitForTimeout(200);
  });

  // A Google key beside that one: offered for Voice with Gemini Live's default. Only Google's own address makes a connection a
  // Google one, so this made-up key may meet Google's model list once; what follows does not depend on the answer.
  const gemini = await rpc.call('accounts.add', { provider: 'google', label: 'Gemini key', apiKey: 'g-test-voice-0000000000' });
  await provider.click();
  await page.getByRole('option', { name: 'Gemini key' }).click();
  await until(async () => /(^|:)gemini-3\.8-live$/.test((await current()).routing.voice ?? ''), 'routing.voice names Gemini Live');
  assert.equal(gemini.provider, 'google');
  assert.equal((await voice()).realtime, 'auto', 'picking a model turns Realtime voice on');
  await until(async () => /Gemini key/.test(await provider.textContent()), 'the row names the chosen key, not the first one');
  await shot('voice-settings-06-gemini-live');
  await provider.click();
  await page.getByRole('option', { name: 'This PC', exact: true }).click();
  await until(async () => (await voice()).realtime === 'off', 'voice.realtime off again');
  await rpc.call('accounts.remove', { id: gemini.id });
  await rpc.call('accounts.remove', { id: key.id });

  // A line said live in a chat with one agent, in the real composition: stored quiet as a call line; the fake model's answer to
  // the talker is no {say, relay}, so the agent itself answers, with a line the device reads (the talker's own line: talker.test.ts).
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const call = await rpc.call('chats.create', { title: 'Call', agentIds: [manager.id] });
  const line = await rpc.call('messages.send', { conversationId: call.id, body: 'Hello in the call', speech: { source: 'endpoint', live: true } });
  assert.equal(line.silent, true, 'a live line is stored quiet');
  assert.ok(line.meta.call, 'as a call line');
  await until(async () => (await rpc.call('messages.list', { conversationId: call.id })).some((message) => message.authorId === manager.id && message.state === 'final' && !message.silent && message.meta.call), 'the agent answers the live line');
  // The talk is one call in the chat: its bubble holds the line and the answer (open while it runs), no rows of their own.
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, call.id);
  const bubble = page.locator('.call-transcript');
  await bubble.locator('.message.human', { hasText: 'Hello in the call' }).waitFor({ timeout: 15_000 }); // the row itself, in full
  assert.equal(await bubble.count(), 1, 'one bubble for the call');
  assert.match((await bubble.locator('.call-transcript-toggle').textContent()).trim(), /^Call · .+ · running$/);
  await until(async () => (await bubble.locator('.message.agent').count()) > 0, 'the answer is a line of the call, shown as its message');
  assert.equal(await page.locator('.message-column > .message.human', { hasText: 'Hello in the call' }).count(), 0, 'the line is folded into the call, no row of its own');
  await shot('voice-settings-07-talk-in-chat');
  await rpc.call('calls.end', { callId: line.meta.call.id });
  await until(async () => /^Call · .+ · \d+:\d{2}$/.test((await bubble.locator('.call-transcript-toggle').textContent()).trim()), 'the ended call shows how long it ran');
  await page.evaluate(() => { location.hash = '#/settings/models'; });
  await group.waitFor({ timeout: 15_000 });

  for (const [width, height, name] of [[640, 480, 'voice-settings-04-640x480'], [420, 860, 'voice-settings-05-phone']]) {
    await size(width, height);
    await page.waitForTimeout(600);
    await page.evaluate(() => document.getElementById('settings-voice')?.scrollIntoView({ block: 'start' }));
    await shot(name);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${width}×${height} (${overflow}px)`);
  }

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
