// Owns: the iPhone web app's own document (B-078 follow-up), served at config.mjs appUrl – an origin of its own, never
// the site's (build.mjs writes it there and refuses a shared origin) – with no site frame: the standalone metas, the
// manifest (id, start_url and scope = the app's folder), `<div id="app">` for the PC's UI, the shell's frame styles
// (light and dark, safe-area insets, one centred card that scrolls when the screen is short) and shell.js with its SRI
// hash. Every shell style sits on `.hs` and its own `--hs-*` tokens, so once the PC's UI mounted, its theme alone colours
// the page (html/body, overscroll). The shell (generated into src/app/ from apps/desktop/src/ui/hosted) pairs with the
// person's PC by Remote ID and then shows that PC's own interface.
// Never: content of its own beyond the shell screens, analytics or third-party scripts. Not in the sitemap.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { site, appUrl, appRelay } from '../config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/** The app's folder on its own origin, e.g. '/app/'. */
export const APP = new URL(`${appUrl}/`).pathname;
const LIGHT = '#F2F0EB';
const DARK = '#0A0A0B';

function integrity() {
  try { return `sha384-${createHash('sha384').update(readFileSync(join(here, '..', 'app', 'shell.js'))).digest('base64')}`; } catch { return ''; }
}

const CSS = `
html,body{margin:0;-webkit-text-size-adjust:100%}
.hs{--hs-bg:${LIGHT};--hs-card:#FFFFFF;--hs-ink:#0B0B0C;--hs-ink-2:#34343A;--hs-ink-3:#6B6A67;--hs-line:#DEDAD1;--hs-accent:#FF4F00;color-scheme:light}
@media (prefers-color-scheme:dark){.hs{--hs-bg:${DARK};--hs-card:#151517;--hs-ink:#F2F0EB;--hs-ink-2:#D6D3CC;--hs-ink-3:#9A978F;--hs-line:#2A2A2E;color-scheme:dark}}
.hs{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:var(--hs-bg);color:var(--hs-ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));box-sizing:border-box}
.hs[hidden]{display:none}
.hs-card{width:100%;max-width:400px;min-height:min(440px,100%);margin:auto;display:flex;flex-direction:column;gap:14px;box-sizing:border-box;padding:24px;border:1px solid var(--hs-line);border-radius:20px;background:var(--hs-card)}
.hs-brand{font-weight:600;letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:var(--hs-ink-3)}
.hs-brand::after{content:"";display:inline-block;width:6px;height:6px;margin-left:6px;border-radius:50%;background:var(--hs-accent);vertical-align:middle}
.hs-title{margin:0;font-size:24px;line-height:1.2;letter-spacing:-.01em}
.hs-body{flex:1;display:flex;flex-direction:column;gap:12px}
.hs-muted,.hs-note{margin:0;color:var(--hs-ink-3)}
.hs-note{font-size:13px;border-top:1px solid var(--hs-line);padding-top:12px}
.hs-status{margin:0;min-height:2.9em;line-height:1.45;color:var(--hs-ink-2);font-size:14px}
.hs-steps{margin:0;padding-left:1.3em;display:flex;flex-direction:column;gap:8px}
.hs-input{width:100%;box-sizing:border-box;padding:12px 14px;font:600 24px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-align:center;border:1px solid var(--hs-line);border-radius:12px;background:var(--hs-bg);color:var(--hs-ink)}
.hs-input:focus{outline:2px solid var(--hs-accent);outline-offset:1px}
.hs-actions{display:flex;gap:10px;flex-wrap:wrap;min-height:44px}
.hs-button{flex:1 1 0;min-width:120px;min-height:44px;padding:10px 16px;font-family:inherit;font-size:16px;font-weight:600;line-height:1;border-radius:12px;border:1px solid var(--hs-ink);cursor:pointer}
.hs-button[hidden]{display:none}
.hs-primary{background:var(--hs-ink);color:var(--hs-bg)}
.hs-primary:disabled{opacity:.4;cursor:default}
.hs-ghost{background:transparent;color:var(--hs-ink);border-color:var(--hs-line)}
.hs-code{font:700 56px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-align:center;padding:18px 0}
.hs-spinner{width:28px;height:28px;margin:24px auto;border-radius:50%;border:3px solid var(--hs-line);border-top-color:var(--hs-accent);animation:hs-spin 1s linear infinite}
@keyframes hs-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.hs-spinner{animation:none}}
`;

export default function app() {
  const sri = integrity();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${LIGHT}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${DARK}" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${site.name}">
<meta name="referrer" content="no-referrer">
<meta name="autark-relay" content="${appRelay.replace(/"/g, '')}">
<title>${site.name}</title>
<link rel="manifest" href="${APP}app.webmanifest">
<link rel="icon" href="${APP}app-icon.png">
<link rel="apple-touch-icon" href="${APP}app-icon.png">
<style>${CSS.trim()}</style>
<script type="module" src="${APP}shell.js"${sri ? ` integrity="${sri}"` : ''}></script>
</head>
<body>
<div id="app"></div>
<noscript><p style="padding:24px">${site.name} on iPhone needs JavaScript.</p></noscript>
</body>
</html>
`;
}

// The manifest next to the page (paths relative to the app's folder): one app per folder, opened standalone from the
// Home Screen; theme and background are the same light colour the splash and the shell start with.
export function extra() {
  return {
    'app.webmanifest': JSON.stringify({
      id: APP, name: site.name, short_name: site.name, description: `${site.name} on iPhone: your company from your own PC.`,
      start_url: APP, scope: APP, display: 'standalone', background_color: LIGHT, theme_color: LIGHT,
      icons: [{ src: `${APP}app-icon.png`, sizes: '180x180', type: 'image/png' }, { src: `${APP}app-icon-512.png`, sizes: '512x512', type: 'image/png' }],
    }, null, 2),
  };
}
