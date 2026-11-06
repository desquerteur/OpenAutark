// Owns: server-only GitHub App authentication, repository privacy and confirmed issue delivery.
// Never: exposes credentials, grants submitters repository access or retries an uncertain create.
import { createPrivateKey, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Env, Fetch, Payload } from './types.ts';

export async function config(env: Env, key: string): Promise<string | undefined> {
  return (await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>())?.value;
}
export async function setConfig(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT INTO config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}
export async function crypt(env: Env, value: string, decrypt = false): Promise<string> {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(env.APP_ENCRYPTION_KEY), (c) => c.charCodeAt(0)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  if (decrypt) {
    const data = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12)));
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)));
  return Buffer.concat([iv, data]).toString('base64');
}
export async function appToken(env: Env): Promise<string | undefined> {
  const id = await config(env, 'app_id');
  const encrypted = await config(env, 'app_key');
  if (!id || !encrypted || !env.APP_ENCRYPTION_KEY) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 300, iss: id })).toString('base64url');
  const data = `${head}.${body}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), createPrivateKey(await crypt(env, encrypted, true))).toString('base64url');
  return `${data}.${signature}`;
}
export async function api(run: Fetch, route: string, token: string, method = 'GET', body?: unknown): Promise<Response> {
  return run(`https://api.github.com${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/vnd.github+json', 'User-Agent': 'workforce-feedback', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export async function repository(env: Env, payload: Payload, run: Fetch): Promise<{ repo: string; token: string } | undefined> {
  const jwt = await appToken(env);
  if (!jwt) return undefined;
  const repo = payload.visibility === 'private' ? env.PRIVATE_REPO : env.PUBLIC_REPO;
  if (!new RegExp(`^${env.GITHUB_OWNER}/[A-Za-z0-9_.-]{1,100}$`, 'i').test(repo)) throw new Error('Repository configuration is invalid.');
  const installation = await api(run, `/repos/${repo}/installation`, jwt);
  if (!installation.ok) throw new Error('GitHub App is not installed on the feedback repository.');
  const { id } = await installation.json() as { id: number };
  const auth = await api(run, `/app/installations/${id}/access_tokens`, jwt, 'POST', { repositories: [repo.split('/')[1]], permissions: { issues: 'write', contents: 'write' } });
  if (!auth.ok) throw new Error('GitHub repository access is unavailable.');
  const { token } = await auth.json() as { token: string };
  const metadata = await api(run, `/repos/${repo}`, token);
  if (!metadata.ok) throw new Error('Feedback repository is unavailable.');
  const details = await metadata.json() as { private: boolean; visibility: string; has_issues: boolean };
  if (!details.has_issues || (payload.visibility === 'private' ? details.visibility !== 'private' : details.visibility !== 'public')) throw new Error('Repository visibility does not match the chosen audience.');
  return { repo, token };
}

export const marker = (id: string) => `<!-- workforce-feedback:${id} -->`;
export async function findIssue(run: Fetch, target: { repo: string; token: string }, id: string): Promise<string | undefined> {
  const response = await api(run, `/repos/${target.repo}/issues?state=all&sort=created&direction=desc&per_page=100`, target.token);
  if (!response.ok) return undefined;
  const issues = await response.json() as Array<{ body?: string; html_url: string; pull_request?: unknown }>;
  return issues.find((issue) => !issue.pull_request && issue.body?.includes(marker(id)))?.html_url;
}

export async function createIssue(run: Fetch, target: { repo: string; token: string }, payload: Payload): Promise<string> {
  let image = '';
  if (payload.image) {
    const extension = payload.image.mime === 'image/jpeg' ? 'jpg' : payload.image.mime === 'image/webp' ? 'webp' : 'png';
    const file = `feedback-images/${payload.requestId}.${extension}`;
    const upload = await api(run, `/repos/${target.repo}/contents/${file}`, target.token, 'PUT', { message: 'Attach feedback screenshot', content: payload.image.base64 });
    if (!upload.ok) throw new Error('Screenshot could not be attached.');
    // The file inherits repository privacy. No anonymous image-serving route exists.
    image = `\n\n[Screenshot](https://github.com/${target.repo}/blob/main/${file})`;
  }
  const response = await api(run, `/repos/${target.repo}/issues`, target.token, 'POST', { title: payload.title, body: `${payload.body}${image}\n\n${marker(payload.requestId)}` });
  if (response.status !== 201) throw new Error('GitHub did not confirm issue creation.');
  const result = await response.json() as { html_url?: string; number?: number };
  if (!result.html_url || !result.number || !new RegExp(`^https://github\\.com/${target.repo}/issues/[1-9][0-9]*$`).test(result.html_url)) throw new Error('GitHub returned an invalid receipt.');
  return result.html_url;
}
