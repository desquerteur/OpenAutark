// Test helpers for B-055 feedback: a fake Firestore mailbox and Google token endpoint behind a fake `fetch` (create,
// list, get, delete with the real REST shapes; the token endpoint verifies the service account's JWT), a throw-away
// service account (a fresh RSA key) and runtime services with a real vault, a temp data dir and a temp resources dir.
// Owns: these fakes. Never: contacts Google or Firebase, or reads real keys.

import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { DATASTORE_SCOPE } from '../../../src/runtime/feedback/google.ts';
import { TOKEN_URL } from '../../../src/runtime/feedback/transport.ts';

export const PROJECT = 'workforce-feedback-test';
export const API_KEY = 'AIzaSyFakeKeyForLocalTestsOnly-0123456';
const DOCS = `/v1/projects/${PROJECT}/databases/(default)/documents/feedback`;

export interface Call { method: string; url: URL; headers: Record<string, string>; body?: string; init?: RequestInit }

export function serviceAccount(project = PROJECT): { text: string; publicKey: KeyObject; email: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const email = `feedback-reader@${project}.iam.gserviceaccount.com`;
  const text = JSON.stringify({
    type: 'service_account', project_id: project, private_key_id: 'abc123def456', client_email: email, client_id: '1',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: TOKEN_URL,
  });
  return { text, publicKey, email };
}

/** Checks an RS256 JWT against `publicKey`; returns its header and claims (throws when the signature is wrong). */
export function verifyJwt(jwt: string, publicKey: KeyObject): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [header, claims, signature] = jwt.split('.');
  if (!verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))) throw new Error('bad signature');
  return { header: JSON.parse(Buffer.from(header, 'base64url').toString()), claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) };
}

export function fakeMailbox(options: { accountKey?: KeyObject; origin?: string } = {}) {
  const origin = options.origin ?? 'https://firestore.googleapis.com';
  const docs = new Map<string, Buffer>();
  const calls: Call[] = [];
  const log: string[] = [];
  const state = { create: null as number | 'throw' | 'lose' | null, token: null as number | null, tokens: 0, onDelete: (_id: string) => {} };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const run = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const method = init?.method ?? 'GET';
    calls.push({ method, url, headers, body: typeof init?.body === 'string' ? init.body : undefined, init });
    if (url.href === TOKEN_URL || url.pathname === '/token') {
      state.tokens += 1;
      if (state.token) return new Response('{"error":"invalid_grant","detail":"private upstream detail"}', { status: state.token });
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !options.accountKey) return json({ error: 'invalid_request' }, 400);
      const { claims } = verifyJwt(form.get('assertion') ?? '', options.accountKey);
      if (claims.scope !== DATASTORE_SCOPE || claims.aud !== TOKEN_URL) return json({ error: 'invalid_scope' }, 400);
      return json({ access_token: 'ya29.fake-access-token', expires_in: 3599, token_type: 'Bearer' });
    }
    if (url.origin !== origin || !url.pathname.startsWith(DOCS)) return json({ error: { status: 'NOT_FOUND' } }, 404);
    const id = decodeURIComponent(url.pathname.slice(DOCS.length + 1));
    if (method === 'POST' && !id) {
      if (url.searchParams.get('key') !== API_KEY || headers.authorization) return json({ error: { status: 'PERMISSION_DENIED' } }, 403);
      if (state.create === 'throw') throw new TypeError('fetch failed');
      if (state.create && state.create !== 'lose') return json({ error: { status: 'UNAVAILABLE' } }, state.create);
      const docId = url.searchParams.get('documentId') ?? '';
      const fields = JSON.parse(String(init?.body)).fields;
      log.push(`create ${docId}`);
      if (docs.has(docId)) return json({ error: { code: 409, status: 'ALREADY_EXISTS' } }, 409);
      if (Object.keys(fields).sort().join() !== 'sealed,v' || fields.v.integerValue !== '1') return json({ error: { status: 'PERMISSION_DENIED' } }, 403);
      docs.set(docId, Buffer.from(fields.sealed.bytesValue, 'base64'));
      if (state.create === 'lose') throw new TypeError('connection reset'); // stored, but the answer never arrives
      return json({ name: `projects/${PROJECT}/databases/(default)/documents/feedback/${docId}`, fields: { v: { integerValue: '1' } } });
    }
    if (headers.authorization !== 'Bearer ya29.fake-access-token') return json({ error: { status: 'UNAUTHENTICATED' } }, 401);
    if (method === 'GET' && !id) {
      // Like Firestore, the page token is a cursor (the last name of the page), so deletes between pages skip nothing.
      const after = url.searchParams.get('pageToken') ?? '';
      const all = [...docs.keys()].sort().filter((doc) => doc > after);
      const size = Number(url.searchParams.get('pageSize') ?? 20);
      const page = all.slice(0, size);
      log.push(`list ${after || 'start'}`);
      return json({ documents: page.map((doc) => ({ name: `projects/${PROJECT}/databases/(default)/documents/feedback/${doc}`, fields: { v: { integerValue: '1' } } })),
        ...(all.length > size ? { nextPageToken: page[page.length - 1] } : {}) });
    }
    if (method === 'GET') {
      log.push(`get ${id}`);
      const bytes = docs.get(id);
      return bytes ? json({ name: `x/${id}`, fields: { v: { integerValue: '1' }, sealed: { bytesValue: bytes.toString('base64') } } }) : json({ error: { status: 'NOT_FOUND' } }, 404);
    }
    if (method === 'DELETE') {
      log.push(`delete ${id}`);
      state.onDelete(id);
      docs.delete(id);
      return json({});
    }
    return json({}, 400);
  }) as typeof fetch;
  return { fetch: run, docs, calls, log, state };
}

