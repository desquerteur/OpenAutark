// Owns: GitHub's official manifest handoff; credentials stay encrypted in the receiver.
// Never: returns a private key/token, accepts another app owner or reconfigures an existing app.
import { api, config, crypt, repository, setConfig } from './github.ts';
import { json } from './input.ts';
import type { Env, Fetch } from './types.ts';

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Feedback setup</title><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'" } });
}

export async function setup(request: Request, env: Env, run: Fetch): Promise<Response> {
  const url = new URL(request.url);
  if (!env.APP_ENCRYPTION_KEY) return html('<p>Configure server encryption before GitHub setup.</p>', 503);
  if (url.pathname === '/setup') {
    if (await config(env, 'app_id')) return html('<p>The GitHub App is already registered.</p>');
    const state = crypto.randomUUID();
    await setConfig(env, 'setup_state', JSON.stringify({ state, until: Date.now() + 600_000 }));
    const manifest = {
      name: 'Workforce feedback', url: url.origin,
      redirect_url: `${url.origin}/setup/callback`, setup_url: `${url.origin}/setup/installed`,
      hook_attributes: { url: `${url.origin}/webhook`, active: false },
      public: false, default_events: [], default_permissions: { issues: 'write', contents: 'write' },
      description: 'Receive public and private app feedback without giving submitters repository access.',
    };
    const encoded = JSON.stringify(manifest).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    return html(`<h1>GitHub feedback setup</h1><p>Register this app as ${env.GITHUB_OWNER}. Install it only on the two feedback repositories. Issues and screenshot files require write access.</p><form action="https://github.com/settings/apps/new?state=${state}" method="post"><input type="hidden" name="manifest" value="${encoded}"><button>Register GitHub App</button></form>`);
  }
  if (url.pathname === '/setup/callback') {
    if (await config(env, 'app_id')) return html('<p>The GitHub App is already registered.</p>', 409);
    const raw = await config(env, 'setup_state');
    const state = raw ? JSON.parse(raw) as { state: string; until: number } : undefined;
    if (!state || state.until < Date.now() || url.searchParams.get('state') !== state.state) return html('<p>Setup expired. Start again.</p>', 403);
    const code = url.searchParams.get('code');
    if (!code || !/^[a-zA-Z0-9_-]{10,200}$/.test(code)) return html('<p>Missing setup code.</p>', 400);
    const claimed = await env.DB.prepare('DELETE FROM config WHERE key = ? AND value = ?').bind('setup_state', raw).run();
    if (!claimed.meta.changes) return html('<p>Setup already used.</p>', 409);
    const response = await api(run, `/app-manifests/${code}/conversions`, '', 'POST');
    if (!response.ok) return html('<p>GitHub registration failed. Start again.</p>', 502);
    const app = await response.json() as { id: number; slug: string; pem: string; owner: { login: string } };
    if (app.owner?.login?.toLowerCase() !== env.GITHUB_OWNER.toLowerCase() || !/^[a-z0-9-]+$/.test(app.slug) || !app.pem || !app.id) return html('<p>Register the app under the configured GitHub owner.</p>', 403);
    await setConfig(env, 'app_key', await crypt(env, app.pem));
    await setConfig(env, 'app_id', String(app.id));
    return Response.redirect(`https://github.com/apps/${app.slug}/installations/new`, 303);
  }
  if (url.pathname === '/setup/installed') {
    const check = { requestId: crypto.randomUUID(), title: 'Setup check', body: 'Setup check' };
    const publicTarget = await repository(env, { ...check, visibility: 'public' }, run);
    const privateTarget = await repository(env, { ...check, visibility: 'private' }, run);
    return publicTarget && privateTarget ? html('<p>Both GitHub destinations are verified. Send a test report from the app and verify its issue and image.</p>') : html('<p>GitHub installation is not ready.</p>', 503);
  }
  return json({ error: 'Not found.' }, 404);
}
