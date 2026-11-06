// Owns: paired-phone feedback sealed for the team and dropped into a local fake of the Firestore mailbox (B-055),
// the team PC's setup and inbox fetch (open → store → delete). (The overlay plugins and customize requests went with
// the self-change machinery – Umbau Einfachheit.)
// Never: contacts Google, Firebase or GitHub, prints pairing secrets or opens a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { connect, startRuntime } from './lib/runtime-client.mjs';
import { feedbackSubmitFixture } from './lib/feedback-submit.mjs';

/** A tiny valid PNG header (IHDR 4×3) – enough for type sniffing and the image size. */
function png() {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(4, 16);
  bytes.writeUInt32BE(3, 20);
  bytes[24] = 8; bytes[25] = 6;
  return bytes;
}

/** Pairs a phone over the real HTTP pairing route (full access, the default link). */
async function pair(runtime, name) {
  await runtime.client.call('pwa.enable', { enabled: true, bind: 'lan' }); // B-075: no link while only this PC's loopback answers
  const link = await runtime.client.call('pwa.link', { name });
  const secret = decodeURIComponent(new URL(link.url).hash.match(/pair=([^&]+)/)?.[1] ?? '');
  const exchange = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, method: 'pwa.exchange', params: { secret, name } }),
  }).then((response) => response.json());
  assert.ok(exchange.result?.token, 'the secret is exchanged for a device token');
  return exchange.result;
}

test('a phone reports with a screenshot; the team PC fetches it from the mailbox', { timeout: 240_000 }, async (t) => {
  const delivery = await feedbackSubmitFixture();
  t.after(() => delivery.close());
  const runtime = await startRuntime({ env: delivery.env });
  t.after(() => runtime.stop());
  const owner = runtime.client;
  await owner.call('events.subscribe', { topics: ['system', 'tasks'] });
  const pairing = await pair(runtime, 'Feedback phone');
  const phone = await connect(runtime.port, pairing.token, 'pwa');
  t.after(() => phone.close());
  const info = await phone.call('session.info');
  assert.equal(info.kind, 'device');
  assert.ok(info.capabilities.includes('chat'), 'a full phone link includes chat');

  let report;
  await t.test('create with an image: the picked screenshot is uploaded and attached to the report', async () => {
    const image = png();
    const file = await phone.call('files.upload', { name: 'screenshot.png', mime: 'image/png', dataBase64: image.toString('base64') });
    assert.match(file.id, /^[0-9a-f]{64}$/);
    report = await phone.call('feedback.create', { kind: 'bug', text: 'The send button stays grey on my phone.', view: 'chat', screenshotFileId: file.id });
    assert.equal(report.status, 'local');
    assert.equal(report.author, 'human', 'a client report is the person\'s');
    assert.equal(report.screenshotFileId, file.id);
    assert.equal(report.context.view, 'chat');
    const seen = await owner.waitFor('feedback.upserted', (item) => item.id === report.id);
    assert.equal(seen.screenshotFileId, file.id, 'the PC sees the same report');
    await assert.rejects(phone.call('feedback.create', { kind: 'bug', text: 'x', screenshotFileId: 'f'.repeat(64) }), /screenshot was not found/);
  });

  await t.test('send seals the report with the picked image for the team; the mailbox holds ciphertext only', async () => {
    const sent = await phone.call('feedback.send', { id: report.id, visibility: 'public' }); // an older client's audience is ignored
    assert.equal(sent.status, 'sent'); assert.ok(sent.receiptId); assert.equal(sent.url, undefined); assert.equal(sent.visibility, 'private');
    assert.deepEqual([...delivery.docs.keys()], [sent.receiptId], 'the document id is the request id');
    assert.equal(delivery.docs.get(sent.receiptId).includes(Buffer.from('send button')), false, 'no plaintext in the mailbox');
    const records = await delivery.records();
    assert.equal(records.reports.length, 1);
    assert.equal(records.images[0].base64, png().toString('base64'));
    assert.match(records.reports[0].text, /^The send button stays grey on my phone\./);
    assert.equal(records.reports[0].view, 'chat');
    const listed = (await phone.call('feedback.list')).find((item) => item.id === report.id);
    assert.equal(listed.receiptId, sent.receiptId);
    await phone.call('feedback.send', { id: report.id });
    assert.equal(delivery.docs.size, 1, 'a second click creates no second letter');
  });

  await t.test('the team PC: setup stores the key, then the inbox fetches, opens, stores and empties the mailbox', async () => {
    assert.deepEqual(await phone.call('feedback.status'), { sending: true, receiving: false });
    const setup = await owner.call('feedback.setup', { project: delivery.project, apiKey: delivery.apiKey, serviceAccountPath: delivery.serviceAccountFile });
    assert.equal(setup.createdKey, true);
    assert.equal(path.resolve(setup.receiverFile), path.resolve(delivery.receiverFile), 'an unpackaged app writes the receiver it reads');
    assert.match(setup.rules, /allow create: if request\.auth == null/);
    assert.equal(JSON.stringify(setup).includes('PRIVATE KEY'), false);
    assert.deepEqual(await owner.call('feedback.status'), { sending: true, receiving: true });
    assert.deepEqual(await phone.call('feedback.status'), { sending: true, receiving: false }, 'a phone never learns of the inbox');
    await assert.rejects(phone.call('feedback.inboxList'), (error) => error.code === 'forbidden');
    const second = await phone.call('feedback.create', { kind: 'idea', text: 'Please add dark charts.', screenshotFileId: report.screenshotFileId });
    await phone.call('feedback.send', { id: second.id }); // sealed for the new team key
    const fetched = await owner.call('feedback.inboxFetch');
    assert.deepEqual(fetched, { added: 1, unreadable: 1, more: false, total: 1 }, 'the first letter was sealed for the fixture key');
    assert.equal(delivery.docs.size, 0, 'feedback ends up only with the team');
    const items = await owner.call('feedback.inboxList');
    assert.equal(items.length, 1);
    assert.equal(items[0].text, 'Please add dark charts.');
    assert.equal(items[0].kind, 'idea');
    assert.deepEqual(items[0].screenshot, { mime: 'image/png', size: png().length });
    assert.deepEqual(await owner.call('feedback.inboxScreenshot', { id: items[0].id }), { mime: 'image/png', dataBase64: png().toString('base64') });
    const files = (await readdir(path.join(runtime.dataDir, 'feedback-inbox'))).sort();
    assert.deepEqual(files, [`${items[0].id}.json`, `${items[0].id}.png`, 'unreadable']);
    assert.ok(delivery.log.indexOf(`delete ${items[0].id}`) > delivery.log.indexOf(`get ${items[0].id}`));
    await owner.call('feedback.inboxRemove', { id: items[0].id });
    assert.deepEqual(await owner.call('feedback.inboxList'), []);
  });
});