export interface Env {
  s: RuntimeServices;
  clock: ManualClock;
  vault: SecretVault;
  data: string;
  resources: string;
  shot: { id: string; name: string; mime: string; size: number; createdAt: number };
  bytes: { value: Uint8Array };
  events: Array<{ event: string; data: unknown }>;
  setPackaged(value: boolean): void;
  setDiagnostics(value: boolean): void;
  cleanup(): void;
}

/** Runtime services for feedback: a migrated in-memory db, a real vault (plain "encryption"), temp folders. */
export function feedbackEnv(): Env {
  const db = new Db(':memory:');
  migrate(db);
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-feedback-'));
  const data = path.join(root, 'data');
  const resources = path.join(root, 'resources');
  const logs = path.join(data, 'logs');
  mkdirSync(logs, { recursive: true });
  mkdirSync(path.join(resources, 'feedback'), { recursive: true });
  writeFileSync(path.join(resources, 'feedback', 'firestore.rules'), "rules_version = '2';\n// test rules\n");
  writeFileSync(path.join(logs, 'runtime.log'), JSON.stringify({ t: '2026-10-29T09:01:00.000Z', level: 'warn', msg: 'engine failed', data: { error: 'token sk-proj-ABCDEFGHIJKLMNOPQRSTUV at C:\\Users\\alex\\x' } }));
  const clock = new ManualClock(Date.UTC(2026, 9, 29, 20));
  const bus = new Bus((error) => { throw error; });
  const events: Array<{ event: string; data: unknown }> = [];
  bus.onAny((event, data) => events.push({ event, data }));
  const vault = new SecretVault({ db, clock, host: { encrypt: async (plain) => new TextEncoder().encode(`enc:${plain}`), decrypt: async (cipher) => new TextDecoder().decode(cipher).slice(4) } });
  const shot = { id: 'a'.repeat(64), name: 'screenshot.png', mime: 'image/png', size: 12, createdAt: 1 };
  const bytes = { value: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]) };
  const app = { version: '0.2.0', packaged: false, resourcesDir: resources, dataDir: data, executable: process.execPath };
  let diagnostics = false;
  const s = {
    db, bus, clock, log: new MemoryLogger(), secrets: vault,
    paths: { data, resources, logs, temp: path.join(data, 'tmp') },
    host: { app, openExternal: async () => { throw new Error('no browser in feedback'); }, openPath: async () => { throw new Error('no file manager in feedback'); } },
    files: { get: (id: string) => (id === shot.id ? shot : undefined), read: async () => bytes.value },
    settings: { get: () => ({ feedback: { includeDiagnostics: diagnostics } }) },
    org: { get: (id: string) => (id === 'ag_1' ? { id, name: 'Mira' } : undefined) },
  } as unknown as RuntimeServices;
  return {
    s, clock, vault, data, resources, shot, bytes, events,
    setPackaged: (value) => { app.packaged = value; },
    setDiagnostics: (value) => { diagnostics = value; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

