// Pure rules for the custom protocols app://, wf-sandbox:// and wf-file://.
// Owns: CSP strings, URL → file mapping with traversal protection, blob id validation,
// MIME guessing, HTTP Range parsing and the sandbox document wrapper of ```app blocks.
// Never: touches Electron or the filesystem (handlers.ts does that), so it is unit-tested.

import path from 'node:path';

/** CSP of the app shell (desktop window). Generative UI never relaxes it; it lives in wf-sandbox frames. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: wf-file:",
  "media-src 'self' blob: wf-file:",
  "connect-src 'self'",
  'frame-src wf-sandbox:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** CSP of ```app mini-tools (web-genui.md §3): no network, no frames, no forms, no navigation. */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' wf-sandbox:",
  "style-src 'unsafe-inline' wf-sandbox:",
  'img-src data: blob:',
  'media-src blob: data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** CSP of a view in <data>/pages: open, it may load and fetch what it likes; its opaque origin keeps it out of the app itself. */
export const PAGE_CSP = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval' wf-sandbox:; form-action *; base-uri *";

export const SANDBOX_LIB = 'wf-sandbox://lib/wf.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function mimeForPath(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a URL pathname to a file below `root`; null when it escapes the root or is malformed.
 * '' and '/' map to index.html. Percent-encoding is decoded once.
 */
export function resolveUnder(root: string, pathname: string, index = 'index.html'): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded.replace(/^\/+/, '') || index;
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

export type AppRoute = { kind: 'ui'; pathname: string };

/** app://app/<path> → the shipped UI. */
export function routeAppUrl(url: string): AppRoute | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'app:' || parsed.host !== 'app') return null;
  return { kind: 'ui', pathname: parsed.pathname };
}

export type SandboxRoute =
  | { kind: 'lib'; file: string }
  | { kind: 'app'; messageId: string; blockIndex: number }
  | { kind: 'page'; name: string };

/** wf-sandbox://lib/<file> → shipped sandbox runtime; wf-sandbox://app/<messageId>/<n> → app block; wf-sandbox://page/<name> → a view in <data>/pages. */
export function routeSandboxUrl(url: string): SandboxRoute | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'wf-sandbox:') return null;
  if (parsed.host === 'lib') {
    const file = parsed.pathname.replace(/^\/+/, '');
    return /^[a-z0-9_-]+\.js$/.test(file) ? { kind: 'lib', file } : null;
  }
  if (parsed.host === 'app') {
    const match = /^\/([a-z]{2,4}_[0-9a-z]{10,40})\/(\d{1,4})\/?$/.exec(parsed.pathname);
    if (!match) return null;
    return { kind: 'app', messageId: match[1], blockIndex: Number(match[2]) };
  }
  if (parsed.host === 'page') {
    let name: string;
    try { name = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')); } catch { return null; }
    return name && !/[/\\\0]/.test(name) ? { kind: 'page', name } : null;
  }
  return null;
}

/** wf-file://<sha256> → validated lowercase hex id, else null. */
export function parseBlobUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'wf-file:') return null;
  const id = (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  return isBlobId(id) ? id : null;
}

export function isBlobId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Content-addressed layout shared with the runtime: <blobs>/ab/cd/<sha256>. */
export function blobPath(blobsDir: string, id: string): string {
  return path.join(blobsDir, id.slice(0, 2), id.slice(2, 4), id);
}

/** Guesses a blob's MIME type from its first bytes (the metadata lives in the runtime DB). */
export function sniffMime(head: Uint8Array): string {
  const at = (offset: number, ...bytes: number[]) => bytes.every((byte, i) => head[offset + i] === byte);
  const ascii = (offset: number, text: string) => at(offset, ...Array.from(text, ch => ch.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm'; // EBML (webm/mkv; audio-only webm plays too)
  if (ascii(4, 'ftyp')) return ascii(8, 'M4A ') ? 'audio/mp4' : 'video/mp4';
  if (ascii(0, 'ID3') || at(0, 0xff, 0xfb)) return 'audio/mpeg';
  if (ascii(0, '<svg') || ascii(0, '<?xml')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** Parses a single-range `Range: bytes=a-b` header against a file size; null = serve whole file. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (match[1] === '') { // suffix: last N bytes
    const length = Number(match[2]);
    if (length === 0) return 'invalid';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

/**
 * Wraps the HTML of an ```app block into a sandbox document that loads wf.js first.
 * A full document gets the script injected right after <head> (or <html>); a fragment is wrapped.
 */
export function wrapSandboxHtml(html: string): string {
  const script = `<script src="${SANDBOX_LIB}"></script>`;
  const meta = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  if (/^\s*(<!doctype[^>]*>\s*)?<html[\s>]/i.test(html)) {
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, match => `${match}${meta}${script}`);
    return html.replace(/<html[^>]*>/i, match => `${match}<head>${meta}${script}</head>`);
  }
  return `<!doctype html><html><head>${meta}${script}</head><body>${html}</body></html>`;
}
