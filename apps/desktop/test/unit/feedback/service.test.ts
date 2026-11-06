// Owns: local reports, redaction, agent report limits and B-055 sending – sealed for the team, dropped into the
// write-only mailbox, idempotent retries, complete attachments or a local error, an outbox with ciphertext only, the receiver
// file and `feedback.status` (sending / receiving, receiving only for the owner).
// Never: contacts Firebase or GitHub, reads real keys or treats a local save as delivery.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_REPORTS_PER_DAY, FeedbackService } from '../../../src/runtime/feedback/service.ts';
import { redactText } from '../../../src/runtime/feedback/redact.ts';
import { OUTBOX, type FeedbackPayload } from '../../../src/runtime/feedback/delivery.ts';
import { RECEIVER_KEY_ID } from '../../../src/runtime/feedback/inbox.ts';
import { readReceiver } from '../../../src/runtime/feedback/receiver.ts';
import { generateReceiverKeys, openReport } from '../../../src/runtime/feedback/seal.ts';
import { feedbackTools } from '../../../src/runtime/tools/builtin/feedback.ts';
import { register as registerApp } from '../../../src/runtime/rpc/handlers/app.ts';
import { allowedScope, HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { FeedbackReport } from '../../../src/shared/model/system.ts';
import { FEEDBACK_SEALED_LIMIT, SCREENSHOT_DROPPED } from '../../../src/shared/model/feedback-delivery.ts';
import { FeedbackRepo } from '../../../src/runtime/store/feedback.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { API_KEY, PROJECT, fakeMailbox, feedbackEnv, type Env } from './fakes.ts';

const envs: Env[] = [];
after(() => { for (const env of envs) env.cleanup(); });
const DAY = 24 * 60 * 60 * 1000;
const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_phone', capabilities: ['todo', 'chat'], secure: true };

function setup() {
  const env = feedbackEnv();
  envs.push(env);
  const team = generateReceiverKeys();
  const receiver = { publicKey: team.publicKey, project: PROJECT, apiKey: API_KEY };
  const box = fakeMailbox();
  const service = (patch: Partial<ConstructorParameters<typeof FeedbackService>[0]> = {}) => new FeedbackService({ services: () => env.s, receiver, fetch: box.fetch, os: 'win32 10.0.26300 x64', ...patch });
  const opened = (id: string): FeedbackPayload => JSON.parse(openReport(team.privateKey, box.docs.get(id)!).toString('utf8'));
  return { env, team, receiver, box, service, opened };
}

test('redaction removes keys, tokens, passwords, e-mail addresses and user names in paths', () => {
  const input = [
    'key sk-proj-AbCdEfGhIjKlMnOpQrStUv123 and ghp_abcdefghijklmnopqrstuvwxyz0123',
    'Authorization: Bearer abc.def.ghijklmnopqrstuvwxyz',
    'password = hunter2 and passwort: geheim',
    'mail me: max.mustermann@example.de',
    'C:\\Users\\alex\\AppData\\Roaming\\workforce and /home/max/.config and /Users/anna/Library',
    'https://x.test/cb?code=12345&state=ok',
    'card 4111 1111 1111 1111, order 1234567890123',
  ].join('\n');
  const out = redactText(input);
  for (const leaked of ['sk-proj-AbCd', 'ghp_abc', 'abc.def.ghij', 'hunter2', 'geheim', 'max.mustermann', 'alex', '/home/max', 'anna', '12345&', '4111 1111']) {
    assert.equal(out.includes(leaked), false, `${leaked} leaked: ${out}`);
  }
  assert.match(out, /C:\\Users\\\[user\]\\AppData/);
  assert.match(out, /state=ok/);
  assert.match(out, /order 1234567890123/);
  assert.equal(redactText(out), out);
});

test('a report stays local until Send; Send seals text, facts and screenshot for the team – only the team key opens it', async () => {
  const { env, box, service, opened, receiver } = setup();
  const feedback = service();
  const created = feedback.create({ kind: 'bug', text: 'The sidebar flickers at C:\\Users\\alex\\Videos', screenshotFileId: env.shot.id, view: 'chat', author: 'human' });
  assert.equal(created.status, 'local');
  assert.equal(box.calls.length, 0);
  const sent = await feedback.send(created.id, { visibility: 'public' }); // an older client's audience is ignored
  assert.equal(sent.status, 'sent');
  assert.equal(sent.visibility, 'private');
  assert.equal(sent.url, undefined);
  assert.equal(sent.sentAt, env.clock.now());
  assert.match(sent.receiptId!, /^[0-9a-f-]{36}$/);
  assert.deepEqual([...box.docs.keys()], [sent.receiptId], 'the document id is the stable request id');
  const payload = opened(sent.receiptId!);
  assert.deepEqual({ ...payload, screenshot: undefined, diagnostics: undefined }, {
    v: 1, id: sent.receiptId, createdAt: created.createdAt, kind: 'bug', text: 'The sidebar flickers at C:\\Users\\[user]\\Videos',
    appVersion: '0.2.0', os: 'win32 10.0.26300 x64', view: 'chat', screenshot: undefined, diagnostics: undefined,
  });
  assert.match(payload.diagnostics!, /engine failed/, 'B-078: every report carries the redacted log tail');
  assert.equal(payload.screenshot?.mime, 'image/png');
  assert.deepEqual([...Buffer.from(payload.screenshot!.base64, 'base64')], [...env.bytes.value]);
  assert.throws(() => openReport(generateReceiverKeys().privateKey, box.docs.get(sent.receiptId!)!), /could not be opened/);
  assert.equal(receiver.project, PROJECT);
  assert.equal(feedback.list()[0].receiptId, sent.receiptId, 'the receipt survives storage');
  assert.equal((await feedback.send(created.id)).receiptId, sent.receiptId);
  assert.equal(box.calls.length, 1, 'a delivered report is not sent again');
});

test('the outbox holds only the sealed envelope – before, during and after delivery', async () => {
  const { env, box, service } = setup();
  env.setDiagnostics(true);
  const text = 'Unique-plaintext-marker in my report';
  let during = '';
  const feedback = service({ fetch: (async (...args: Parameters<typeof fetch>) => {
    during = JSON.stringify(new KvRepo(env.s.db).list(OUTBOX));
    return box.fetch(...args);
  }) as typeof fetch });
  const created = feedback.create({ kind: 'idea', text, screenshotFileId: env.shot.id, author: 'human' });
  await feedback.send(created.id);
  const base64Shot = Buffer.from(env.bytes.value).toString('base64');
  assert.ok(during.includes('"sealed"'), 'the envelope was stored before the request');
  for (const stored of [during, JSON.stringify(new KvRepo(env.s.db).list(OUTBOX))]) {
    for (const plain of ['Unique-plaintext-marker', base64Shot, 'engine failed', 'win32']) assert.equal(stored.includes(plain), false, plain);
  }
  const after = new KvRepo(env.s.db).get<Record<string, unknown>>(OUTBOX, created.id)!;
  assert.deepEqual(Object.keys(after).sort(), ['deliveredAt', 'project', 'recipient', 'requestId', 'v'], 'only the receipt stays');
});

test('a lost answer: the retry (also after a restart) sends the identical letter under the same id; 409 = it arrived', async () => {
  const { env, box, service } = setup();
  box.state.create = 'lose';
  const created = service().create({ kind: 'idea', text: 'Send once', screenshotFileId: env.shot.id, author: 'human' });
  await assert.rejects(service().send(created.id), /could not be sent right now/);
  assert.equal(new FeedbackRepo(env.s.db).get(created.id)?.status, 'local');
  box.state.create = null;
  const sent = await service().send(created.id); // a new service: like after a restart
  assert.equal(sent.status, 'sent');
  assert.equal(box.docs.size, 1);
  const creates = box.calls.filter((call) => call.method === 'POST');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].body, creates[1].body, 'the same sealed bytes');
  assert.equal(creates[0].url.searchParams.get('documentId'), creates[1].url.searchParams.get('documentId'));
  assert.deepEqual(box.log.filter((line) => line.startsWith('create')), [`create ${sent.receiptId}`, `create ${sent.receiptId}`]);
});

