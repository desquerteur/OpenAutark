// HTTP for feedback (B-055): the team's Firestore mailbox and Google's OAuth token endpoint – nothing else. Replaces
// the GitHub receiver path of B-036 (WORKFORCE_FEEDBACK_ORIGIN, __FEEDBACK_ORIGIN__), which is gone.
// Owns: one bounded request – no redirects, no cookies or browser credentials, a 20 s timeout, a capped response –
// and the loopback origin a local test fake may stand in for Google with.
// Never: follows a redirect, returns or logs a remote error body, or reaches a host other than Google or loopback.

export const FIRESTORE_ORIGIN = 'https://firestore.googleapis.com';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REQUEST_TIMEOUT_MS = 20_000;

export interface Reply { status: number; body: Buffer }

/** A loopback http(s) origin (a local fake of Google in tests), else undefined. Never a path, query or credentials. */
export function loopbackOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?\/?$/i.exec(value);
  if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) return undefined;
  return `${match[1].toLowerCase()}://${match[2].toLowerCase()}${match[3] ? `:${Number(match[3])}` : ''}`;
}

/** Reads at most `cap` bytes of a response; more fails (a proxy may ignore Content-Length). */
async function capped(response: Response, cap: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > cap) { await reader.cancel(); throw new Error('oversized response'); }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * One request. `cap` bounds the body that is read (0: the body is discarded unread). Network failures and an
 * oversized body throw a plain Error without remote details; any HTTP status is returned to the caller.
 */
export async function request(run: typeof fetch, url: string, init: { method: string; headers?: Record<string, string>; body?: string }, cap: number): Promise<Reply> {
  const response = await run(url, {
    method: init.method, headers: init.headers, body: init.body,
    redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (cap <= 0) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, body: Buffer.alloc(0) };
  }
  return { status: response.status, body: await capped(response, cap) };
}
