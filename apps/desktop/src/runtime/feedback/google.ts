// The team side's access to the mailbox (B-055 Q2): a Google service account (only in the owner's vault) signs a
// JWT (RS256, node:crypto) that Google's token endpoint exchanges for an access token (scope datastore); with it
// the team PC lists, reads and deletes mailbox documents over Firestore REST (no SDK). Admin access ignores the
// security rules, which deny every read to everyone else.
// Owns: checking the service account, the JWT, the token cache (in memory, until shortly before expiry) and the
// three document calls. Never: logs or returns a token, the key or a remote error body; reaches another host.

import { createPrivateKey, sign } from 'node:crypto';
import { WorkforceError } from '../../shared/errors.ts';
import { DOCUMENT_ID, documentsUrl } from './drop.ts';
import { request, TOKEN_URL, type Reply } from './transport.ts';

export const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_LIFETIME_S = 3600;
const PAGE_SIZE = 50;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
}

const bad = (message: string) => new WorkforceError('bad_request', message);
const unavailable = () => new WorkforceError('unavailable', 'The feedback mailbox could not be reached. Try again later.');
const refused = () => new WorkforceError('forbidden', 'Google refused the feedback service account. Run wf feedback setup with a current key file.');

/** The fields we use from a Google service account key file; anything else in it is ignored. */
export function parseServiceAccount(text: string): ServiceAccount {
  let value: Record<string, unknown>;
  try { value = JSON.parse(text) as Record<string, unknown>; } catch { throw bad('The service account file is not JSON.'); }
  if (!value || typeof value !== 'object' || value.type !== 'service_account') throw bad('This is not a Google service account key file (type "service_account").');
  const email = value.client_email;
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('The service account file has no client_email.');
  const key = value.private_key;
  if (typeof key !== 'string' || !key.includes('-----BEGIN PRIVATE KEY-----')) throw bad('The service account file has no private key.');
  try {
    if (createPrivateKey(key).asymmetricKeyType !== 'rsa') throw new Error('not rsa');
  } catch {
    throw bad('The service account\'s private key cannot be read.');
  }
  const keyId = typeof value.private_key_id === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value.private_key_id) ? value.private_key_id : undefined;
  const project = typeof value.project_id === 'string' ? value.project_id : undefined;
  return { client_email: email, private_key: key, ...(keyId ? { private_key_id: keyId } : {}), ...(project ? { project_id: project } : {}) };
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** A signed JWT asking `audience` (Google's token endpoint) for a datastore token, valid one hour from `nowMs`. */
export function serviceJwt(account: ServiceAccount, nowMs: number, audience = TOKEN_URL): string {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
  const claims = { iss: account.client_email, scope: DATASTORE_SCOPE, aud: audience, iat, exp: iat + TOKEN_LIFETIME_S };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), createPrivateKey(account.private_key)).toString('base64url')}`;
}

export interface MailboxOptions {
  project: string;
  /** Firestore origin (a loopback fake in tests). */
  firestore?: string;
  tokenUrl: string;
  fetch: typeof fetch;
  now(): number;
}

function json(body: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** One fetch's access to the mailbox; the token is asked for once and reused while it is valid. */
export class Mailbox {
  private readonly account: ServiceAccount;
  private readonly options: MailboxOptions;
  private token: { value: string; until: number } | undefined;

  constructor(account: ServiceAccount, options: MailboxOptions) {
    this.account = account;
    this.options = options;
  }

  private async bearer(): Promise<Record<string, string>> {
    const now = this.options.now();
    if (!this.token || this.token.until <= now) {
      const assertion = serviceJwt(this.account, now, TOKEN_URL);
      const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
      let reply: Reply;
      try {
        reply = await request(this.options.fetch, this.options.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, 16 * 1024);
      } catch { throw unavailable(); }
      if (reply.status === 400 || reply.status === 401 || reply.status === 403) throw refused();
      const answer = json(reply.body);
      if (reply.status !== 200 || typeof answer.access_token !== 'string' || !answer.access_token) throw unavailable();
      const seconds = typeof answer.expires_in === 'number' && answer.expires_in > 0 ? answer.expires_in : 300;
      this.token = { value: answer.access_token, until: now + Math.max(0, seconds - 60) * 1000 };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }

  private async call(method: string, url: string, cap: number): Promise<{ status: number; body: Buffer }> {
    const headers = await this.bearer();
    let reply: Reply;
    try { reply = await request(this.options.fetch, url, { method, headers }, cap); } catch { throw unavailable(); }
    if (reply.status === 401 || reply.status === 403) throw refused();
    return reply;
  }

  private base(): string {
    return `${documentsUrl({ project: this.options.project, endpoint: this.options.firestore })}/feedback`;
  }

  /** One page of letter ids (names only: `mask` leaves the sealed bytes out). Ids we would not create are returned as they are. */
  async page(pageToken?: string): Promise<{ ids: string[]; next?: string }> {
    const reply = await this.call('GET', `${this.base()}?pageSize=${PAGE_SIZE}&mask.fieldPaths=v${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, 1024 * 1024);
    if (reply.status !== 200) throw unavailable();
    const answer = json(reply.body);
    const documents = Array.isArray(answer.documents) ? answer.documents as Array<{ name?: unknown }> : [];
    const ids = documents.map((doc) => (typeof doc.name === 'string' ? doc.name.slice(doc.name.lastIndexOf('/') + 1) : '')).filter(Boolean);
    return { ids, ...(typeof answer.nextPageToken === 'string' && answer.nextPageToken ? { next: answer.nextPageToken } : {}) };
  }

  /** The sealed bytes of letter `id`; undefined when it is gone or is no v1 letter. */
  async sealed(id: string): Promise<Buffer | undefined> {
    if (!DOCUMENT_ID.test(id)) return undefined;
    const reply = await this.call('GET', `${this.base()}/${id}`, 2 * 1024 * 1024);
    if (reply.status === 404) return undefined;
    if (reply.status !== 200) throw unavailable();
    const fields = json(reply.body).fields as Record<string, { integerValue?: unknown; bytesValue?: unknown }> | undefined;
    if (String(fields?.v?.integerValue) !== '1' || typeof fields?.sealed?.bytesValue !== 'string') return undefined;
    return Buffer.from(fields.sealed.bytesValue, 'base64');
  }

  /** Deletes letter `id` (already gone is fine). */
  async remove(id: string): Promise<void> {
    if (!DOCUMENT_ID.test(id)) return;
    const reply = await this.call('DELETE', `${this.base()}/${id}`, 0);
    if (reply.status !== 200 && reply.status !== 204 && reply.status !== 404) throw unavailable();
  }
}