test('an oversized screenshot keeps the complete report local and sends nothing', async () => {
  for (const variant of ['bytes', 'file size'] as const) {
    const { env, box, service } = setup();
    if (variant === 'bytes') env.bytes.value = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(800_000, 7)]); // 1.07 MB as base64
    else env.shot.size = FEEDBACK_SEALED_LIMIT + 1; // known too large: not even read
    const feedback = service();
    const created = feedback.create({ kind: 'bug', text: 'Big screenshot', screenshotFileId: env.shot.id, author: 'human' });
    await assert.rejects(feedback.send(created.id), /screenshot is too large.*complete report is saved/);
    assert.equal(box.calls.length, 0);
    assert.equal(box.docs.size, 0);
    assert.equal(feedback.list()[0].status, 'local');
    assert.equal(feedback.list()[0].screenshotFileId, env.shot.id);
    assert.equal(new KvRepo(env.s.db).get(OUTBOX, created.id), undefined);
  }
});

test('a 600 kB screenshot and maximum-length Unicode feedback fit together in one sealed letter', async () => {
  const { env, box, service, opened } = setup();
  env.bytes.value = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(599_992, 7)]);
  env.shot.size = env.bytes.value.length;
  env.setDiagnostics(true);
  const feedback = service();
  const text = '界'.repeat(20_000);
  const created = feedback.create({ kind: 'bug', text, screenshotFileId: env.shot.id, author: 'human' });
  const sent = await feedback.send(created.id);
  const payload = opened(sent.receiptId!);
  assert.equal(payload.text, text);
  assert.equal(payload.screenshot?.base64, Buffer.from(env.bytes.value).toString('base64'));
  assert.ok(payload.diagnostics);
  assert.ok(box.docs.get(sent.receiptId!)!.length <= FEEDBACK_SEALED_LIMIT);
});

