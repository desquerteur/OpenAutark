// Owns: a local fake of the team's feedback mailbox for runtime/PWA/Electron tests (B-055): Firestore REST create
// (web API key only, 409 when the id exists, no Authorization or cookies accepted), list/get/delete with a bearer
// token, Google's token endpoint checking the service account's RS256 JWT – plus a receiver file the app reads
// (WORKFORCE_FEEDBACK_RECEIVER, unpackaged apps only) with this server as its loopback `endpoint`, the fixture's
// team key and a throw-away service account file for `feedback.setup`.
// `records()` opens the letters with a team key (the fixture's by default) the way the team would read them.
// Never: contacts Google or Firebase, or stands for a deployed mailbox. (Replaces the B-036 GitHub receipt fixture;
// the exported name stays so existing window tests keep their setup.)
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateReceiverKeys, openReport } from '../../../src/runtime/feedback/seal.ts';

export const FIXTURE_PROJECT = 'workforce-feedback-e2e';
export const FIXTURE_API_KEY = 'AIzaSyE2eFakeKeyForLocalTestsOnly-012345';
const TOKEN = 'ya29.e2e-fake-access-token';
const DOCS = `/v1/projects/${FIXTURE_PROJECT}/databases/(default)/documents/feedback`;
const KIND = { bug: 'Bug', idea: 'Idea', change: 'Change', praise: 'Praise' };

function claimsOf(jwt, publicKey) {
  const [header, claims, signature] = String(jwt).split('.');
  if (!signature || !verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))) return undefined;
  return JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
}

/** A readable rendering of an opened report (what the team sees), for assertions on text and facts. */
function render(payload) {
  return [payload.text, '', '---', `Kind: ${KIND[payload.kind] ?? 'Report'}`, `App version: ${payload.appVersion}`, `OS: ${payload.os}`,
    payload.view ? `View: ${payload.view}` : '', `Reported by: ${payload.fromAgent ? 'an agent — untrusted, please verify' : 'the user'}`,
  ].filter((line, index) => line || index < 3).join('\n');
}

export async function feedbackSubmitFixture() {
  const team = generateReceiverKeys();
  const account = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const docs = new Map();
  const log = [];
  let fail = false;
  const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value ?? {})); };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(body);
      const claims = form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' ? claimsOf(form.get('assertion'), account.publicKey) : undefined;
      if (!claims || claims.aud !== 'https://oauth2.googleapis.com/token' || claims.scope !== 'https://www.googleapis.com/auth/datastore') { send(res, 400, { error: 'invalid_grant' }); return; }
      send(res, 200, { access_token: TOKEN, expires_in: 3599, token_type: 'Bearer' }); return;
    }
    if (!url.pathname.startsWith(DOCS)) { send(res, 404, { error: { status: 'NOT_FOUND' } }); return; }
    const id = decodeURIComponent(url.pathname.slice(DOCS.length + 1));
    if (req.method === 'POST' && !id) {
      if (req.headers.authorization || req.headers.cookie || url.searchParams.get('key') !== FIXTURE_API_KEY) { send(res, 403, { error: { status: 'PERMISSION_DENIED' } }); return; }
      const docId = url.searchParams.get('documentId') ?? '';
      const fields = JSON.parse(body).fields ?? {};
      log.push(`create ${docId}`);
      if (docs.has(docId)) { send(res, 409, { error: { code: 409, status: 'ALREADY_EXISTS' } }); return; }
      if (Object.keys(fields).sort().join() !== 'sealed,v' || fields.v?.integerValue !== '1' || docId.length > 64) { send(res, 403, { error: { status: 'PERMISSION_DENIED' } }); return; }
      docs.set(docId, Buffer.from(fields.sealed.bytesValue, 'base64'));
      if (fail) { send(res, 503, { error: { status: 'UNAVAILABLE' } }); return; } // stored, but the sender never hears it
      send(res, 200, { name: `projects/${FIXTURE_PROJECT}/databases/(default)/documents/feedback/${docId}`, fields: { v: { integerValue: '1' } } }); return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { send(res, 401, { error: { status: 'UNAUTHENTICATED' } }); return; }
    if (req.method === 'GET' && !id) {
      const after = url.searchParams.get('pageToken') ?? '';
      const all = [...docs.keys()].sort().filter((doc) => doc > after);
      const size = Number(url.searchParams.get('pageSize') ?? 20);
      const page = all.slice(0, size);
      log.push('list');
      send(res, 200, { documents: page.map((doc) => ({ name: `projects/${FIXTURE_PROJECT}/databases/(default)/documents/feedback/${doc}`, fields: { v: { integerValue: '1' } } })),
        ...(all.length > size ? { nextPageToken: page[page.length - 1] } : {}) });
      return;
    }
    if (req.method === 'GET') {
      log.push(`get ${id}`);
      const bytes = docs.get(id);
      if (!bytes) { send(res, 404, { error: { status: 'NOT_FOUND' } }); return; }
      send(res, 200, { name: `x/${id}`, fields: { v: { integerValue: '1' }, sealed: { bytesValue: bytes.toString('base64') } } }); return;
    }
    if (req.method === 'DELETE') { log.push(`delete ${id}`); docs.delete(id); send(res, 200, {}); return; }
    send(res, 400, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-feedback-fixture-'));
  const receiverFile = path.join(dir, 'receiver.json');
  await writeFile(receiverFile, JSON.stringify({ publicKey: team.publicKey, project: FIXTURE_PROJECT, apiKey: FIXTURE_API_KEY, endpoint: origin }));
  const serviceAccountFile = path.join(dir, 'service-account.json');
  await writeFile(serviceAccountFile, JSON.stringify({
    type: 'service_account', project_id: FIXTURE_PROJECT, private_key_id: 'e2e0001', client_email: `reader@${FIXTURE_PROJECT}.iam.gserviceaccount.com`,
    private_key: account.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://oauth2.googleapis.com/token',
  }));
  return {
    env: { WORKFORCE_FEEDBACK_RECEIVER: receiverFile },
    origin, project: FIXTURE_PROJECT, apiKey: FIXTURE_API_KEY, receiverFile, serviceAccountFile, docs, log,
    /** The letters opened with `privateKey` (default: the fixture's team key); letters for another key are left out. */
    records: async (privateKey = team.privateKey) => {
      const reports = [], images = [];
      for (const [id, sealed] of docs) {
        let payload;
        try { payload = JSON.parse(openReport(privateKey, sealed).toString('utf8')); } catch { continue; }
        reports.push({ ...payload, docId: id, body: render(payload) });
        if (payload.screenshot) images.push(payload.screenshot);
      }
      return { reports, images };
    },
    setFailure: (value) => { fail = value; },
    close: async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
