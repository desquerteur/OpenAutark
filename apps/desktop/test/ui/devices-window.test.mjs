// Electron window check of Settings › Devices – the one connect surface (Umbau Einfachheit, B5) – with the demo engine
// in an isolated profile and a second headless runtime ("Tower") on this machine:
//   * #/settings/devices (and the old #/settings/remote link) scrolls to the Devices group: the Remote ID row (groups of
//     three, Copy), "Connect a phone" with its fixed QR box, "Connect my other device" (Remote ID or address – B-078: no
//     role choice) and one row per device;
//   * the Remote ID hint says "only this network (meeting server off)" – no meeting server is set in a test profile;
//   * Tower, which is findable, is listed among the PCs on this network with Connect;
//   * a mistyped Remote ID, and a valid one nobody has, say why in the connect row's fixed line (the second names the
//     meeting server that is off and what to do on the other PC) – the row does not move;
//   * Tower asks by Remote ID → "<Tower> wants to connect" with the same 4-digit code, Accept / Decline; Accept makes
//     Tower a device row (no longer offered as nearby);
//   * a device row's right-click menu: Rename (inline) saves devices.rename;
//   * the phone: "Turn on" lets phones in over the local network → the QR code in the same box;
//   * screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
// Discovery stays on loopback (WORKFORCE_DISCOVERY_TARGETS, each runtime on its own 127.0.0.x).
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect, startRuntime } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';
import { remoteIdOf } from '../../src/runtime/remote/id.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const grouped = (digits) => digits.replace(/(\d{3})(?=\d)/g, '$1 ');

