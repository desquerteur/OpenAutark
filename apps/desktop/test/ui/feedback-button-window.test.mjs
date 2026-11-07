// Owns: the Electron check of B-055 Q4 – the feedback cell in the window header: one fixed frame
// cell right of the workspace cell, before the caption, at the same place in every view; a click opens the ~360 px menu
// right-aligned under it and a second click closes it, moving no neighbour (expectStable); Escape
// closes, Enter/Space toggle; the window shot is taken before the menu appears (the menu's region
// in the shot equals a capture without it, while a capture with the menu differs) and includes
// the side browser's native view; the "Screenshot" box is checked by default; Bug | Idea (AF-003, Bug first); the
// Profile menu has no Feedback item, the command palette opens the menu; the draft survives closing;
// painting a box in "Paint over" and Save creates a report whose one image is the painted JPEG
// (≤ 1600 px, the box black) and no second image; light, dark, 640×480 and phone width, where the
// cell sits before Profile. Needs a build without WORKFORCE_FEEDBACK_ORIGIN (the default build).
// Talk (press and hold) is not exercised here: it would open the PC's real microphone
// (test/unit/ui/feedback-press.test.ts and feedback-dictation.test.ts cover it).
// Never: publishes anything, opens a browser or touches the person's profile (isolated demo profile).
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

/** In the page: the share (%) of pixels inside `rect` (CSS px of the window) that differ clearly between two images. */
async function regionDiff(page, a, b, rect) {
  return page.evaluate(async ([first, second, box]) => {
    const pixels = async (url) => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = innerWidth; canvas.height = innerHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, innerWidth, innerHeight);
      return context.getImageData(Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)).data;
    };
    const [one, two] = [await pixels(first), await pixels(second)];
    let changed = 0;
    for (let i = 0; i < one.length; i += 4) {
      if (Math.max(Math.abs(one[i] - two[i]), Math.abs(one[i + 1] - two[i + 1]), Math.abs(one[i + 2] - two[i + 2])) > 24) changed += 1;
    }
    return (changed / (one.length / 4)) * 100;
  }, [a, b, rect]);
}

/** In the page: an image's size and the mean RGB inside fractional rectangles. */
async function imageFacts(page, url, regions) {
  return page.evaluate(async ([src, boxes]) => {
    const image = new Image(); image.src = src; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const mean = ([x0, y0, x1, y1]) => {
      const data = context.getImageData(Math.round(x0 * canvas.width), Math.round(y0 * canvas.height),
        Math.max(1, Math.round((x1 - x0) * canvas.width)), Math.max(1, Math.round((y1 - y0) * canvas.height))).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; }
      return sum.map((value) => Math.round(value / (data.length / 4)));
    };
    return { width: image.naturalWidth, height: image.naturalHeight, means: boxes.map(mean) };
  }, [url, regions]);
}