test('a pending text-only envelope made by an older build is not sent again as a complete report', async () => {
  const { env, box, service, receiver } = setup();
  const feedback = service();
  const created = feedback.create({ kind: 'bug', text: 'Big screenshot', screenshotFileId: env.shot.id, author: 'human' });
  new KvRepo(env.s.db).set(OUTBOX, created.id, {
    v: 1, requestId: 'earlier-attempt', project: receiver.project, recipient: receiver.publicKey,
    sealed: Buffer.from('earlier-envelope').toString('base64'), warning: SCREENSHOT_DROPPED,
  }, env.clock.now());
  await assert.rejects(feedback.send(created.id), /earlier submission omitted its screenshot/);
  assert.equal(box.calls.length, 0);
  assert.equal(feedback.list()[0].status, 'local');
});

test('agent reports are marked as such; diagnostics are redacted and always sent (B-078, an old false is not read)', async () => {
  const { service, opened } = setup();
  const feedback = service();
  const agent = feedback.create({ kind: 'bug', text: 'The tool list is cut off', author: 'ag_1', runId: 'run_1' });
  const plain = opened((await feedback.send(agent.id)).receiptId!);
  assert.equal(plain.fromAgent, true);
  assert.match(plain.diagnostics!, /engine failed/, 'includeDiagnostics false in settings.json');
  const human = feedback.create({ kind: 'idea', text: 'Bigger buttons', author: 'human' });
  const withLog = opened((await feedback.send(human.id)).receiptId!);
  assert.equal(withLog.fromAgent, undefined);
  assert.match(withLog.diagnostics!, /engine failed/);
  for (const leaked of ['sk-proj-ABCDEF', 'alex']) assert.equal(withLog.diagnostics!.includes(leaked), false, leaked);
});

