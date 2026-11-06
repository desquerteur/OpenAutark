// protocol.handle implementations for app://, wf-sandbox:// and wf-file://.
//   app://app/<path>          shipped UI (app/ui)
//   wf-sandbox://lib/<x>.js   sandbox helpers · wf-sandbox://app/<messageId>/<n> → ```app document · wf-sandbox://page/<name> → a view in <data>/pages
//   wf-file://<sha256>        blob store file, streamed, with single-range support (media seeking)
// Owns: turning a Request into a Response with the right headers (CSP, MIME, ranges).
// Never: decides URL → file mapping or CSP itself (rules.ts does), reads outside its
// roots, imports electron (index.ts registers the handlers), buffers whole blobs in memory.

import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { isErrorCode } from '../../shared/errors.ts';
import {
  APP_CSP, PAGE_CSP, SANDBOX_CSP, blobPath, mimeForPath, parseBlobUrl, parseRange, resolveUnder, routeAppUrl, routeSandboxUrl, sniffMime, wrapSandboxHtml,
} from './rules.ts';

/** Electron CustomScheme entries (structural: this module stays electron-free). Register before ready. */
export const PRIVILEGED_SCHEMES = [
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
  { scheme: 'wf-sandbox', privileges: { standard: true, secure: true } },
  { scheme: 'wf-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
];

export interface ProtocolDeps {
  uiDir: string; // <root>/app/ui
  sandboxLibDir: string; // <root>/app/ui/sandbox
  blobsDir: string; // <userData>/blobs
  /** Raw HTML of an ```app fence (RpcClient `blocks.appHtml`). */
  appHtml(messageId: string, blockIndex: number): Promise<string>;
  /** The document of a view in <data>/pages (RpcClient `pages.read`). */
  pageHtml(name: string): Promise<string>;
}

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff' };
/** Blobs are shown by the app page only; as a document they would get nothing. */
const FILE_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";
/** An SVG opened as a document must not run script in the app origin (an <img> ignores this). */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
const SNIFF_BYTES = 64;

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}

function method(request: Request): 'GET' | 'HEAD' | null {
  return request.method === 'GET' || request.method === 'HEAD' ? request.method : null;
}

/** Whole-file read for small shipped files (UI assets); null when missing. */
async function readSmall(file: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try { return await readFile(file); } catch { return null; }
}

async function regularFile(file: string): Promise<{ size: number } | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? { size: info.size } : null;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && isErrorCode(code) ? code : 'internal';
}

function toWeb(file: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const stream = createReadStream(file, range ? { start: range.start, end: range.end } : {});
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

export class ProtocolHandlers {
  private readonly deps: ProtocolDeps;

  constructor(deps: ProtocolDeps) {
    this.deps = deps;
  }

  /** app:// – UI files. HTML documents get the app CSP. */
  async app(request: Request): Promise<Response> {
    const verb = method(request);
    if (!verb) return plain(405, 'Method not allowed.');
    const route = routeAppUrl(request.url);
    if (!route) return plain(404, 'Not found.');
    const file = resolveUnder(this.deps.uiDir, route.pathname);
    const body = file ? await readSmall(file) : null;
    if (!file || !body) return plain(404, 'Not found.');
    const mime = mimeForPath(file);
    const headers: Record<string, string> = { ...BASE_HEADERS, 'Content-Type': mime, 'Cache-Control': 'no-cache', 'Content-Length': String(body.byteLength) };
    if (mime.startsWith('text/html')) headers['Content-Security-Policy'] = APP_CSP;
    else if (mime.startsWith('image/svg+xml')) headers['Content-Security-Policy'] = SVG_CSP;
    return new Response(verb === 'HEAD' ? null : body, { status: 200, headers });
  }

  /** wf-sandbox:// – a helper script or one ```app block as a sandboxed document. */
  async sandbox(request: Request): Promise<Response> {
    const verb = method(request);
    if (!verb) return plain(405, 'Method not allowed.');
    const route = routeSandboxUrl(request.url);
    if (!route) return plain(404, 'Not found.');
    if (route.kind === 'lib') {
      const file = resolveUnder(this.deps.sandboxLibDir, route.file);
      const body = file ? await readSmall(file) : null;
      if (!file || !body) return plain(404, 'Not found.');
      return new Response(verb === 'HEAD' ? null : body, {
        status: 200,
        headers: { ...BASE_HEADERS, 'Content-Type': mimeForPath(file), 'Cache-Control': 'no-cache', 'Content-Length': String(body.byteLength) },
      });
    }
    let html: string;
    try {
      html = await (route.kind === 'page' ? this.deps.pageHtml(route.name) : this.deps.appHtml(route.messageId, route.blockIndex));
    } catch (error) {
      const code = errorCode(error);
      if (code === 'not_found' || code === 'bad_request') return plain(404, 'This app is not available.');
      return plain(503, 'The runtime is not available.');
    }
    const document = wrapSandboxHtml(html);
    return new Response(verb === 'HEAD' ? null : document, {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        // `sandbox` in the header keeps the document in an opaque origin even outside our iframe.
        'Content-Security-Policy': `${route.kind === 'page' ? PAGE_CSP : SANDBOX_CSP}; sandbox allow-scripts allow-forms`,
        'Cache-Control': 'no-store',
      },
    });
  }

  /** wf-file:// – a blob, streamed; `Range: bytes=a-b` answers 206 so audio/video can seek. */
  async file(request: Request): Promise<Response> {
    const verb = method(request);
    if (!verb) return plain(405, 'Method not allowed.');
    const id = parseBlobUrl(request.url);
    if (!id) return plain(400, 'Invalid file reference.');
    const file = blobPath(this.deps.blobsDir, id);
    const info = await regularFile(file);
    if (!info) return plain(404, 'Not found.');
    const mime = await this.sniff(file);
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable', // content-addressed: never changes
      'Content-Security-Policy': FILE_CSP,
    };
    const range = parseRange(request.headers.get('range'), info.size);
    if (range === 'invalid') return plain(416, 'Range not satisfiable.', { 'Content-Range': `bytes */${info.size}` });
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      return new Response(verb === 'HEAD' ? null : toWeb(file, range), { status: 206, headers });
    }
    headers['Content-Length'] = String(info.size);
    return new Response(verb === 'HEAD' || info.size === 0 ? null : toWeb(file), { status: 200, headers });
  }

  private async sniff(file: string): Promise<string> {
    try {
      const handle = await open(file, 'r');
      try {
        const head = new Uint8Array(SNIFF_BYTES);
        const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
        return sniffMime(head.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    } catch {
      return 'application/octet-stream';
    }
  }
}

/** The subset of Electron's `protocol` used for registration. */
export interface ProtocolLike {
  handle(scheme: string, handler: (request: Request) => Promise<Response>): void;
}

export function registerProtocolHandlers(protocol: ProtocolLike, handlers: ProtocolHandlers): void {
  protocol.handle('app', request => handlers.app(request));
  protocol.handle('wf-sandbox', request => handlers.sandbox(request));
  protocol.handle('wf-file', request => handlers.file(request));
}
