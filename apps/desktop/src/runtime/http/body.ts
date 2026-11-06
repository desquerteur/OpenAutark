// Request bodies and JSON responses of the runtime HTTP server.
// Owns: size-limited body reading (413 before buffering too much), JSON parsing (400), the
// common security headers and safe JSON error replies.
// Never: stack traces, raw exception text or secrets in responses; CORS headers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorCode } from '../../shared/errors.ts';

/** An error that maps to an HTTP status and a safe message. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** Headers sent with every response. */
export const BASE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Reads the whole body; rejects with HttpError(413) as soon as it exceeds `limit` bytes. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'bad_request', 'Request body too large.'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        finish(new HttpError(413, 'bad_request', 'Request body too large.'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new HttpError(400, 'bad_request', 'Request body could not be read.'));
    const onAborted = () => finish(new HttpError(400, 'cancelled', 'Request aborted.'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/** Reads and parses a JSON body (HttpError 400 for invalid JSON, 413 when too large). */
export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const raw = await readBody(req, limit);
  if (raw.length === 0) throw new HttpError(400, 'bad_request', 'Request body is empty.');
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body is not valid JSON.');
  }
}

/** Writes a JSON response (no-op when the response already started). */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  let text: string;
  try {
    text = JSON.stringify(body ?? null);
  } catch {
    status = 500;
    text = JSON.stringify({ error: { code: 'internal', message: 'Response could not be encoded.' } });
  }
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

/** JSON error body `{ error: { code, message } }`. */
export function sendError(res: ServerResponse, status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } }, headers);
}

/**
 * Replies to an oversized/invalid body and closes the connection afterwards, so the rest of
 * a huge upload is never read.
 */
export function sendBodyError(req: IncomingMessage, res: ServerResponse, error: HttpError, json: (error: HttpError) => unknown = defaultBodyError): void {
  if (error.status === 413) {
    res.once('finish', () => req.socket.destroy());
    sendJson(res, 413, json(error), { Connection: 'close' });
    return;
  }
  sendJson(res, error.status, json(error));
}

function defaultBodyError(error: HttpError): unknown {
  return { error: { code: error.code, message: error.message } };
}