test('without a receiver nothing leaves the PC; any audience is accepted and ignored', async () => {
  const { box, service } = setup();
  const feedback = service({ receiver: null });
  const created = feedback.create({ kind: 'bug', text: 'Keep saved', author: 'human' });
  await assert.rejects(feedback.send(created.id), /not set up in this version/);
  await assert.rejects(feedback.send(created.id, { visibility: 'private' }), /not set up in this version/);
  await assert.rejects(feedback.send(created.id, { visibility: 'secret' as never }), /Unknown feedback audience/);
  assert.equal(feedback.list()[0].status, 'local');
  assert.equal(box.calls.length, 0);
});

test('concurrent Send clicks share one request', async () => {
  const { box, service } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const feedback = service({ fetch: (async (...args: Parameters<typeof fetch>) => { await gate; return box.fetch(...args); }) as typeof fetch });
  const created = feedback.create({ kind: 'bug', text: 'Send once', author: 'human' });
  const first = feedback.send(created.id);
  const second = feedback.send(created.id, { visibility: 'private' });
  release();
  assert.equal((await first).receiptId, (await second).receiptId);
  assert.equal(box.calls.length, 1);
});

test('a new receiver (rotated key) before delivery gets a new letter under the same id', async () => {
  const { box, service, receiver } = setup();
  box.state.create = 503;
  const created = service().create({ kind: 'bug', text: 'Rotated', author: 'human' });
  await assert.rejects(service().send(created.id), /could not be sent/);
  box.state.create = null;
  const rotated = generateReceiverKeys();
  const sent = await service({ receiver: { ...receiver, publicKey: rotated.publicKey } }).send(created.id);
  assert.equal(JSON.parse(openReport(rotated.privateKey, box.docs.get(sent.receiptId!)!).toString()).text, 'Rotated');
});

test('older submissions are never sent again; an old plaintext outbox entry is stripped', async () => {
  for (const namespace of ['feedback-delivery', 'feedback-github', OUTBOX]) {
    const { env, box, service } = setup();
    const feedback = service();
    const created = feedback.create({ kind: 'bug', text: 'Earlier submission', author: 'human' });
    new KvRepo(env.s.db).set(namespace, created.id, { origin: 'https://feedback.example', payload: { body: 'Earlier submission' }, receipt: { state: 'received' } }, env.clock.now());
    await assert.rejects(feedback.send(created.id), /cannot be sent again/);
    assert.equal(box.calls.length, 0);
    if (namespace === OUTBOX) assert.equal(JSON.stringify(new KvRepo(env.s.db).get(OUTBOX, created.id)).includes('Earlier submission'), false);
  }
  const { env, service } = setup();
  const repo = new FeedbackRepo(env.s.db);
  repo.save({ id: 'fb_old', kind: 'bug', text: 'B-034 private', author: 'human', context: { version: '1', os: 'x' }, status: 'received', receiptId: crypto.randomUUID(), visibility: 'private', createdAt: 1 });
  await assert.rejects(service().send('fb_old'), /cannot be sent again/);
});

