// `GET /files/<sha256>`: streams a stored blob to an authenticated client (owner or device
// token in `Authorization: Bearer` or `?token=`), with single-range support for audio/video
// seeking, the stored MIME type and `Content-Disposition: inline`. A file whose row came from another of the
// person's PCs and whose bytes are not here yet is fetched from there first (devices/sync/blobs.ts needBlob).
// Owns: token extraction, range responses and the protective headers of user content.
// Never: serves without a valid token, lets stored HTML/SVG run in the app origin (CSP
// sandbox), or logs tokens.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { RuntimeServices } from '../contracts.ts';
import { needBlob } from '../devices/sync/blobs.ts';
import { BASE_HEADERS, sendError } from './body.ts';
import { bearerToken } from './security.ts';
import type { Authenticate, RequestInfo } from './types.ts';
import { mayReadFile, personFileView } from '../people/access.ts';

/**
 * User content may be HTML or SVG: the CSP keeps it inert and in an opaque origin, so a stored
 * page can never read the app's storage. PDFs get no sandbox (browsers refuse to render
 * sandboxed PDFs) – they cannot script the app origin anyway.
 */
export const FILE_CSP = "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; font-src data:; sandbox";

/** Parses a single-range `Range: bytes=a-b` header against a size; null = whole file. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (match[1] === '') { // suffix: the last N bytes
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

/** `inline; filename="ascii"; filename*=UTF-8''…` (RFC 6266 / 5987). */
export function inlineDisposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f"\\]/g, '_').slice(0, 200) || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

export function tokenOf(req: IncomingMessage, url: URL): string | undefined {
  return bearerToken(req.headers.authorization) ?? (url.searchParams.get('token') || undefined);
}

export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  info: RequestInfo,
  deps: { services: () => RuntimeServices; authenticate: Authenticate },
  id: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'bad_request', 'Method not allowed.', { Allow: 'GET, HEAD' });
    return;
  }
  const scope = deps.authenticate(tokenOf(req, info.url), info.loopback);
  if (!scope) {
    sendError(res, 401, 'forbidden', 'A valid token is required.', { 'WWW-Authenticate': 'Bearer' });
    return;
  }
  const files = deps.services().files;
  const ref = files.get(id);
  // F-52: a person fetches only files of messages they may read (runtime/people/access.ts).
  if (ref && scope.kind === 'person' && !mayReadFile(deps.services().db, scope.personId, id)) {
    sendError(res, 404, 'not_found', 'This file does not exist.');
    return;
  }
  if (!ref) {
    sendError(res, 404, 'not_found', 'This file does not exist.');
    return;
  }
  const file = files.path(id);
  const sizeOf = async () => { const stats = await stat(file).catch(() => undefined); return stats?.isFile() ? stats.size : undefined; };
  let size = await sizeOf();
  if (size === undefined && await needBlob(deps.services(), id).catch(() => false)) size = await sizeOf();
  if (size === undefined) {
    sendError(res, 404, 'not_found', 'The stored file is missing.');
    return;
  }
  const mime = SAFE_MIME.test(ref.mime) ? ref.mime : 'application/octet-stream';
  const etag = `"${id}"`; // content-addressed: the id is the content hash
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    'Content-Type': mime,
    // F-52: a person sees the name they know the file by, never the name it was first stored under.
    'Content-Disposition': inlineDisposition(scope.kind === 'person' ? personFileView(deps.services().db, scope.personId, ref).name : ref.name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
    ETag: etag,
  };
  if (mime.toLowerCase() !== 'application/pdf') headers['Content-Security-Policy'] = FILE_CSP;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    sendError(res, 416, 'bad_request', 'Range not satisfiable.', { 'Content-Range': `bytes */${size}` });
    return;
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
    res.writeHead(206, headers);
  } else {
    headers['Content-Length'] = String(size);
    res.writeHead(200, headers);
  }
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  try {
    await pipeline(createReadStream(file, range ? { start: range.start, end: range.end } : {}), res);
  } catch {
    res.destroy(); // client stopped reading (seek, navigation) or the blob vanished
  }
}
