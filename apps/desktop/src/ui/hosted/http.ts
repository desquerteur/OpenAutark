// HTTP/1.1 over one stream to the PC's runtime port (B-078 follow-up): what the iPhone web app's service worker asks for
// (the PC's UI files, /rpc, /files with Range, the sandbox frames) goes out as one request per stream with
// `Host: 127.0.0.1`, `Connection: close`, no Origin (allowsOrigin(undefined)) and no Accept-Encoding (identity bodies);
// the answer is parsed as it streams in – Content-Length, chunked, or read until the stream ends; 1xx-less, 204, 304 and
// HEAD answers carry no body. Hop-by-hop headers are dropped both ways. A request waits for one of the mux's HTTP slots.
// Owns: request heads and response parsing. Never: caching (the service worker does it) or the stream protocol.

import { concat, fromLatin1, latin1, type Bytes } from './bytes.ts';
import type { StreamMux } from './streams.ts';

export interface HttpRequest { method: string; path: string; headers?: Array<[string, string]>; body?: Bytes }
export interface HttpHead { status: number; statusText: string; headers: Array<[string, string]> }
export interface HttpSink { head(head: HttpHead): void; data(bytes: Bytes): void; end(): void; fail(error: Error): void }

/** Never forwarded: hop-by-hop, or set here for the PC (Host, Connection, length) or kept from it (Origin, cookies, encoding). */
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length',
  'accept-encoding', 'origin', 'cookie', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'set-cookie']);
const MAX_HEAD = 64 * 1024;

export function requestHead(request: HttpRequest): Bytes {
  const lines = [`${request.method} ${request.path} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: close'];
  for (const [name, value] of request.headers ?? []) {
    if (DROP_REQUEST.has(name.toLowerCase()) || /[\r\n]/.test(name + value)) continue;
    lines.push(`${name}: ${value}`);
  }
  if (request.body || !['GET', 'HEAD'].includes(request.method)) lines.push(`Content-Length: ${request.body?.length ?? 0}`);
  return fromLatin1(`${lines.join('\r\n')}\r\n\r\n`);
}

/** Parses one response as it arrives; returns the feed for the stream's bytes and its end. */
export function responseParser(method: string, sink: HttpSink, done: () => void): { data(bytes: Bytes): void; end(): void } {
  let head: Bytes = new Uint8Array(0);
  let mode: 'head' | 'length' | 'chunked' | 'until-end' | 'done' = 'head';
  let left = 0;
  let chunkState: 'size' | 'data' | 'crlf' | 'trailer' = 'size';
  let line = '';
  const finish = () => { if (mode === 'done') return; mode = 'done'; sink.end(); done(); };
  const fail = (message: string) => { if (mode === 'done') return; mode = 'done'; sink.fail(new Error(message)); done(); };

  const parseHead = (text: string): void => {
    const [status, ...rest] = text.split('\r\n');
    const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(status);
    if (!match) return fail('The PC sent no HTTP answer.');
    const code = Number(match[1]);
    const headers: Array<[string, string]> = [];
    let length: number | undefined;
    let chunked = false;
    for (const row of rest) {
      const colon = row.indexOf(':');
      if (colon <= 0) continue;
      const name = row.slice(0, colon).trim();
      const value = row.slice(colon + 1).trim();
      const lower = name.toLowerCase();
      if (lower === 'transfer-encoding' && /chunked/i.test(value)) chunked = true;
      if (lower === 'content-length' && /^\d+$/.test(value)) length = Number(value);
      if (!DROP_RESPONSE.has(lower) && !(lower === 'content-length' && chunked)) headers.push([name, value]);
    }
    sink.head({ status: code, statusText: match[2] ?? '', headers: chunked ? headers.filter(([name]) => name.toLowerCase() !== 'content-length') : headers });
    if (method === 'HEAD' || code === 204 || code === 304 || (code >= 100 && code < 200)) { finish(); return; }
    if (chunked) { mode = 'chunked'; return; }
    if (length !== undefined) { mode = 'length'; left = length; if (!left) finish(); return; }
    mode = 'until-end';
  };

  const chunked = (bytes: Bytes): void => {
    let at = 0;
    while (at < bytes.length && mode === 'chunked') {
      if (chunkState === 'data') {
        const take = Math.min(left, bytes.length - at);
        sink.data(bytes.slice(at, at + take));
        at += take;
        left -= take;
        if (!left) chunkState = 'crlf';
        continue;
      }
      const ch = String.fromCharCode(bytes[at++]);
      if (ch !== '\n') { if (ch !== '\r') line += ch; if (line.length > 1024) return fail('Bad chunk.'); continue; }
      if (chunkState === 'crlf') { line = ''; chunkState = 'size'; continue; }
      if (chunkState === 'size') {
        const size = parseInt(line.split(';')[0], 16);
        line = '';
        if (!Number.isFinite(size)) return fail('Bad chunk.');
        if (size === 0) chunkState = 'trailer';
        else { left = size; chunkState = 'data'; }
        continue;
      }
      if (line === '') { finish(); return; } // the empty line after the trailers
      line = '';
    }
  };

  return {
    data(bytes) {
      if (mode === 'done') return;
      if (mode === 'head') {
        head = concat(head, bytes);
        const text = latin1(head.subarray(0, Math.min(head.length, MAX_HEAD + 4)));
        const at = text.indexOf('\r\n\r\n');
        if (at < 0) { if (head.length > MAX_HEAD) fail('The PC\'s answer head is too large.'); return; }
        const restBytes = head.slice(at + 4);
        head = new Uint8Array(0);
        parseHead(text.slice(0, at));
        if (restBytes.length) this.data(restBytes);
        return;
      }
      if (mode === 'length') {
        const take = bytes.subarray(0, Math.min(left, bytes.length));
        left -= take.length;
        if (take.length) sink.data(take.slice());
        if (!left) finish();
        return;
      }
      if (mode === 'chunked') { chunked(bytes); return; }
      sink.data(bytes);
    },
    end() {
      if (mode === 'until-end') finish();
      else if (mode !== 'done') fail('Your PC ended the answer early.');
    },
  };
}

/** One request on its own stream (in an HTTP slot); the answer streams into `sink`. Returns a cancel function. */
export async function httpRequest(mux: StreamMux, request: HttpRequest, sink: HttpSink): Promise<() => void> {
  const release = await mux.slot();
  const stream = mux.openStream();
  const parser = responseParser(request.method, sink, () => { release(); stream.end(); });
  stream.listen({ data: (bytes) => parser.data(bytes), end: () => { parser.end(); release(); } });
  const head = requestHead(request);
  void stream.write(request.body?.length ? concat(head, request.body) : head);
  return () => { parser.end(); stream.end(); release(); };
}

/** The whole answer at once (small things: the PC's index page, phone.pcs). */
export function httpFetch(mux: StreamMux, request: HttpRequest): Promise<{ head: HttpHead; body: Bytes }> {
  return new Promise((resolve, reject) => {
    let head: HttpHead | undefined;
    const parts: Bytes[] = [];
    void httpRequest(mux, request, {
      head: (value) => { head = value; },
      data: (bytes) => { parts.push(bytes); },
      end: () => (head ? resolve({ head, body: concat(...parts) }) : reject(new Error('No answer from your PC.'))),
      fail: reject,
    }).catch(reject);
  });
}

/** A header of a parsed head (case-insensitive). */
export const headerOf = (head: HttpHead, name: string): string | undefined => head.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