test('the receiver file: resources/feedback/receiver.json, checked; the test override only for an unpackaged app', () => {
  const { env, team } = setup();
  assert.equal(readReceiver(env.s), undefined, 'absent: not set up');
  const file = path.join(env.resources, 'feedback', 'receiver.json');
  writeFileSync(file, '');
  assert.equal(readReceiver(env.s), undefined, 'empty: not set up');
  for (const bad of [{ publicKey: 'x', project: PROJECT, apiKey: API_KEY }, { publicKey: team.publicKey, project: 'Bad_Project', apiKey: API_KEY },
    { publicKey: team.publicKey, project: PROJECT, apiKey: 'short' }, { publicKey: team.publicKey, project: PROJECT, apiKey: API_KEY, endpoint: 'https://evil.example' }]) {
    writeFileSync(file, JSON.stringify(bad));
    assert.equal(readReceiver(env.s), undefined, JSON.stringify(bad));
  }
  writeFileSync(file, JSON.stringify({ publicKey: team.publicKey, project: PROJECT, apiKey: API_KEY }));
  assert.deepEqual(readReceiver(env.s), { publicKey: team.publicKey, project: PROJECT, apiKey: API_KEY });
  assert.deepEqual(new FeedbackService({ services: () => env.s }).status(), { sending: true, receiving: false });
  const other = path.join(env.data, 'other-receiver.json');
  mkdirSync(path.dirname(other), { recursive: true });
  writeFileSync(other, JSON.stringify({ publicKey: team.publicKey, project: 'other-project', apiKey: API_KEY, endpoint: 'http://127.0.0.1:4545' }));
  const previous = process.env.WORKFORCE_FEEDBACK_RECEIVER;
  try {
    process.env.WORKFORCE_FEEDBACK_RECEIVER = other;
    assert.equal(readReceiver(env.s)?.endpoint, 'http://127.0.0.1:4545');
    env.setPackaged(true);
    assert.equal(readReceiver(env.s)?.project, PROJECT, 'a packaged app reads only its shipped file');
  } finally {
    if (previous === undefined) delete process.env.WORKFORCE_FEEDBACK_RECEIVER; else process.env.WORKFORCE_FEEDBACK_RECEIVER = previous;
  }
});

test('feedback.status: sending with a receiver; receiving only with the team key – and only ever for the owner', async () => {
  const { env, service, team } = setup();
  assert.deepEqual(service().status(), { sending: true, receiving: false });
  assert.deepEqual(service({ receiver: null }).status(), { sending: false, receiving: false });
  await env.vault.save({ id: RECEIVER_KEY_ID, label: 'Feedback team key', kind: 'token', value: team.privateKey });
  assert.deepEqual(service().status(), { sending: true, receiving: true });
  const table = new HandlerTable(); registerApp(table);
  const entry = table.get('feedback.status')!;
  assert.equal(allowedScope(entry.scope, PHONE), true);
  assert.equal(allowedScope(entry.scope, { ...PHONE, capabilities: ['todo'] }), false);
  const ctx = (feedback: unknown, scope: ClientScope) => ({ scope, services: env.s, extras: { feedback }, topics: new Set(), signal: new AbortController().signal }) as unknown as HandlerContext;
  assert.deepEqual(await entry.handler(undefined as never, ctx(service(), { kind: 'owner' })), { sending: true, receiving: true });
  assert.deepEqual(await entry.handler(undefined as never, ctx(service(), PHONE)), { sending: true, receiving: false }, 'a phone never learns of the inbox');
  assert.deepEqual(await entry.handler(undefined as never, ctx({ list: () => [] }, { kind: 'owner' })), { sending: false, receiving: false }, 'a service without status never claims sending');
});

test('RPC: chat devices send directly; a To-do-only device cannot send', async () => {
  const { env, box, service } = setup();
  const feedback = service();
  const table = new HandlerTable(); registerApp(table);
  const entry = table.get('feedback.send')!;
  assert.equal(allowedScope(entry.scope, PHONE), true);
  assert.equal(allowedScope(entry.scope, { ...PHONE, capabilities: ['todo'] }), false);
  const created = feedback.create({ kind: 'idea', text: 'From my phone', author: 'human' });
  const ctx = { scope: PHONE, services: env.s, extras: { feedback }, topics: new Set(), signal: new AbortController().signal } as unknown as HandlerContext;
  const sent = await entry.handler({ id: created.id, visibility: 'public' } as never, ctx) as FeedbackReport;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.visibility, 'private');
  assert.equal(box.docs.size, 1);
});

