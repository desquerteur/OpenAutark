// The page side of the iPhone web app's fetch relay (B-078 follow-up): the service worker holds nothing (iOS ends it when
// idle) and posts every request for a PC path to this page with a MessagePort – {type:'hosted.fetch', method, path,
// headers, body, wait} – and this page sends it over its tunnel (http.ts) and streams the answer back: {t:'head'}, then
// {t:'chunk', data} (transferred), then {t:'end'}; {t:'error', offline} when no channel came within `wait` (the worker then
// serves its copy or 503) or the answer broke. The worker may post {t:'cancel'} when the page stopped reading.
// Owns: that message protocol. Never: caches, decides what may be fetched (only PC paths reach it), or adds the token.

import type { Bytes } from './bytes.ts';
import { httpRequest } from './http.ts';
import type { StreamMux } from './streams.ts';

export interface FetchMessage { type: 'hosted.fetch'; method: string; path: string; headers: Array<[string, string]>; body?: ArrayBuffer; wait?: number }

/** The reply port's few members (a MessagePort). */
export interface PortLike { postMessage(message: unknown, transfer?: ArrayBuffer[]): void; onmessage: ((event: { data: unknown }) => void) | null; close(): void }

const WAIT_MS = 10_000;

export const isFetchMessage = (value: unknown): value is FetchMessage => {
  const m = value as Partial<FetchMessage> | null;
  return Boolean(m && m.type === 'hosted.fetch' && typeof m.method === 'string' && typeof m.path === 'string' && m.path.startsWith('/') && Array.isArray(m.headers));
};

/** Answers one relayed request on `port` through the mux `awaitMux` gives within the request's wait. */
export async function answerFetch(message: FetchMessage, port: PortLike, awaitMux: (ms: number) => Promise<StreamMux | undefined>): Promise<void> {
  const mux = await awaitMux(Math.min(Math.max(message.wait ?? WAIT_MS, 0), 30_000));
  if (!mux) { port.postMessage({ t: 'error', offline: true }); port.close(); return; }
  let cancel: (() => void) | undefined;
  let finished = false;
  port.onmessage = (event) => { if ((event.data as { t?: string } | null)?.t === 'cancel') { finished = true; cancel?.(); port.close(); } };
  cancel = await httpRequest(mux, { method: message.method, path: message.path, headers: message.headers, ...(message.body?.byteLength ? { body: new Uint8Array(message.body) } : {}) }, {
    head: (head) => { if (!finished) port.postMessage({ t: 'head', ...head }); },
    data: (bytes: Bytes) => {
      if (finished) return;
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
      port.postMessage({ t: 'chunk', data: buffer }, [buffer]);
    },
    end: () => { if (finished) return; finished = true; port.postMessage({ t: 'end' }); port.close(); },
    fail: (error) => { if (finished) return; finished = true; port.postMessage({ t: 'error', offline: false, message: error.message }); port.close(); },
  });
  if (finished) cancel();
}

/** Listens for the worker's requests on this page (navigator.serviceWorker); returns the off switch. */
export function startBridge(container: { addEventListener(type: 'message', fn: (event: { data: unknown; ports: readonly unknown[] }) => void): void; removeEventListener(type: 'message', fn: (event: { data: unknown; ports: readonly unknown[] }) => void): void },
  awaitMux: (ms: number) => Promise<StreamMux | undefined>): () => void {
  const listener = (event: { data: unknown; ports: readonly unknown[] }) => {
    const port = event.ports?.[0] as PortLike | undefined;
    if (!port || !isFetchMessage(event.data)) return;
    void answerFetch(event.data, port, awaitMux).catch(() => { try { port.postMessage({ t: 'error', offline: false }); port.close(); } catch { /* gone */ } });
  };
  container.addEventListener('message', listener);
  return () => container.removeEventListener('message', listener);
}
