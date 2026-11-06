// B-055 Q2: the write-only mailbox request – exact Firestore REST shape (create with documentId, only v and sealed,
// mask so the answer never echoes the letter), no redirects or credentials, 409 = already there, refusals and
// outages without remote details.
// Owns: these assertions. Never: contacts Firebase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSealed } from '../../../src/runtime/feedback/drop.ts';
import { FEEDBACK_SEALED_LIMIT } from '../../../src/shared/model/feedback-delivery.ts';
import { API_KEY, PROJECT, fakeMailbox } from './fakes.ts';

const config = { publicKey: 'A'.repeat(43), project: PROJECT, apiKey: API_KEY };
const id = '6f9619ff-8b86-4011-b42d-00cf4fc964ff';
const sealed = Buffer.from('WFB1-sealed-bytes');

test('create request: POST …/documents/feedback?documentId=<id>&mask.fieldPaths=v&key=…, body {v:1, sealed:bytes}', async () => {
  const box = fakeMailbox();
  assert.equal(await dropSealed(config, id, sealed, box.fetch), 'created');
  const [call] = box.calls;
  assert.equal(call.method, 'POST');
  assert.equal(`${call.url.origin}${call.url.pathname}`, `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/feedback`);
  assert.deepEqual([...call.url.searchParams.keys()], ['documentId', 'mask.fieldPaths', 'key']);
  assert.equal(call.url.searchParams.get('documentId'), id);
  assert.equal(call.url.searchParams.get('mask.fieldPaths'), 'v');
  assert.equal(call.url.searchParams.get('key'), API_KEY);
  assert.deepEqual(call.headers, { 'content-type': 'application/json' }, 'no authorization, no cookies');
  assert.equal(call.init?.redirect, 'error');
  assert.equal(call.init?.credentials, 'omit');
  assert.ok(call.init?.signal, 'a timeout');
  assert.deepEqual(JSON.parse(call.body!), { fields: { v: { integerValue: '1' }, sealed: { bytesValue: sealed.toString('base64') } } });
  assert.deepEqual(box.docs.get(id), sealed);
});

test('409 ALREADY_EXISTS means the letter arrived earlier (idempotent retry)', async () => {
  const box = fakeMailbox();
  await dropSealed(config, id, sealed, box.fetch);
  assert.equal(await dropSealed(config, id, sealed, box.fetch), 'exists');
  assert.equal(box.docs.size, 1);
});

test('refusals and outages are clean errors without remote bodies; nothing is sent for a bad id or an oversized letter', async () => {
  const box = fakeMailbox();
  await assert.rejects(dropSealed({ ...config, apiKey: 'AIzaWrongWrongWrongWrong00000' }, id, sealed, box.fetch), /refused this report/);
  for (const failure of [503, 500, 429, 'throw'] as const) {
    box.state.create = failure;
    await assert.rejects(dropSealed(config, id, sealed, box.fetch), (error: Error) => {
      assert.match(error.message, /could not be sent right now/);
      assert.doesNotMatch(error.message, /UNAVAILABLE|fetch failed/);
      return true;
    });
  }
  const before = box.calls.length;
  await assert.rejects(dropSealed(config, 'a/b', sealed, box.fetch), /Invalid feedback id/);
  await assert.rejects(dropSealed(config, id, Buffer.alloc(FEEDBACK_SEALED_LIMIT + 1), box.fetch), /too large/);
  assert.equal(box.calls.length, before);
});

test('a local fake mailbox answers only on loopback', async () => {
  const box = fakeMailbox({ origin: 'http://127.0.0.1:9' });
  assert.equal(await dropSealed({ ...config, endpoint: 'http://127.0.0.1:9' }, id, sealed, box.fetch), 'created');
  assert.equal(box.calls[0].url.origin, 'http://127.0.0.1:9');
});
