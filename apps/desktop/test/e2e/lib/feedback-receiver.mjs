// Owns: a real local HTTP receiver with SQLite for desktop/PWA tests; GitHub writes are fixtures.
// Never: contacts GitHub, stores real credentials or publishes the test feedback.
import { createServer } from 'node:http';
import { receiver } from '../../../../../services/feedback/src/worker.ts';
import { databaseFixture } from '../../../../../services/feedback/test/fixture.ts';

export async function startFeedbackReceiver() {
  const { db, binding } = databaseFixture();
  const records = [];
  const worker = receiver({ target: async (_env, payload) => ({ repo: `teydra/fixture-${payload.visibility}`, token: 'fixture-only' }),
    create: async (_run, target, payload) => { records.push(payload); return `https://github.com/${target.repo}/issues/${records.length}`; } });
  const env = { DB: binding, GITHUB_OWNER: 'teydra', PUBLIC_REPO: 'teydra/fixture-public', PRIVATE_REPO: 'teydra/fixture-private', APP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') };
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers,
        ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }) }), env);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, records,
    close: async () => { await new Promise((resolve) => server.close(resolve)); db.close(); } };
}
