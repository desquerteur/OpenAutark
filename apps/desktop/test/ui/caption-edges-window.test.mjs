// Native caption geometry, then left/right/both/absent caption fixtures in the real renderer; with the browser open at
// its default width (and in a narrower wide window) its tab strip is its first line under the row – no room for three
// titled tabs beside the caption controls –, on a wide pane it lies in the row, clear of the caption and the frame's
// cells, and the chat's cells stay left of the pane.
// Owns: one-row headers and control clearance across desktop/compact/PWA layouts.
// Never: touches the person's profile or claims to emulate native macOS/Linux button rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('caption edges share the existing header row', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-caption-'));
  const shots = path.resolve(process.env.SCREENSHOTS ?? path.join(root, 'test-results/caption-edges'));
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close();
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const check = (name, fn) => t.test(name, async () => {
    try { await fn(); } catch (error) { console.error(error); throw error; }
  });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const agent = await rpc.call('agents.create', { name: 'Ava' });
  const chat = await rpc.call('chats.create', { title: 'Header clearance', agentIds: [agent.id] });
  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(320, 200);
      win.setContentSize(w, h);
    }, [width, height]);
    await page.waitForTimeout(150);
  };
  const geometry = async (left, right, host = 'mac') => {
    await page.evaluate(([l, r, os]) => {
      document.documentElement.dataset.os = os;
      document.documentElement.style.setProperty('--caption-left', `${l}px`);
      document.documentElement.style.setProperty('--caption-reserve', `${r}px`);
    }, [left, right, host]);
  };
  const clear = async (where, left, right) => {
    const state = await page.evaluate(([l, r]) => {
      const headers = [...document.querySelectorAll('.shell .sidebar > .frame-header, .shell .main-slot .frame-header.zone-main, .mobile-shell > .mobile-top, .mobile-shell.own-header > .mobile-main > * > .frame-header')];
      const boxes = headers.map((el) => {
        const box = el.getBoundingClientRect();
        const title = el.querySelector('.frame-header-title').getBoundingClientRect();
        return { y: box.y, height: box.height, titleWidth: title.width, titleLeft: title.left, titleRight: title.right };
      });
      const buttons = [...document.querySelectorAll('button, a[href], input, [role=separator]')].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.top >= 0 && b.top < 48 && getComputedStyle(el).visibility !== 'hidden';
      });
      const under = buttons.filter((el) => {
        const b = el.getBoundingClientRect();
        return b.left < l - 0.5 || b.right > innerWidth - r + 0.5;
      }).map((el) => ({ label: el.getAttribute('aria-label') ?? el.textContent, x: el.getBoundingClientRect().x, right: el.getBoundingClientRect().right }));
      return { boxes, under, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth };
    }, [left, right]);
    assert.ok(state.boxes.length > 0, `${where}: top header exists`);
    assert.ok(state.boxes.every((b) => b.y === 0 && b.height === 48), `${where}: one row at the top: ${JSON.stringify(state.boxes)}`);
    assert.ok(state.boxes.every((b) => b.titleWidth > 0 && b.titleLeft >= left && b.titleRight <= state.width - right), `${where}: title fits the usable row: ${JSON.stringify(state.boxes)}`);
    assert.deepEqual(state.under, [], `${where}: no control under caption edges`);
    assert.equal(state.overflow, false, `${where}: no horizontal page scroll`);
  };
  await size(1280, 800);
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.chat-header').waitFor();
  await check('actual native overlay', async () => {
    const native = await page.evaluate(() => {
      const rect = navigator.windowControlsOverlay?.getTitlebarAreaRect();
      return rect?.width ? { left: rect.x, right: innerWidth - rect.x - rect.width } : null;
    });
    assert.ok(native, 'native caption geometry is exposed');
    await clear('native', native.left, native.right);
  });
  await check('fullscreen has no caption strip or reserve', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    try {
      await page.waitForTimeout(350);
      await clear('fullscreen', 0, 0);
    } finally {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
      await size(1280, 800);
    }
  });
  const stripTop = () => page.evaluate(() => document.querySelector('.global-pane .browser-strip').getBoundingClientRect().top);
  await check('the default pane: its strip under the row; a wide pane: in the row', async () => {
    await page.locator('.frame-workspace-cell button').evaluate((el) => el.click());
    await page.locator('.global-pane .browser-strip').waitFor();
    assert.equal(await page.locator('.app-frame.strip-in-row').count(), 0, 'no room for three titled tabs beside the native caption controls');
    assert.equal(Math.round(await stripTop()), 48, 'the strip is the pane\'s first line under the row');
    // a 632 px pane in a 1440 px window: room in the row for every fixture below, and the sidebar keeps its width when
    // the pane opens (a wider pane narrows it, shell.css --sidebar-size, which would move the chat's row)
    await size(1440, 900);
    await page.getByRole('separator', { name: 'Resize workspace' }).focus();
    const saved = (width) => page.waitForFunction((want) => document.querySelector('[aria-label="Resize workspace"]')?.getAttribute('aria-valuenow') === String(want), width);
    await page.keyboard.press('Home');
    await saved(280);
    for (let width = 312; width <= 632; width += 32) { await page.keyboard.press('Shift+ArrowLeft'); await saved(width); } // each step from the saved width
    await page.locator('.app-frame.strip-in-row').waitFor();
    assert.equal(Math.round(await stripTop()), 0, 'the strip is the row\'s part above the pane');
    await page.locator('.frame-workspace-cell button').evaluate((el) => el.click());
    await page.locator('.global-pane').waitFor({ state: 'detached' });
  });
  for (const [name, left, right, host] of [
    ['left', 80, 0, 'mac'], ['right', 0, 138, 'windows'],
    ['linux-left', 150, 0, 'linux'], ['both', 80, 138, 'linux'], ['absent', 0, 0, 'mac'],
  ]) {
    await check(`${name}: columns and sidebar toggle`, async () => {
      await geometry(left, right, host);
      await clear(name, left, right);
      await expectStable(page, ['.chat-header', '.chat-header .frame-header-title', '.chat-header .frame-header-near', '.rail-header', '.frame-workspace-cell'], async () => {
        await page.locator('.frame-workspace-cell button').evaluate((el) => el.click());
        await page.locator('.global-pane').waitFor();
      });
      await clear(`${name} browser`, left, right);
      // the pane's strip is the row's part above the pane: its tabs and "+" in the row, before the frame's cells, and
      // the chat's own cells left of the pane
      await page.locator('.global-pane .browser-strip-tab').first().waitFor();
      const strip = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const parts = [...document.querySelectorAll('.global-pane .browser-strip-tab, .global-pane .browser-strip-new')].map(box);
        return {
          parts: parts.length, top: Math.min(...parts.map((b) => b.top)), bottom: Math.max(...parts.map((b) => b.bottom)), right: Math.max(...parts.map((b) => b.right)),
          cell: box(document.querySelector('.frame-workspace-cell')).left, pane: box(document.querySelector('.global-pane')).left,
          near: box(document.querySelector('.chat-header .frame-header-near')).right,
        };
      });
      assert.ok(strip.parts >= 2, `${name}: a tab and "+"`);
      assert.ok(strip.top >= 0 && strip.bottom <= 49, `${name}: they lie in the row: ${JSON.stringify(strip)}`);
      assert.ok(strip.right <= strip.cell + 0.5, `${name}: before the frame's cells: ${JSON.stringify(strip)}`);
      assert.ok(strip.near <= strip.pane + 0.5, `${name}: the chat's cells stay left of the pane: ${JSON.stringify(strip)}`);
      await page.locator('.frame-workspace-cell button').evaluate((el) => el.click());
      await page.locator('.rail-header button').click();
      await page.locator('.app-frame.sidebar-closed').waitFor();
      await clear(`${name} sidebar closed`, left, right);
      await page.screenshot({ path: path.join(shots, `${name}-columns.png`) });
      await page.locator('.rail-header button').click();
      await page.locator('.sidebar').waitFor();
    });
  }
  // a narrower wide window: the pane (about 400 px here) leaves the row no room for three titled tabs beside the caption
  // controls, so its strip is its first line under the row and nothing lies over the chat's cells (the sidebar narrows
  // for the open pane here, as before B-072, so the chat's row is not measured)
  await check('1000 px: the strip under the row, the chat\'s cells free', async () => {
    await size(1000, 700);
    await geometry(0, 138, 'windows');
    await expectStable(page, ['.frame-workspace-cell', '.rail-header'], async () => {
      await page.locator('.frame-workspace-cell button').evaluate((el) => el.click());
      await page.locator('.global-pane .browser-strip-tab').first().waitFor();
    });
    assert.equal(await page.locator('.app-frame.strip-in-row').count(), 0, 'no strip in the row');
    assert.equal(Math.round(await stripTop()), 48, 'the strip is the pane\'s first line under the row');
    const reached = await page.evaluate(() => [...document.querySelectorAll('.chat-header .frame-header-near button')].every((button) => {
      const box = button.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === button;
    }));
    assert.ok(reached, 'nothing lies over the chat\'s cells');
    await page.locator('.frame-workspace-cell button').evaluate((el) => el.click());
    await size(1280, 800);
  });
  for (const [name, left, right] of [['left', 80, 0], ['right', 0, 138]]) {
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of [[640, 480], [390, 844]]) {
        await check(`${name} ${theme} ${width}: chat, settings, search and palette`, async () => {
          await size(width, height);
          await geometry(left, right);
          await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
          await page.locator('.mobile-shell .chat-header').waitFor();
          await clear(`${name} compact chat`, left, right);
          await page.screenshot({ path: path.join(shots, `${name}-${theme}-${width}-chat.png`) });
          await page.evaluate(() => { location.hash = '#/settings'; });
          await page.locator('.mobile-top').waitFor();
          await clear(`${name} settings`, left, right);
          const search = page.locator('.mobile-top [data-cell=search] button');
          await expectStable(page, ['.mobile-top', '.mobile-top .frame-header-title'], () => search.click());
          await page.keyboard.press('Escape');
          await page.locator('dialog.palette[open]').waitFor({ state: 'hidden' });
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
          await page.locator('dialog.palette[open]').waitFor();
          await page.waitForTimeout(250); // sheet entry animation
          assert.equal((await page.locator('dialog.palette').boundingBox()).y, 48, 'palette stays below the caption row');
          await page.keyboard.press('Escape');
          await page.locator('dialog.palette[open]').waitFor({ state: 'hidden' });
          await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
          await page.locator('.chat-header').waitFor();
        });
      }
    }
  }
  await check('PWA has no caption reserve', async () => {
    await page.evaluate(() => {
      const root = document.documentElement;
      root.dataset.platform = 'pwa';
      root.style.removeProperty('--caption-left'); root.style.removeProperty('--caption-reserve');
    });
    await clear('PWA chat', 0, 0);
    await page.screenshot({ path: path.join(shots, 'pwa-chat.png') });
  });
  assert.deepEqual(errors, []);
});
