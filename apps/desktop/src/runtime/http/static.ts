// Static UI for the PWA/browser: files from the built UI directory (app/ui) with correct MIME
// types, cache headers, ETags, the app CSP for HTML and an SPA fallback to index.html for
// navigation paths (no file extension).
// Owns: URL → file mapping with traversal protection and the cache/CSP policy of UI files.
// Never: serves files outside `root`, dotfiles, or anything authenticated (files.ts does that).

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BASE_HEADERS, sendError } from './body.ts';

/** CSP of the UI shell served over HTTP (the PWA). */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * CSP of sandbox documents (```app mini-tools, web-genui.md §3): no network, no frames, no
 * forms targets, no navigation base; `sandbox` keeps them in an opaque origin even when opened
 * top-level, so they can never read the app's storage (device token).
 */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src blob: data:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts allow-forms',
].join('; ');

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
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function mimeForPath(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a URL pathname to a file below `root`; null when it escapes the root, is malformed or
 * names a dotfile. '' and '/' map to index.html. Percent-encoding is decoded once.
 */
export function resolveUnder(root: string, pathname: string, index = 'index.html'): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded.replace(/^\/+/, '') || index;
  if (relative.split('/').some((segment) => segment.startsWith('.'))) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** esbuild content hashes: `chunks/name-ABCDEFGH.js`, `font-ABCDEFGH.woff2`. */
const HASHED = /-[A-Z0-9]{8}\.[a-z0-9]+$/;

/** Cache policy: shell files revalidate every time; content-hashed assets are immutable. */
export function cacheControlFor(relative: string): string {
  const name = relative.replace(/\\/g, '/');
  if (name === 'index.html' || name === 'sw.js') return 'no-cache';
  if (name.startsWith('chunks/') || HASHED.test(name)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/** Paths that belong to API routes and must never fall back to the SPA shell. */
const RESERVED = /^\/(?:api|rpc|ws|mcp|files|peer|sandbox|\.well-known|chunks|icons)(?:\/|$)/;

export class StaticFiles {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Serves a GET/HEAD for a UI file or the SPA shell. Always answers (404/405 included). */
  async serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'bad_request', 'Method not allowed.', { Allow: 'GET, HEAD' });
      return;
    }
    const file = resolveUnder(this.root, pathname);
    if (!file) {
      sendError(res, 404, 'not_found', 'Not found.');
      return;
    }
    if (await this.send(req, res, file)) return;
    // Navigation inside the SPA (/chats/ch_…): no extension in the last segment → index.html.
    const last = pathname.split('/').pop() ?? '';
    if (!RESERVED.test(pathname) && !last.includes('.')) {
      if (await this.send(req, res, path.join(this.root, 'index.html'))) return;
    }
    sendError(res, 404, 'not_found', 'Not found.');
  }

  /** Streams one file with its headers; false when it does not exist (nothing written). */
  private async send(req: IncomingMessage, res: ServerResponse, file: string): Promise<boolean> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return false;
    }
    if (!info.isFile()) return false;
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mimeForPath(file),
      'Cache-Control': cacheControlFor(relative),
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
    };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = relative.startsWith('sandbox/') ? SANDBOX_CSP : APP_CSP;
    if (relative === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    headers['Content-Length'] = String(info.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    try {
      await pipeline(createReadStream(file), res);
    } catch {
      res.destroy(); // client went away or the file vanished mid-stream
    }
    return true;
  }
}
