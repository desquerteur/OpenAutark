// MCP authorization (B-052 track B): the browser's way back after a sign-in (RFC 8252 loopback redirect) – a
// generalized copy of runtime/calendar/sources/oauth-loopback.ts. One HTTP listener on 127.0.0.1 per sign-in, on
// the first free port of `ports` (the install's stable port first: some servers accept only the exact registered
// redirect), GET /callback only, a Host-header check (DNS rebinding), a random `state` and a PKCE S256 pair, an
// optional check of the answer (RFC 9207 `iss`), a 5-minute timeout (one timer), and the listener closes after the
// one answer that carries the state. Page texts are neutral; the authorization endpoint and its parameters are inputs.
// Owns: the listener of one sign-in and its PKCE pair. Never: logs a code, a verifier or a token, shows server text,
// or listens on anything but 127.0.0.1.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WorkforceError } from '../../../shared/errors.ts';
import type { Timers } from '../../schedules/scheduler.ts';
import { safeCode } from './http.ts';

/** The request and response parts the handler uses (node:http in the app, plain objects in tests). */
export interface LoopbackRequest { method?: string; url?: string; headers: { host?: string } }
export interface LoopbackResponse { writeHead(status: number, headers: Record<string, string>): unknown; end(body?: string): unknown }
export type LoopbackHandler = (request: LoopbackRequest, response: LoopbackResponse) => void;
/** `listen(port)` resolves the bound port (port 0: the OS picks) or rejects (busy). */
export interface LoopbackServer { listen(port: number): Promise<number>; close(): void }
export type LoopbackServerFactory = (handler: LoopbackHandler) => LoopbackServer;

export interface CallbackAnswer { code: string; verifier: string; redirectUri: string }

export interface LoopbackListener {
  port: number;
  redirectUri: string;
  /** The authorization address: `endpoint` (its own query kept) + `params` + redirect_uri, state and the S256 challenge. */
  address(endpoint: string, params: Record<string, string | undefined>): string;
  /** Resolves once the browser comes back with a code; rejects on a refusal, a failed check, the timeout or close() (a request with a wrong state is answered and ignored). */
  answer: Promise<CallbackAnswer>;
  /** Ends the sign-in (default: cancelled). Harmless twice. */
  close(error?: Error): void;
}

export interface LoopbackInput {
  /** Ports to try in order (the first that binds wins). */
  ports: readonly number[];
  /** Checks the answer's parameters after the state (e.g. RFC 9207 `iss`); an error ends the sign-in. */
  verify?: (params: URLSearchParams) => Error | undefined;
  timers?: Timers;
  timeoutMs?: number;
  server?: LoopbackServerFactory;
  random?: (bytes: number) => Buffer;
}

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
export const CALLBACK_PATH = '/callback';
const HOST = '127.0.0.1';
const SIGNED_IN = "You're signed in – you can close this tab.";
const FAILED = 'Sign-in failed – go back to Autark.';

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

/** The listener on 127.0.0.1. */
export function nodeLoopbackServer(handler: LoopbackHandler): LoopbackServer {
  const server = createServer((request, response) => handler(request, response));
  return {
    listen: (port) => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    }),
    close: () => { server.close(); server.closeAllConnections?.(); },
  };
}

const page = (text: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Autark</title><body style="font:15px system-ui,sans-serif;margin:48px"><p>${text}</p></body></html>`;

/** Opens the listener for one sign-in on the first free port of `input.ports`. */
export async function openLoopback(input: LoopbackInput): Promise<LoopbackListener> {
  const timers = input.timers ?? realTimers;
  const random = input.random ?? randomBytes;
  const state = base64url(random(16));
  const { verifier, challenge } = pkcePair(random);
  let settle: { resolve: (value: CallbackAnswer) => void; reject: (error: Error) => void } | undefined;
  const answer = new Promise<CallbackAnswer>((resolve, reject) => { settle = { resolve, reject }; });
  answer.catch(() => undefined); // a sign-in nobody waits for any more must not become an unhandled rejection
  let port = 0;
  let timer: unknown;
  let closed = false;
  let server: LoopbackServer | undefined;
  const redirectUri = () => `http://${HOST}:${port}${CALLBACK_PATH}`;

  const finish = (error?: Error, value?: CallbackAnswer) => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) timers.clear(timer);
    server?.close();
    if (error) settle!.reject(error); else settle!.resolve(value!);
  };

  const handler: LoopbackHandler = (request, response) => {
    const reply = (status: number, text: string) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end(page(text));
    };
    if (closed) { reply(410, 'This sign-in has ended – you can close this tab.'); return; }
    if (request.method !== 'GET' || request.headers.host !== `${HOST}:${port}`) { reply(400, 'Not here.'); return; }
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${HOST}:${port}`); } catch { reply(400, 'Not here.'); return; }
    const params = url.searchParams;
    if (url.pathname !== CALLBACK_PATH || (!params.has('state') && !params.has('code') && !params.has('error'))) { reply(404, 'Not here.'); return; }
    if (params.get('state') !== state) {
      reply(400, 'This is not the sign-in that is open – you can close this tab.'); // never ends the open sign-in: any page could send one
      return;
    }
    const refused = input.verify?.(params);
    if (refused) { reply(400, FAILED); finish(refused); return; }
    const failed = params.get('error');
    const code = params.get('code');
    if (failed !== null || !code) {
      reply(200, FAILED);
      const reason = safeCode(failed);
      finish(failed === 'access_denied'
        ? new WorkforceError('cancelled', 'The sign-in was cancelled.')
        : new WorkforceError('unavailable', `The app did not finish the sign-in${reason ? ` (${reason})` : ''}.`));
      return;
    }
    reply(200, SIGNED_IN);
    finish(undefined, { code, verifier, redirectUri: redirectUri() });
  };

  for (const candidate of input.ports) {
    const attempt = (input.server ?? nodeLoopbackServer)(handler);
    try { port = await attempt.listen(candidate); server = attempt; break; } catch { attempt.close(); }
  }
  if (!server) throw new WorkforceError('unavailable', 'Autark could not open the sign-in listener on this PC.');
  timer = timers.set(() => finish(new WorkforceError('timeout', 'The sign-in took longer than 5 minutes. Try again.')), input.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  return {
    port,
    redirectUri: redirectUri(),
    address: (endpoint, params) => {
      const url = new URL(endpoint);
      for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
      url.searchParams.set('redirect_uri', redirectUri());
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    answer,
    close: (error) => finish(error ?? new WorkforceError('cancelled', 'The sign-in was cancelled.')),
  };
}