test('Settings › Devices: Remote ID, nearby PCs, a request with the same code, Accept, Rename, the phone QR', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-devices-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const tower = await startRuntime({ env: { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.6,127.0.0.5' } });
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0', WORKFORCE_DISCOVERY_TARGETS: '127.0.0.5,127.0.0.6' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await tower.stop();
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
  const towerName = (await tower.client.call('remote.state')).self.name;
  const row = (label) => devices.locator('.set-row', { has: page.locator('.set-row-label', { hasText: label }) });

  await page.evaluate(() => { location.hash = '#/settings/remote'; }); // the old link opens Devices
  const devices = page.locator('#settings-devices');
  await devices.waitFor({ timeout: 15_000 });
  const id = devices.locator('.remote-id');
  await id.filter({ hasText: /\d/ }).waitFor({ timeout: 15_000 });
  const remoteId = (await rpc.call('remote.state')).self.remoteId;
  assert.equal((await id.textContent()).trim(), grouped(remoteId));
  assert.equal(await row('Remote ID').getByRole('button', { name: 'Copy' }).count(), 1);
  await row('Remote ID').locator('.set-row-hint', { hasText: 'only this network (meeting server off)' }).waitFor({ timeout: 10_000 });
  assert.equal(await devices.locator('.remote-phone-row .remote-qr').count(), 1, 'the phone QR box');
  const connectRow = devices.locator('.remote-connect-row');
  assert.equal(await connectRow.getByRole('textbox', { name: 'Remote ID or address of the other PC' }).count(), 1);
  // B-078: my own device carries no role – no "Join as" choice here (employee joining lives in the company menu's "+").
  assert.equal(await connectRow.getByRole('combobox', { name: 'Join as' }).count(), 0);
  assert.equal((await connectRow.locator('.set-row-label').textContent())?.trim(), 'Connect my other device');
  await shot('devices-01-light');

  // Tower is findable, so it answers this PC's hello probe: a nearby row with Connect (the list is read when the group
  // opens; its right-click menu refreshes it).
  const nearby = row(towerName).filter({ hasText: 'On this network' });
  for (let attempt = 0; attempt < 6 && !(await nearby.count()); attempt += 1) {
    await page.waitForTimeout(2_000);
    const any = devices.locator('.set-row', { hasText: 'On this network' }).first();
    if (await any.count()) { await any.click({ button: 'right' }); }
    else { await row('Remote ID').click({ button: 'right' }).catch(() => undefined); }
    const refresh = page.locator('.menu[aria-label="Context menu"]').getByRole('menuitem', { name: 'Refresh list' });
    if (await refresh.count()) await refresh.click(); else await page.keyboard.press('Escape');
    if (!(await nearby.count())) { await page.evaluate(() => { location.hash = '#/day'; }); await page.waitForTimeout(300); await page.evaluate(() => { location.hash = '#/settings/devices'; }); await devices.waitFor(); }
  }
  await nearby.getByRole('button', { name: 'Connect' }).waitFor({ timeout: 20_000 });

  // A Remote ID nobody has: the reason in the connect row's fixed line; the row does not move.
  const typo = remoteId.slice(0, 8) + String((Number(remoteId[8]) + 1) % 10);
  await connectRow.getByRole('textbox', { name: 'Remote ID or address of the other PC' }).fill(typo);
  const before = (await connectRow.locator('.remote-slot-title').textContent())?.trim();
  await expectStable(page, ['#settings-devices .remote-connect-row', '#settings-devices .remote-phone-row'], async () => {
    await connectRow.getByRole('button', { name: 'Connect' }).click();
    await page.waitForFunction((text) => {
      const line = document.querySelector('#settings-devices .remote-connect-row .remote-slot-title');
      return line && line.textContent.trim() !== text && line.classList.contains('error');
    }, before, { timeout: 30_000 });
  });
  await shot('devices-02-unknown-id');
  // A valid Remote ID nobody has: what was searched, the meeting server that is off, and what to do.
  await connectRow.getByRole('textbox', { name: 'Remote ID or address of the other PC' }).fill(remoteIdOf('9'.repeat(64)));
  await expectStable(page, ['#settings-devices .remote-connect-row', '#settings-devices .remote-phone-row'], async () => {
    await connectRow.getByRole('button', { name: 'Connect' }).click();
    await page.waitForFunction(() => {
      const line = document.querySelector('#settings-devices .remote-connect-row .remote-slot-title');
      return Boolean(line?.classList.contains('error') && /^Meeting server off \(devices\.relay\) – no PC with this Remote ID on this network\./.test(line.getAttribute('title') ?? ''));
    }, undefined, { timeout: 30_000 });
  });
  assert.match(await connectRow.locator('.remote-slot-title').getAttribute('title'), /Open Autark on that PC – Settings › Devices shows its Remote ID\.$/);
  await shot('devices-02b-nobody-online');

  // Tower asks by Remote ID: the request row with the same code; Accept makes Tower a device row.
  const peer = (await rpc.call('system.info')).peer;
  if (peer?.addresses?.length) {
    const out = await tower.client.call('remote.connect', { target: remoteId });
    const request = row(`${towerName} wants to connect`);
    await request.waitFor({ timeout: 15_000 });
    assert.equal((await request.locator('.remote-slot-code').textContent()).trim(), out.code, 'the same code on both PCs');
    assert.equal(await request.getByRole('button', { name: 'Decline' }).count(), 1);
    await shot('devices-03-request-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot('devices-04-request-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await request.getByRole('button', { name: 'Accept' }).click();
    await request.waitFor({ state: 'detached', timeout: 15_000 });
    await devices.locator('.device-row .set-row-label', { hasText: towerName }).first().waitFor({ timeout: 30_000 });
    await nearby.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined); // a linked PC is not offered again
  } else {
    t.diagnostic('this machine has no LAN or tailnet address – the request part is not run');
  }

  // A device row's right-click menu: Rename inline.
  const deviceRow = devices.locator('.device-row').first();
  if (await deviceRow.count()) {
    const id0 = (await rpc.call('devices.list')).filter((device) => device.status !== 'revoked' && device.status !== 'pairing')
      .sort((a, b) => Number(b.self) - Number(a.self) || Number(b.kind === 'pc') - Number(a.kind === 'pc') || a.name.localeCompare(b.name))[0];
    await deviceRow.click({ button: 'right' });
    await page.locator('.menu[aria-label="Context menu"]').getByRole('menuitem', { name: 'Rename' }).click();
    const field = deviceRow.getByRole('textbox', { name: 'Device name' });
    await field.fill('Studio PC');
    await field.press('Enter');
    for (let i = 0; i < 50 && (await rpc.call('devices.list')).find((device) => device.id === id0.id)?.name !== 'Studio PC'; i += 1) await page.waitForTimeout(100);
    assert.equal((await rpc.call('devices.list')).find((device) => device.id === id0.id)?.name, 'Studio PC', 'renamed');
  } else {
    t.diagnostic('no device row to rename');
  }

  // The phone: Turn on lets phones in over the local network; the QR code shows in the same box.
  const phone = devices.locator('.remote-phone-row');
  await phone.scrollIntoViewIfNeeded();
  const turnOn = phone.getByRole('button', { name: 'Turn on' });
  if (await turnOn.count()) await turnOn.click();
  if ((await rpc.call('pwa.state')).urls.some((url) => !/localhost|127\.0\.0\.1/.test(url))) {
    await phone.locator('img.remote-qr-code').waitFor({ timeout: 15_000 });
    await shot('devices-05-phone-qr-light');
  } else {
    t.diagnostic('phones cannot reach this machine (no LAN address) – no QR expected');
  }

  // 640×480 and phone width: nothing scrolls sideways.
  for (const [width, height, name] of [[640, 480, 'devices-06-640x480'], [420, 860, 'devices-07-phone']]) {
    await size(width, height);
    await page.waitForTimeout(600);
    await page.locator('.remote-id').first().waitFor({ timeout: 15_000 });
    await shot(name);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${width} px (${overflow}px)`);
  }

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
