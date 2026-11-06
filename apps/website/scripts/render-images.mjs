// Renders the PNG files (social card, app and browser icons) from the same
// SVG geometry and fonts the site uses. Needs Playwright's Chromium, borrowed
// from the desktop app: node scripts/render-images.mjs
import { createRequire } from 'node:module';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { wordmarkSvg, appIconSvg, markSvg, COLORS } from '../src/brand.mjs';
import { site, maker } from '../src/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, '..', 'desktop', 'package.json'));
const { chromium } = require('playwright');
const pub = join(root, 'public');
const fonts = pathToFileURL(join(pub, 'fonts')).href;
const face = (f, file, style = 'normal', w = '400') => `@font-face{font-family:'${f}';font-style:${style};font-weight:${w};src:url(${fonts}/${file}) format('woff2')}`;
const css = `${face('Geist', 'geist-normal-300_700-latin.woff2', 'normal', '300 700')}${face('Instrument Serif', 'instrument-serif-italic-400-latin.woff2', 'italic')}${face('Geist Mono', 'geist-mono-normal-400-latin.woff2')}
*{margin:0;box-sizing:border-box}html,body{background:transparent}`;

const og = `<!doctype html><html><head><style>${css}
body{width:1200px;height:630px;background:${COLORS.paper};color:${COLORS.ink};font-family:Geist;position:relative;overflow:hidden}
.top{position:absolute;left:72px;right:72px;top:60px;display:flex;justify-content:space-between;font:500 15px/1 'Geist Mono';letter-spacing:.14em;text-transform:uppercase;color:#6B6A67}
.top b{color:${COLORS.ink};font-weight:500}.top span{display:flex;gap:12px;align-items:center}.top i{width:9px;height:9px;border-radius:50%;background:${COLORS.signal}}
.word{position:absolute;left:66px;right:66px;top:118px}.word svg{width:100%;height:auto;display:block}
h1{position:absolute;left:72px;bottom:66px;font-weight:500;font-size:58px;line-height:1.02;letter-spacing:-.045em;max-width:760px}
h1 em{font-family:'Instrument Serif';font-style:italic;font-weight:400;letter-spacing:-.01em}
.side{position:absolute;right:72px;bottom:72px;text-align:right;font:500 16px/1.6 'Geist Mono';color:#6B6A67}
.side b{display:inline-block;margin-bottom:10px;padding:12px 20px;border-radius:999px;background:${COLORS.ink};color:${COLORS.paper};font:500 19px/1 Geist;letter-spacing:-.01em}
</style></head><body>
<div class="top"><span><i></i>Windows · macOS · Linux · Android · iPhone</span><span>by <b>${maker.company}</b></span></div>
<div class="word">${wordmarkSvg()}</div>
<h1>Your own AI company. <em>It doesn’t wait</em> for a prompt.</h1>
<div class="side"><b>Free for Windows</b><br>runs on your ChatGPT<br>or Claude plan</div>
</body></html>`;

const icon = (size, svg, pad = 0) => `<!doctype html><html><head><style>${css}body{width:${size}px;height:${size}px;display:grid;place-items:center}svg{width:${size - pad * 2}px;height:${size - pad * 2}px;display:block}</style></head><body>${svg}</body></html>`;

const jobs = [
  ['img/og.png', og, 1200, 630, false],
  ['img/brand/autark-app-icon-1024.png', icon(1024, appIconSvg()), 1024, 1024, true],
  ['icon-512.png', icon(512, appIconSvg()), 512, 512, true],
  ['icon-192.png', icon(192, appIconSvg()), 192, 192, true],
  ['apple-touch-icon.png', icon(180, appIconSvg({ bg: COLORS.ink }).replace('rx="228"', 'rx="0"')), 180, 180, false],
  ['favicon-32.png', icon(32, markSvg({ bg: COLORS.ink, ink: COLORS.paper, radius: 14 })), 32, 32, true],
];

const tmp = join(tmpdir(), `autark-render-${process.pid}`);
await mkdir(tmp, { recursive: true });
// Use whichever Chromium is on this PC: Playwright's own, another Playwright build, or Chrome.
const { existsSync, readdirSync } = await import('node:fs');
const pw = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const candidates = [
  ...(existsSync(pw) ? readdirSync(pw).filter((d) => d.startsWith('chromium')).map((d) => [join(pw, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'), join(pw, d, 'chrome-win64', 'chrome.exe'), join(pw, d, 'chrome-win', 'chrome.exe')]).flat() : []),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = candidates.find((p) => existsSync(p));
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [out, html, w, h, transparent] of jobs) {
    const file = join(tmp, 'p.html');
    await writeFile(file, html);
    await page.setViewportSize({ width: w, height: h });
    await page.goto(pathToFileURL(file).href);
    await page.evaluate(() => document.fonts.ready);
    const target = join(pub, out);
    await mkdir(dirname(target), { recursive: true });
    await page.screenshot({ path: target, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
    console.log('wrote', out);
  }
} finally {
  await browser.close();
  await rm(tmp, { recursive: true, force: true });
}
console.log(`done for ${site.name}`);