test('dismiss hides a local report; a delivered one cannot be dismissed', async () => {
  const { env, service } = setup();
  const feedback = service();
  const agentReport = feedback.create({ kind: 'bug', text: 'The tool list is cut off', author: 'ag_1' });
  assert.equal(feedback.dismiss(agentReport.id).status, 'dismissed');
  assert.equal(feedback.dismiss(agentReport.id).status, 'dismissed'); // idempotent
  assert.equal(env.events.filter((entry) => entry.event === 'feedback.upserted' && (entry.data as FeedbackReport).status === 'dismissed').length, 1);
  const human = feedback.create({ kind: 'idea', text: 'Bigger buttons', author: 'human' });
  await feedback.send(human.id);
  assert.throws(() => feedback.dismiss(human.id), /already sent/);
  assert.throws(() => feedback.dismiss('fb_missing'), /no longer exists/);
});

function toolContext(env: Env, agentId: string, runId: string): ToolContext {
  return {
    agent: { id: agentId, name: agentId } as ToolContext['agent'], runId, conversationId: 'cv_1', mode: 'standard',
    services: env.s, signal: new AbortController().signal, status: () => undefined,
  };
}

test('feedback.report: redacted, with the run id; repeats within 24 h count; at most 5 per agent per day', async () => {
  const { env } = setup();
  const tool = feedbackTools.find((entry) => entry.name === 'feedback.report')!;
  const file = (text: string, agentId = 'ag_1', runId = 'run_1') => tool.run({ kind: 'bug', text }, toolContext(env, agentId, runId));
  const feedback = new FeedbackService({ services: () => env.s, receiver: null });
  const first = await file('Key sk-proj-AbCdEfGhIjKlMnOpQrStUv123 shows in the log, mail max@example.de');
  assert.equal(first.isError, undefined);
  const stored = feedback.list()[0];
  assert.equal(stored.author, 'ag_1');
  assert.equal(stored.context.runId, 'run_1');
  assert.equal(stored.context.conversationId, 'cv_1');
  assert.equal(stored.status, 'local');
  for (const leaked of ['sk-proj-AbCd', 'max@example.de']) assert.equal(stored.text.includes(leaked), false, stored.text);
  const again = await file('  KEY sk-proj-AbCdEfGhIjKlMnOpQrStUv123   shows IN the log,\n mail max@example.de ', 'ag_1', 'run_2');
  assert.match(again.content[0].type === 'text' ? again.content[0].text : '', /Already reported/);
  env.clock.advance(60_000);
  await file('Key sk-proj-AbCdEfGhIjKlMnOpQrStUv123 shows in the log, mail max@example.de');
  assert.equal(feedback.list().length, 1);
  assert.equal(feedback.list()[0].count, 3);
  for (let index = 2; index <= AGENT_REPORTS_PER_DAY; index += 1) assert.equal((await file(`Distinct problem number ${index}`)).isError, undefined);
  const refused = await file('A sixth distinct problem');
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].type === 'text' ? refused.content[0].text : '', /already filed 5 feedback reports/);
  assert.equal((await file('Distinct problem number 3')).isError, undefined, 'a repeat still counts at the cap');
  assert.equal((await file('Another agent may report', 'ag_2')).isError, undefined);
  assert.ok(feedback.create({ kind: 'bug', text: 'The human is never capped', author: 'human' }));
  env.clock.advance(DAY + 1);
  assert.equal((await file('A sixth distinct problem')).isError, undefined);
  assert.deepEqual([...new Set(env.events.map((entry) => entry.event))], ['feedback.upserted']);
});

test('older browser drafts labelled sent are not treated as confirmed deliveries', () => {
  const { env } = setup();
  const repo = new FeedbackRepo(env.s.db);
  const base: FeedbackReport = { id: 'fb_1', kind: 'bug', text: 'x', author: 'human', context: { version: '1', os: 'x' }, status: 'sent', createdAt: 1 };
  repo.save({ ...base, url: 'https://github.com/teydra/workforce/issues/new?title=old' });
  assert.equal(repo.get('fb_1')?.status, 'queued');
  repo.save({ ...base, receiptId: crypto.randomUUID(), visibility: 'private' });
  assert.equal(repo.get('fb_1')?.status, 'sent');
});
