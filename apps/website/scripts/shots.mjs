// Viewport screenshots at chosen scroll points, for visual review.
// node scripts/shots.mjs <outDir> <width>x<height> <path>@<y|sel>[,<y|sel>...] ...
// y = pixels, or a CSS selector to scroll to (top of element minus 80px).
import { createRequire } from 'node:module';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(root, '..', 'desktop', 'package.json'))('playwright');
const [out, size, ...specs] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
mkdirSync(out, { recursive: true });
const pw = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const exe = [...(existsSync(pw) ? readdirSync(pw).filter((d) => d.startsWith('chromium')).map((d) => join(pw, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')) : [])].find((p) => existsSync(p));
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: w, height: h } });
for (const spec of specs) {
  const [path, points = '0'] = spec.split('@');
  await page.goto(`http://127.0.0.1:4321${path}`, { waitUntil: 'load' });
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
  let i = 0;
  for (const pt of points.split(',')) {
    await page.evaluate((p) => {
      const y = /^\d+$/.test(p) ? Number(p) : (document.querySelector(p)?.getBoundingClientRect().top ?? 0) + scrollY - 80;
      window.scrollTo(0, y);
    }, pt);
    await page.waitForTimeout(1800);
    await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((e) => e.classList.add('in')));
    await page.waitForTimeout(900);
    const name = `${w}_${path.replace(/\W+/g, '_')}_${i++}.png`;
    await page.screenshot({ path: join(out, name) });
    console.log(name);
  }
}
await browser.close();
