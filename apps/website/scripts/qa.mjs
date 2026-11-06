// Quick quality pass over the built site served at QA_URL (default
// http://127.0.0.1:4321): console errors, horizontal overflow on a phone,
// broken internal links, one h1 per page. Optional screenshots with SHOTS=dir.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(root, '..', 'desktop', 'package.json'))('playwright');
const base = (process.env.QA_URL || 'http://127.0.0.1:4321').replace(/\/$/, '');
const pages = ['/', '/product/', '/how-it-works/', '/access/', '/compare/', '/faq/', '/download/', '/download/windows/', '/download/mac/', '/download/linux/', '/download/android/', '/download/iphone/', '/pair/#123 456 789', '/changelog/', '/about/', '/brand/', '/404.html'];
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const pw = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const exe = [...(existsSync(pw) ? readdirSync(pw).filter((d) => d.startsWith('chromium')).map((d) => join(pw, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')) : []), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const problems = [];
const links = new Set();
try {
  for (const [w, h, label] of [[375, 812, 'phone'], [1440, 900, 'desktop']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: label === 'phone' ? 'no-preference' : 'no-preference' });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/api\.github\.com|Failed to load resource/.test(m.text())) problems.push(`${label} console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`${label} js error: ${e.message}`));
    for (const p of pages) {
      await page.goto(base + p, { waitUntil: 'load' });
      await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((e) => e.classList.add('in')));
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const over = [...document.querySelectorAll('main *, header *, footer *')].filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.right > vw + 1 && !e.closest('.marquee, .table-wrap, .mnav, .hero__word, .ftr__giant');
        }).slice(0, 6).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} →${Math.round(e.getBoundingClientRect().right)}`);
        const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.href);
        return { vw, sw: document.documentElement.scrollWidth, over, h1: document.querySelectorAll('h1').length, hrefs, title: document.title };
      });
      if (r.over.length) problems.push(`${label} ${p} overflow (${r.sw}>${r.vw}): ${r.over.join(', ')}`);
      if (r.h1 !== 1) problems.push(`${label} ${p} has ${r.h1} h1`);
      r.hrefs.forEach((u) => links.add(u));
      if (shots && label === 'phone') await page.screenshot({ path: join(shots, `${p.replace(/\W+/g, '_') || 'home'}.png`), fullPage: true });
      console.log(label, p, '·', r.title);
    }
    await ctx.close();
  }
  // internal links (same origin, ignore #anchors and stable download redirects)
  for (const u of links) {
    if (!u.startsWith(base)) continue;
    const url = u.split('#')[0];
    if (/\/(get\/[a-z-]+|download\/checksums)\/?$/.test(url)) continue;
    const path = decodeURIComponent(new URL(url).pathname);
    const file = join(root, 'dist', path.endsWith('/') ? join(path, 'index.html') : path);
    if (!existsSync(file)) problems.push(`broken link: ${url}`);
  }
  // anchors on the same page
} finally {
  await browser.close();
}
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nno problems');
