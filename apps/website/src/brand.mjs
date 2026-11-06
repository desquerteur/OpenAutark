// Logo files, generated from one geometry so they never drift apart.
// The A is drawn as the mark (Λ + dot); U, T, R, K are Geist Medium outlines
// (SIL Open Font License), stored in data/glyphs.json.
import { readFileSync } from 'node:fs';
import { MARK_PATH, MARK_DOT } from './icons.mjs';

const G = JSON.parse(readFileSync(new URL('./data/glyphs.json', import.meta.url), 'utf8'));
export const COLORS = { ink: '#0B0B0C', paper: '#F2F0EB', signal: '#FF4F00', night: '#07080B' };

const CAP = G.cap; // 710 units
const S = CAP / 38; // mark Λ is 38 units tall (y 12..50)
const LAMBDA_W = 40 * S;
const SIDE = 22; // side bearing around the Λ
const TRACK = 70; // letter spacing in font units

function lambda(x, ink, dot) {
  return `<g transform="translate(${(x + SIDE).toFixed(1)} 0) scale(${S.toFixed(4)}) translate(-12 -50)"><path d="${MARK_PATH}" fill="${ink}"/><circle cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="${MARK_DOT.r}" fill="${dot}"/></g>`;
}

export function wordmarkSvg({ ink = COLORS.ink, firstDot = COLORS.signal, title = 'Autark' } = {}) {
  let x = 0; const parts = [];
  ['A', 'U', 'T', 'A', 'R', 'K'].forEach((ch, i) => {
    if (ch === 'A') { parts.push(lambda(x, ink, i === 0 ? firstDot : ink)); x += LAMBDA_W + SIDE * 2; }
    else { const g = G.glyphs[ch]; parts.push(`<path transform="translate(${x.toFixed(1)} 0)" d="${g.d}" fill="${ink}"/>`); x += g.adv; }
    x += TRACK;
  });
  const w = Math.round(x - TRACK - G.glyphs.K.adv + G.glyphs.K.x2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -760 ${w + 20} 800" role="img" aria-label="${title}"><title>${title}</title>${parts.join('')}</svg>`;
}

export function markSvg({ ink = COLORS.ink, dot = COLORS.signal, bg = null, radius = 14, title = 'Autark' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${title}"><title>${title}</title>${bg ? `<rect width="64" height="64" rx="${radius}" fill="${bg}"/>` : ''}<path d="${MARK_PATH}" fill="${ink}"/><circle cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="${MARK_DOT.r}" fill="${dot}"/></svg>`;
}

// App icon: a little more breathing room than the plain mark.
export function appIconSvg({ bg = COLORS.ink, ink = COLORS.paper, dot = COLORS.signal } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Autark"><title>Autark</title><rect width="1024" height="1024" rx="228" fill="${bg}"/><g transform="translate(512 548) scale(11.2) translate(-32 -31)"><path d="${MARK_PATH}" fill="${ink}"/><circle cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="${MARK_DOT.r}" fill="${dot}"/></g></svg>`;
}

export function brandFiles() {
  return {
    'img/brand/autark-mark.svg': markSvg(),
    'img/brand/autark-mark-light.svg': markSvg({ ink: COLORS.paper }),
    'img/brand/autark-app-icon.svg': appIconSvg(),
    'img/brand/autark-wordmark.svg': wordmarkSvg(),
    'img/brand/autark-wordmark-light.svg': wordmarkSvg({ ink: COLORS.paper }),
  };
}
