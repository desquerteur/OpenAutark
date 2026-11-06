// The phone view of agent files (MM2) in a real mobile-emulated browser against the headless
// runtime (demo engine, temp profile and temp home – its workspace is the --fake default <data>/workspace):
// the Manager answers with a media block and a file block naming workspace files; on the PWA
// (390 px) the image shows from its stored fileId, the file row shows its name and Download –
// never the PC's path – and Download hands over the stored bytes.
// Uses an installed Chrome or Edge through playwright-core and skips with a message when
// neither exists – it never downloads a browser.
// Owns: this flow. Never: prints the pairing secret or the device token, touches real data.
// Run: npm run build && node --test test/e2e/pwa-agent-files.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { detectChannel } from '../../src/runtime/browser/channel.ts';
import { startRuntime } from './lib/runtime-client.mjs';

function installedChannel() {
  try { return detectChannel(); } catch { return undefined; }
}
const channel = process.env.WORKFORCE_PWA_CHANNEL || installedChannel();

/** A tiny valid PNG header (IHDR 4×3) – enough for type sniffing and the image size. */
function png() {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(4, 16);
  bytes.writeUInt32BE(3, 20);
  bytes[24] = 8; bytes[25] = 6;
  return bytes;
}

test('PWA at phone width: agent media shows by fileId, the file row offers Download and no path', {
  timeout: 240_000,
  skip: channel ? false : 'No installed Google Chrome or Microsoft Edge was found – this test uses an installed browser and never downloads one.',
}, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-'));
  const home = path.join(dataDir, 'home');
  const workspace = path.join(dataDir, 'workspace'); // the --fake default (src/runtime/cli.ts), not ~/Workforce
  await mkdir(path.join(workspace, 'out'), { recursive: true });
  await writeFile(path.join(workspace, 'out', 'chart.png'), png());
  await writeFile(path.join(workspace, 'out', 'report.txt'), 'Quarterly report');
  const runtime = await startRuntime({ dataDir, env: { HOME: home, USERPROFILE: home } });
  let browser;
  t.after(async () => {
    await browser?.close().catch(() => undefined);
    await runtime.stop();
  });

  const owner = runtime.client;
  await owner.call('pwa.enable', { enabled: true, bind: 'lan' }); // B-075: no link while only this PC's loopback answers
  const manager = (await owner.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await owner.call('chats.create', { title: 'Deliverables on the phone', agentIds: [manager.id] });
  await owner.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  await owner.call('messages.send', {
    conversationId: chat.id,
    body: 'Show [[ui:{"type":"media","src":"out/chart.png","caption":"Chart"}]] and [[ui:{"type":"file","path":"out/report.txt","label":"Report"}]]',
  });
  const reply = await owner.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id
    && message.state === 'final' && message.body.includes('report.txt'), 90_000); // the file path becomes absolute (backslashes on Windows)
  assert.equal((reply.body.match(/"fileId":"[a-f0-9]{64}"/g) ?? []).length, 2, 'both blocks carry a stored file id');
  const link = await owner.call('pwa.link', { name: 'Files phone' });

  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`http://localhost:${runtime.port}/${new URL(link.url).hash}`); // localhost: a secure context, as over adb reverse
  await page.locator('.mobile-shell').waitFor({ timeout: 60_000 });
  await page.locator('.tab-bar .tab', { hasText: 'Chats' }).tap();
  await page.locator('.chat-row-open', { hasText: 'Deliverables on the phone' }).tap();
  const message = page.locator(`article.message.agent[data-message-id="${reply.id}"]`);
  await message.waitFor({ timeout: 30_000 });

  // The image is shown from the stored file (a blob: URL), not from the PC path.
  const image = message.locator('img.b-media-img');
  await image.waitFor({ timeout: 30_000 });
  assert.match(await image.getAttribute('src') ?? '', /^blob:/);

  // The file row: its name and Download, never the workspace path.
  const row = message.locator('.b-file');
  await row.waitFor();
  const text = await row.innerText();
  assert.ok(text.includes('Report'), text);
  assert.ok(!text.includes(workspace) && !text.includes('out/report.txt') && !text.includes('out\\report.txt'), `no path on the phone: ${text}`);
  assert.equal(await row.locator('button', { hasText: 'Open' }).count(), 0, 'no desktop Open on the phone');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), row.locator('button', { hasText: 'Download' }).tap()]);
  assert.equal(download.suggestedFilename(), 'report.txt');
  const saved = await download.path();
  assert.equal(await readFile(saved, 'utf8'), 'Quarterly report', 'Download hands over the stored bytes');
});
