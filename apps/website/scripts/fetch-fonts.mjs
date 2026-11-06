// Downloads the site fonts once so they are served from our own domain.
// No visitor ever connects to Google (GDPR). Run: node scripts/fetch-fonts.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'fonts');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const API = 'https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap';

await mkdir(out, { recursive: true });
const css = await (await fetch(API, { headers: { 'user-agent': UA } })).text();

// Keep only the latin and latin-ext blocks (Google labels them with a comment).
const blocks = css.split(/\/\*\s*([a-z-]+)\s*\*\//).slice(1);
let local = '/* Self-hosted. Geist, Geist Mono (OFL 1.1, Vercel) and Instrument Serif (OFL 1.1). */\n';
for (let i = 0; i < blocks.length; i += 2) {
  const subset = blocks[i];
  const body = blocks[i + 1];
  if (subset !== 'latin' && subset !== 'latin-ext') continue;
  const url = body.match(/url\((https:[^)]+)\)/)[1];
  const family = body.match(/font-family:\s*'([^']+)'/)[1];
  const style = body.match(/font-style:\s*(\w+)/)[1];
  const weight = body.match(/font-weight:\s*([\d ]+);/)[1].trim();
  const name = `${family.toLowerCase().replace(/\s+/g, '-')}-${style}-${weight.replace(/\s+/g, '_')}-${subset}.woff2`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  await writeFile(join(out, name), buf);
  local += `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:swap;src:url(./fonts/${name}) format('woff2');${body.match(/unicode-range:[^;]+;/)[0]}}\n`;
  console.log(name, buf.length);
}
await writeFile(join(root, 'src', 'assets', 'fonts.css'), local);
