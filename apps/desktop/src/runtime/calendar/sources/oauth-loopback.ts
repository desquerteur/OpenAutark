// Google consent through the system browser (B-041 track G, RFC 8252 loopback redirect): one ephemeral HTTP listener
// on 127.0.0.1:0 per consent, a random `state` and a PKCE S256 challenge in the consent address, a 5-minute timeout
// (one timer), and the listener closes after the one answer that carries the state (a stray request such as
// /favicon.ico is no answer). A wrong state, a wrong Host header (DNS rebinding) or Google's error ends the consent;
// never a route of the runtime server (that one may listen on the LAN for phones).
// Owns: the loopback listener of one consent and its PKCE pair. Never: logs a code, a verifier or a token, or listens
// on anything but 127.0.0.1.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WorkforceError } from '../../../shared/errors.ts';
import type { Timers } from '../../schedules/scheduler.ts';

export interface LoopbackConsent {
  /** The consent page to open in the person's browser. */
  authUrl: string;
  /** Resolves with the authorization code once Google redirects back (rejects on timeout, a wrong state, a refusal or close()). */
  code: Promise<{ code: string; verifier: string; redirectUri: string }>;
  close(): void;
}

/** The request and response parts the handler uses (node:http in the app, plain objects in tests). */
export interface LoopbackRequest { method?: string; url?: string; headers: { host?: string } }
export interface LoopbackResponse { writeHead(status: number, headers: Record<string, string>): unknown; end(body?: string): unknown }
export type LoopbackHandler = (request: LoopbackRequest, response: LoopbackResponse) => void;
export interface LoopbackServer { listen(): Promise<number>; close(): void }
export type LoopbackServerFactory = (handler: LoopbackHandler) => LoopbackServer;

export interface LoopbackInput {
  clientId: string;
  scopes: readonly string[];
  timers?: Timers;
  timeoutMs?: number;
  server?: LoopbackServerFactory;
  random?: (bytes: number) => Buffer;
}

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const CONSENT_TIMEOUT_MS = 5 * 60_000;
const HOST = '127.0.0.1';

const realTimers: Timers = {
  set: (fn, ms) => { const handle = setTimeout(fn, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** A PKCE verifier (43 chars) and its S256 challenge. */
export function pkcePair(random: (bytes: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = base64url(random(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** The listener on 127.0.0.1 with a port the OS picks. */
export function nodeLoopbackServer(handler: LoopbackHandler): LoopbackServer {
  const server = createServer((request, response) => handler(request, response));
  return {
    listen: () => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, HOST, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    }),
    close: () => { server.close(); server.closeAllConnections?.(); },
  };
}

const page = (text: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Autark</title><body style="font:15px system-ui,sans-serif;margin:48px"><p>${text}</p></body></html>`;

/** Opens the loopback listener for one consent of `clientId` with `scopes`. */
export async function startLoopback(input: LoopbackInput): Promise<LoopbackConsent> {
  const timers = input.timers ?? realTimers;
  const random = input.random ?? randomBytes;
  const state = base64url(random(16));
  const { verifier, challenge } = pkcePair(random);
  let settle: { resolve: (value: { code: string; verifier: string; redirectUri: string }) => void; reject: (error: Error) => void } | undefined;
  const code = new Promise<{ code: string; verifier: string; redirectUri: string }>((resolve, reject) => { settle = { resolve, reject }; });
  code.catch(() => undefined); // a consent nobody waits for any more must not become an unhandled rejection
  let port = 0;
  let timer: unknown;
  let closed = false;

  const finish = (error?: Error, value?: { code: string; verifier: string; redirectUri: string }) => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) timers.clear(timer);
    server.close();
    if (error) settle!.reject(error); else settle!.resolve(value!);
  };

  const handler: LoopbackHandler = (request, response) => {
    const answer = (status: number, text: string) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end(page(text));
    };
    if (closed) { answer(410, 'This sign-in has ended. You can close this tab.'); return; }
    if (request.method !== 'GET' || request.headers.host !== `${HOST}:${port}`) { answer(400, 'Not here.'); return; }
    const url = new URL(request.url ?? '/', `http://${HOST}:${port}`);
    const params = url.searchParams;
    if (url.pathname !== '/' || (!params.has('state') && !params.has('code') && !params.has('error'))) { answer(404, 'Not here.'); return; }
    if (params.get('state') !== state) {
      answer(400, 'This sign-in answer does not belong to the app. Start again in Settings › Calendar.');
      finish(new WorkforceError('forbidden', 'The Google sign-in answer did not match. Try again.'));
      return;
    }
    const failed = params.get('error');
    const received = params.get('code');
    if (failed || !received) {
      answer(200, 'Google Calendar was not connected. You can close this tab.');
      finish(failed === 'access_denied' ? new WorkforceError('cancelled', 'Google sign-in was cancelled.') : new WorkforceError('unavailable', 'Google did not finish the sign-in.'));
      return;
    }
    answer(200, 'Google Calendar is connected. You can close this tab and go back to the app.');
    finish(undefined, { code: received, verifier, redirectUri: `http://${HOST}:${port}` });
  };

  const server = (input.server ?? nodeLoopbackServer)(handler);
  try { port = await server.listen(); } catch {
    throw new WorkforceError('unavailable', 'The app could not open the sign-in listener on this PC.');
  }
  timer = timers.set(() => finish(new WorkforceError('timeout', 'Google sign-in took longer than 5 minutes. Try again.')), input.timeoutMs ?? CONSENT_TIMEOUT_MS);
  const query = new URLSearchParams({
    client_id: input.clientId, redirect_uri: `http://${HOST}:${port}`, response_type: 'code', scope: input.scopes.join(' '), state,
    code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
  });
  return { authUrl: `${GOOGLE_AUTH_URL}?${query.toString()}`, code, close: () => finish(new WorkforceError('cancelled', 'The Google sign-in was replaced.')) };
}
