// Bounded downloads for skill links (AF-007): one GET with a time limit and a byte limit that counts what arrives (a
// missing or wrong Content-Length changes nothing), redirects followed but never to plain http. A 404 is "not there" (a
// GitHub ref try moves on); every other failure says what happened, without the server's body.
// Owns: these limits and messages. Never: keeps a body beyond the call or sends anything but the GET.

import { WorkforceError } from '../../../shared/errors.ts';

/** `fetch` as the links use it (tests pass a fake; the runtime uses the global one). */
export type LinkFetch = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<Response>;

export const FETCH_MS = 60_000;

export interface Download {
  bytes: Buffer;
  /** The address after redirects (the request's when the response does not say). */
  url: string;
}

const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

function tooLarge(maxBytes: number): WorkforceError {
  return new WorkforceError('bad_request', `This download is larger than ${maxBytes >= 1024 * 1024 ? megabytes(maxBytes) : `${Math.round(maxBytes / 1024)} KB`} – too large for a skill.`);
}

/** The body of `url` (at most `maxBytes`), or undefined on 404. */
export async function download(fetchFn: LinkFetch, url: string, options: { maxBytes: number; timeoutMs?: number }): Promise<Download | undefined> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_MS);
  let response: Response;
  try {
    response = await fetchFn(url, { signal, redirect: 'follow' });
  } catch (error) {
    if ((error as { name?: string }).name === 'TimeoutError' || signal.aborted) throw new WorkforceError('timeout', 'The address did not answer in time.');
    throw new WorkforceError('unavailable', `The address could not be reached (${(error as Error).message || 'network error'}).`);
  }
  const finalUrl = response.url || url;
  if (/^http:/i.test(finalUrl)) throw new WorkforceError('forbidden', 'The address sent the download to a plain http address; it is not read.');
  if (response.status === 404 || response.status === 410) { await response.body?.cancel().catch(() => undefined); return undefined; }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429 || response.status === 403) throw new WorkforceError('rate_limited', `The server refused the download for now (${response.status}). Try again later.`);
    throw new WorkforceError('unavailable', `The address answered ${response.status}.`);
  }
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > options.maxBytes) { await response.body?.cancel().catch(() => undefined); throw tooLarge(options.maxBytes); }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > options.maxBytes) throw tooLarge(options.maxBytes);
    return { bytes, url: finalUrl };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) { await reader.cancel().catch(() => undefined); throw tooLarge(options.maxBytes); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof WorkforceError) throw error;
    if (signal.aborted) throw new WorkforceError('timeout', 'The download did not finish in time.');
    throw new WorkforceError('unavailable', `The download broke off (${(error as Error).message || 'network error'}).`);
  }
  return { bytes: Buffer.concat(chunks, total), url: finalUrl };
}