test('the feedback cell: one place in every view, a stable menu, the shot before the menu, painted image only', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-feedback-cell-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const site = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Pink site</title><body style="margin:0;background:#ff00c8"></body>'); });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' };
  delete env.WORKFORCE_FEEDBACK_ORIGIN; // nothing is sent: Save keeps the report on this PC
  const app = await electron.launch({ executablePath: electronPath, args: [root], cwd: root, timeout: 60_000, env });
  let rpc;
  t.after(async () => {
    rpc?.close?.(); await app.close().catch(() => undefined);
    site.closeAllConnections(); await new Promise((resolve) => site.close(resolve));
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (url) => { globalThis.__opened.push(String(url)); }; });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(320, 320);
    win.setContentSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  const hash = (value) => page.evaluate((next) => { location.hash = next; }, value);
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const cell = page.locator('.frame-feedback-cell');
  const button = cell.getByRole('button', { name: 'Feedback', exact: true });
  const menu = page.locator('.popover.feedback-menu');
  const field = menu.getByRole('textbox', { name: 'Your feedback' });

  // ---- one fixed frame cell, the same place in every view, right of the workspace cell
  const first = (await rpc.call('chats.list'))[0];
  const places = [];
  for (const where of ['#/home', '#/chats', `#/chat/${first.id}`, '#/tasks', '#/day', '#/team', '#/settings']) {
    await hash(where); await page.waitForTimeout(250); await settle();
    await button.waitFor();
    places.push({ where, box: await cell.boundingBox() });
  }
  for (const entry of places) assert.deepEqual(entry.box, places[0].box, `the cell sits at one place (${entry.where})`);
  assert.equal(await button.getAttribute('title'), 'Feedback');
  const workspace = await page.locator('.frame-workspace-cell').boundingBox();
  assert.equal(Math.round(workspace.x + workspace.width + 4), Math.round(places[0].box.x), 'right beside the workspace cell, 4 px apart');
  const headerCells = await page.locator('.main-slot .frame-header .frame-header-cells').last().boundingBox();
  assert.ok(!headerCells || headerCells.x + headerCells.width <= workspace.x + 0.5, 'the view\'s own cells end before the frame cells (their room is reserved)');
  const caption = await page.evaluate(() => navigator.windowControlsOverlay?.visible ? navigator.windowControlsOverlay.getTitlebarAreaRect().toJSON() : null);
  if (caption) assert.ok(places[0].box.x + places[0].box.width <= caption.x + caption.width, 'the cell ends before the window\'s caption controls');

  // ---- the Profile menu has no Feedback item any more
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /Settings/ }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: 'Feedback', exact: true }).count(), 0);
  await page.keyboard.press('Escape');

  // ---- a click opens the menu, a second click closes it; nothing beside it moves
  await hash('#/home'); await page.waitForTimeout(250); await settle();
  const neighbours = ['.frame-feedback-cell', '.frame-workspace-cell', '.main-slot .frame-header', '.main-slot .frame-header-title', '.rail', '.sidebar .frame-header'];
  await expectStable(page, neighbours, async () => { await button.click(); await menu.waitFor(); });
  await menu.locator('.feedback-thumb img').waitFor();
  const opened = await menu.boundingBox();
  const at = await button.boundingBox();
  assert.ok(Math.abs(opened.width - 360) <= 1, `about 360 px wide (${opened.width})`);
  assert.ok(Math.abs(opened.x + opened.width - (at.x + at.width)) <= 1, 'right-aligned with the cell');
  assert.ok(opened.y >= at.y + at.height, 'below the cell');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Your feedback', 'the field has the focus');
  assert.equal(await menu.getByRole('checkbox', { name: 'Screenshot' }).isChecked(), true, 'checked by default');
  await menu.getByText('Paint over anything private.', { exact: true }).waitFor();
  assert.deepEqual(await menu.getByRole('radiogroup', { name: 'Kind of feedback' }).getByRole('radio').allTextContents(), ['Bug', 'Idea'], 'AF-003: Bug or Idea');
  assert.equal(await menu.getByRole('radio', { name: 'Bug', exact: true }).getAttribute('aria-checked'), 'true', 'Bug by default');
  assert.equal(await menu.getByRole('button', { name: 'Save', exact: true }).count(), 1, 'sending is not set up: Save');
  assert.equal(await menu.getByRole('button', { name: 'Send', exact: true }).count(), 0);
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  await shot('feedback-menu-light');
  const taken = await menu.locator('.feedback-thumb img').getAttribute('src');
  const withMenu = await page.evaluate(() => window.workforce.capture.window());
  await expectStable(page, neighbours, async () => { await button.click(); await menu.waitFor({ state: 'detached' }); });
  await settle();
  const withoutMenu = await page.evaluate(() => window.workforce.capture.window());
  const shotDiff = await regionDiff(page, taken, withoutMenu, opened);
  const menuDiff = await regionDiff(page, withMenu, withoutMenu, opened);
  t.diagnostic(`menu region, pixels changed: shot vs no menu ${shotDiff.toFixed(2)} %, menu vs no menu ${menuDiff.toFixed(2)} %`);
  assert.ok(menuDiff > 3, 'the comparison sees a menu');
  // AF-003: the Bug | Idea row makes the menu one row taller, so its region covers more of the animated tour below
  // (0.32 % → 0.50 % on a 125 % display); the relative bound still requires the shot to be ten times closer.
  assert.ok(shotDiff < 1 && shotDiff < menuDiff / 10, 'the screenshot was taken before the menu appeared');

  // ---- Escape closes (focus back on the cell), Enter and Space toggle
  await button.click(); await menu.waitFor();
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Feedback');
  await page.keyboard.press('Enter'); await menu.waitFor();
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  await page.keyboard.press('Space'); await menu.waitFor();
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });

  // ---- the command palette opens the same menu; the draft survives closing
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('.palette-input').fill('Feedback');
  await page.locator('.palette-row', { hasText: 'Feedback' }).first().click();
  await menu.waitFor();
  await field.fill('The total is wrong here');
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  await button.click(); await menu.waitFor();
  assert.equal(await field.inputValue(), 'The total is wrong here', 'the draft survives closing');

  // ---- Paint over: Pen is the default, a Box covers a part; Save keeps only the painted image
  await menu.getByRole('button', { name: 'Paint over the screenshot' }).click();
  const paint = page.locator('dialog.paint-dialog[open]');
  const canvas = paint.locator('canvas.paint-canvas'); await canvas.waitFor();
  assert.equal(await menu.count(), 0, 'the menu steps aside while painting');
  assert.equal(await paint.getByRole('button', { name: 'Pen', exact: true }).getAttribute('aria-pressed'), 'true', 'Pen is the default');
  await paint.getByRole('button', { name: 'Box', exact: true }).click();
  const area = await canvas.boundingBox();
  await page.mouse.move(area.x + area.width * 0.1, area.y + area.height * 0.1); await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.4, area.y + area.height * 0.3, { steps: 4 }); await page.mouse.up();
  assert.equal(await paint.getByRole('button', { name: 'Undo', exact: true }).isEnabled(), true);
  await shot('feedback-paint-light');
  await paint.getByRole('button', { name: 'Done', exact: true }).click();
  await menu.waitFor();
  await page.waitForFunction(() => document.querySelector('.feedback-menu .feedback-thumb img')?.getAttribute('src')?.startsWith('data:image/jpeg'));
  await menu.getByRole('button', { name: 'Save', exact: true }).click();
  await menu.locator('.feedback-done', { hasText: 'Saved on this PC – sending is not set up.' }).waitFor();
  await shot('feedback-saved-light');
  const report = (await rpc.call('feedback.list')).find((entry) => entry.text === 'The total is wrong here');
  assert.equal(report?.status, 'local');
  assert.ok(report.screenshotFileId, 'the report has its image');
  assert.equal(report.annotationFileId, undefined, 'one image only: never the raw shot beside the painted one');
  const file = await rpc.call('files.read', { id: report.screenshotFileId });
  assert.equal(file.mime, 'image/jpeg');
  const facts = await imageFacts(page, `data:image/jpeg;base64,${file.dataBase64}`, [[0.15, 0.13, 0.35, 0.27], [0.6, 0.6, 0.9, 0.9]]);
  assert.ok(Math.max(facts.width, facts.height) <= 1600, `within 1600 px (${facts.width}×${facts.height})`);
  assert.ok(facts.means[0].every((value) => value < 24), `the painted box is black in the sent image (${facts.means[0]})`);
  assert.ok(facts.means[1].some((value) => value > 60), `the rest is the window (${facts.means[1]})`);
  await menu.getByRole('button', { name: 'Close', exact: true }).click(); await menu.waitFor({ state: 'detached' });
  await button.click(); await menu.waitFor();
  assert.equal(await field.inputValue(), '', 'a saved report leaves a fresh draft');
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });

  // ---- a noisy screenshot needs compression; its painted coverage survives inside the mailbox's image budget
  await size(1600, 1200);
  await settle();
  await page.evaluate(() => {
    const noise = document.createElement('canvas');
    noise.id = 'feedback-test-noise'; noise.width = innerWidth; noise.height = innerHeight;
    noise.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483000;pointer-events:none';
    const context = noise.getContext('2d');
    const pixels = context.createImageData(noise.width, noise.height);
    let seed = 123456789;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels.data[i] = seed & 255; pixels.data[i + 1] = (seed >>> 8) & 255;
      pixels.data[i + 2] = (seed >>> 16) & 255; pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0); document.body.append(noise);
  });
  await settle();
  await button.click(); await menu.waitFor(); await menu.locator('.feedback-thumb img').waitFor();
  await page.evaluate(() => document.getElementById('feedback-test-noise')?.remove());
  const initialBytes = await menu.locator('.feedback-thumb img').evaluate(async (thumb) => {
    const image = new Image(); image.src = thumb.src; await image.decode();
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const sample = document.createElement('canvas'); sample.width = Math.round(image.naturalWidth * scale); sample.height = Math.round(image.naturalHeight * scale);
    sample.getContext('2d').drawImage(image, 0, 0, sample.width, sample.height);
    return atob(sample.toDataURL('image/jpeg', 0.85).split(',')[1]).length;
  });
  assert.ok(initialBytes > 600_000, `fixture requires compression (${initialBytes} bytes)`);
  await field.fill('Noisy screenshot keeps its painted coverage');
  await menu.getByRole('button', { name: 'Paint over the screenshot' }).click(); await canvas.waitFor();
  await paint.getByRole('button', { name: 'Box', exact: true }).click();
  const noisyArea = await canvas.boundingBox();
  await page.mouse.move(noisyArea.x + noisyArea.width * 0.1, noisyArea.y + noisyArea.height * 0.1); await page.mouse.down();
  await page.mouse.move(noisyArea.x + noisyArea.width * 0.4, noisyArea.y + noisyArea.height * 0.3, { steps: 4 }); await page.mouse.up();
  await paint.getByRole('button', { name: 'Done', exact: true }).click(); await menu.waitFor();
  await menu.getByRole('button', { name: 'Save', exact: true }).click(); await menu.locator('.feedback-done').waitFor();
  const noisyReport = (await rpc.call('feedback.list')).find((entry) => entry.text === 'Noisy screenshot keeps its painted coverage');
  const noisyFile = await rpc.call('files.read', { id: noisyReport.screenshotFileId });
  assert.ok(Buffer.from(noisyFile.dataBase64, 'base64').length <= 600_000, 'the complete image fits the mailbox budget');
  const noisyFacts = await imageFacts(page, `data:image/jpeg;base64,${noisyFile.dataBase64}`, [[0.15, 0.13, 0.35, 0.27], [0.6, 0.6, 0.9, 0.9]]);
  assert.ok(noisyFacts.means[0].every((value) => value < 24), `paint still covers the same pixels (${noisyFacts.means[0]})`);
  assert.ok(noisyFacts.means[1].every((value) => value > 90 && value < 165), 'the rest still contains the noisy screenshot');
  await menu.getByRole('button', { name: 'Close', exact: true }).click(); await menu.waitFor({ state: 'detached' });
  await size(1280, 820); await settle();

  // ---- the side browser's native view is in the shot (composited)
  await page.locator('.frame-workspace-cell button').click();
  const newTab = page.locator('.browser-strip').getByRole('button', { name: 'New tab', exact: true });
  if (await newTab.waitFor({ timeout: 8_000 }).then(() => true, () => false)) {
    // the pane's strip lies in the row only where three titled tabs fit (B-072 strip-in-row): there its "+" ends before the
    // workspace and feedback cells; with the default pane the strip is the pane's first line under the row. Either way the
    // frame's cells keep their place.
    const plus = await newTab.boundingBox();
    const inRow = await page.locator('.app-frame.strip-in-row').count() > 0;
    if (inRow) assert.ok(plus.y + plus.height <= 48 && plus.x + plus.width <= workspace.x, `"+" in the row, before the frame's cells (${JSON.stringify(plus)})`);
    else assert.ok(plus.y >= 48, `the default pane's strip is under the row (${JSON.stringify(plus)})`);
    assert.deepEqual(await cell.boundingBox(), places[0].box, 'the feedback cell stays where it was with the browser open');
    await newTab.click();
    const address = page.locator('.browser-bar').getByRole('textbox', { name: 'Website address' });
    await address.fill(`http://127.0.0.1:${site.address().port}/`);
    await address.press('Enter');
    await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'Pink site', undefined, { timeout: 15_000 });
    await page.waitForTimeout(600); // the native view is placed on its slot
    const slot = await page.locator('.browser-native-slot').boundingBox();
    await button.click(); await menu.waitFor(); await menu.locator('.feedback-thumb img').waitFor();
    const pane = await menu.locator('.feedback-thumb img').getAttribute('src');
    await page.keyboard.press('Escape');
    const box = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const pink = await imageFacts(page, pane, [[(slot.x + slot.width * 0.4) / box.width, (slot.y + slot.height * 0.4) / box.height, (slot.x + slot.width * 0.6) / box.width, (slot.y + slot.height * 0.6) / box.height]]);
    const [r, g, b] = pink.means[0];
    assert.ok(r > 200 && g < 70 && b > 150, `the side browser's page is in the shot (${pink.means[0]})`);
    await shot('feedback-side-browser-light');
  } else {
    t.diagnostic('side browser part skipped: no "New tab" button in this build');
  }
  await page.locator('.frame-workspace-cell button').click();

  // ---- dark, 640×480 and phone width (the cell before Profile, the menu as a sheet)
  await page.emulateMedia({ colorScheme: 'dark' });
  await button.click(); await menu.waitFor(); await menu.locator('.feedback-thumb img').waitFor();
  await shot('feedback-menu-dark');
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  await page.emulateMedia({ colorScheme: 'light' });
  for (const [width, height, name] of [[640, 480, 'feedback-menu-640x480'], [390, 844, 'feedback-menu-phone']]) {
    await size(width, height);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => innerWidth), width);
    const top = page.locator('.mobile-top');
    await top.waitFor();
    const order = await top.locator('.frame-header-cells > .frame-header-cell').evaluateAll((cells) => cells.map((item) => item.getAttribute('data-cell')));
    assert.deepEqual(order.slice(-2), ['feedback', 'profile'], `the cell before Profile (${order})`);
    const phoneButton = top.getByRole('button', { name: 'Feedback', exact: true });
    await expectStable(page, ['.mobile-top [data-cell="feedback"]', '.mobile-top [data-cell="profile"]', '.mobile-top .frame-header-title'], async () => { await phoneButton.click(); await menu.waitFor(); });
    await menu.locator('.feedback-thumb img').waitFor(); // a desktop window captures in the compact layout too
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no horizontal page scroll');
    assert.equal(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, 'nothing overflows the sheet');
    await shot(name);
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  }
  assert.deepEqual(await app.evaluate(() => globalThis.__opened), [], 'nothing opens a browser');
  assert.deepEqual(errors, []);
  t.diagnostic(`screenshots: ${shots}`);
});
