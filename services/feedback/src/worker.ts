// Owns: a write-only feedback inbox and idempotent GitHub delivery, including private images.
// Never: lists reports, serves images, grants repository access, logs bodies or retries unknown writes.
import { config, repository, createIssue, findIssue } from './github.ts';
import { Buffer } from 'node:buffer';
import { json, parse, receipt } from './input.ts';
import { setup } from './setup.ts';
import type { Env, Fetch, Payload, StoredReport } from './types.ts';

async function hash(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
}
async function rate(env: Env, request: Request): Promise<boolean> {
  const now = Date.now();
  const ip = await hash(`${env.APP_ENCRYPTION_KEY}:${request.headers.get('CF-Connecting-IP') ?? 'local'}`);
  for (const [key, limit] of [[`ip:${Math.floor(now / 60_000)}:${ip}`, 5], [`day:${Math.floor(now / 86_400_000)}`, 200]] as const) {
    await env.DB.prepare('INSERT INTO limits(key, count) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1').bind(key).run();
    const result = await env.DB.prepare('SELECT count FROM limits WHERE key = ?').bind(key).first<{ count: number }>();
    if ((result?.count ?? 0) > limit) return false;
  }
  // Keys sort by kind, so expiry uses a separate daily cleanup over bounded recent buckets.
  await env.DB.prepare("DELETE FROM limits WHERE (key LIKE 'ip:%' AND CAST(substr(key, 4, instr(substr(key, 4), ':') - 1) AS INTEGER) < ?) OR (key LIKE 'day:%' AND CAST(substr(key, 5) AS INTEGER) < ?)")
    .bind(Math.floor(now / 60_000) - 2, Math.floor(now / 86_400_000) - 1).run();
  return true;
}

export function receiver(deps: { run?: Fetch; target?: typeof repository; create?: typeof createIssue } = {}) {
  const run = deps.run ?? fetch;
  const targetFor = deps.target ?? repository;
  const create = deps.create ?? createIssue;
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') return json({ service: 'workforce-feedback', githubConfigured: Boolean(await config(env, 'app_id')) });
      if (request.method === 'GET' && url.pathname.startsWith('/setup')) {
        try { return await setup(request, env, run); } catch { return json({ error: 'Setup unavailable.' }, 503); }
      }
      if (url.pathname !== '/v1/reports') return json({ error: 'Not found.' }, 404);
      if (request.method !== 'POST') return json({ error: 'Only submissions are available.' }, 405);
      let payload: Payload;
      try { payload = await parse(request); } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid report.' }, 400); }
      const fingerprint = await hash(JSON.stringify(payload));
      let row = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(payload.requestId).first<StoredReport>();
      if (row && row.hash !== fingerprint) return json({ error: 'This receipt belongs to another submission.' }, 409);
      if (row?.state === 'sent') return receipt(row);
      if (!row) {
        if (!(await rate(env, request))) return json({ error: 'Too many reports. Try later.' }, 429);
        await env.DB.prepare('INSERT OR IGNORE INTO reports(id, hash, payload, state, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(payload.requestId, fingerprint, JSON.stringify(payload), 'received', Date.now()).run();
        row = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(payload.requestId).first<StoredReport>();
        if (!row || row.hash !== fingerprint) return json({ error: 'Submission conflict.' }, 409);
      }
      try {
        const target = await targetFor(env, payload, run);
        if (!target) return receipt(row); // durably in the private operator inbox; never claim GitHub delivery
        if (row.state !== 'received') {
          const found = await findIssue(run, target, row.id);
          if (found) {
            await env.DB.prepare("UPDATE reports SET state = 'sent', url = ? WHERE id = ?").bind(found, row.id).run();
            return receipt({ ...row, state: 'sent', url: found });
          }
          return receipt(row); // unknown outcome: reconcile only, never create another issue
        }
        const claim = await env.DB.prepare("UPDATE reports SET state = 'sending' WHERE id = ? AND state = 'received'").bind(row.id).run();
        if (!claim.meta.changes) return receipt(row);
        try {
          const issue = await create(run, target, payload);
          await env.DB.prepare("UPDATE reports SET state = 'sent', url = ? WHERE id = ?").bind(issue, row.id).run();
          return receipt({ ...row, state: 'sent', url: issue });
        } catch {
          await env.DB.prepare("UPDATE reports SET state = 'uncertain' WHERE id = ?").bind(row.id).run();
          return receipt(row);
        }
      } catch { return receipt(row); } // repository/auth failure leaves a durable private inbox record
    },
  };
}
export default receiver();
