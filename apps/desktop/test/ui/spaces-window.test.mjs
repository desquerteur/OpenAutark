// Electron window check of spaces (P05 areas) with the demo engine in an isolated test profile:
//   * the seed Manager has no space; hiring the secretary and a video editor (reports of the
//     Manager) creates "Private" and "Personal brand";
//   * the Team sidebar (the org lives in ONE place – Umbau Einfachheit: no second org tree on #/team): the agents'
//     space-less group (Manager) first under "Agents", then one heading per space with the area agents under it;
//   * spaces stay system data – a rename, a new space and an archive through the RPCs show as sidebar headings, the
//     archived space's agents stay on the team (back under the Manager);
//   * screenshots light, dark and 640×480; no renderer errors.
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

test('spaces: created by hiring, Team headings; rename/add/archive through the RPCs (no Settings › Agents)', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-spaces-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('events.subscribe', { topics: ['org'] });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'seed Manager exists');
  assert.equal(manager.spaceId, undefined, 'the seed Manager has no space');
  assert.deepEqual(await rpc.call('spaces.list'), [], 'no spaces before the first area hire');

  const secretary = await rpc.call('agents.create', { template: 'secretary', name: 'Ella', managerId: manager.id });
  const editor = await rpc.call('agents.create', { template: 'video-editor', name: 'Jonas', managerId: manager.id });
  const names = (await rpc.call('spaces.list')).map((space) => space.name).sort();
  assert.deepEqual(names, ['Personal brand', 'Private']);
  assert.ok(secretary.spaceId && editor.spaceId && secretary.spaceId !== editor.spaceId);

  // The Team sidebar: the Manager's group first under 'Agents', then one heading per space.
  const groups = page.locator('.team-nav .team-space:not(.team-people):not(.team-archived)');
  const heading = (name) => page.locator('.team-nav .team-space-title', { hasText: name });
  await go('#/team');
  await heading('Private').waitFor({ timeout: 15_000 });
  await heading('Personal brand').waitFor({ timeout: 15_000 });
  assert.equal(await groups.count(), 3);
  assert.deepEqual(await groups.nth(0).locator('.team-space-title').allTextContents(), ['Agents'], 'the space-less group is headed Agents');
  assert.equal((await groups.nth(0).locator('.team-row .row-title').first().textContent())?.trim(), 'Manager');
  const expandAll = async () => { for (let i = 0; i < 5; i += 1) { const closed = page.locator('.team-nav .team-caret[aria-expanded="false"]'); if (!(await closed.count())) break; await closed.first().click(); } };
  await expandAll();
  assert.equal(await page.locator('.team-nav .team-row .row-title', { hasText: 'Ella' }).count(), 1, 'the secretary is on the team');
  assert.equal(await page.locator('.team-nav .team-row .row-title', { hasText: 'Jonas' }).count(), 1, 'the video editor is on the team');
  assert.equal(await page.locator('.team-view .org-space').count(), 0, 'no second org tree in the main zone');
  await shot('spaces-01-team-light');

  // Spaces are system data (renamed by managers through spaces.save, archived through spaces.archive).
  const brand = (await rpc.call('spaces.list')).find((space) => space.name === 'Personal brand');
  await rpc.call('spaces.save', { id: brand.id, name: 'Brand studio' });
  await rpc.waitFor('space.upserted', (space) => space.name === 'Brand studio', 15_000);
  await rpc.call('spaces.save', { name: 'Podcast', kind: 'custom' });
  await rpc.waitFor('space.upserted', (space) => space.name === 'Podcast' && space.kind === 'custom', 15_000);

  // Archive Private: the secretary stays on the team, back under the Manager.
  await rpc.call('spaces.archive', { id: secretary.spaceId });
  await rpc.waitFor('space.upserted', (space) => space.id === secretary.spaceId && Boolean(space.archivedAt), 15_000);
  const active = (await rpc.call('spaces.list')).filter((space) => !space.archivedAt).map((space) => space.name).sort();
  assert.deepEqual(active, ['Brand studio', 'Podcast']);
  const still = (await rpc.call('agents.list')).find((agent) => agent.id === secretary.id);
  assert.equal(still?.archivedAt, undefined, 'archiving a space never archives its agents');

  await heading('Brand studio').waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => ![...document.querySelectorAll('.team-nav .team-space-title')].some((el) => el.textContent.trim() === 'Private'), undefined, { timeout: 15_000 });
  await expandAll();
  await page.locator('.team-nav .team-row .row-title', { hasText: 'Ella' }).first().waitFor({ timeout: 10_000 }); // the secretary stays on the team
  await shot('spaces-04-team-after-archive-light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('spaces-05-team-dark');
  await size(640, 480);
  await shot('spaces-08-team-640x480');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
