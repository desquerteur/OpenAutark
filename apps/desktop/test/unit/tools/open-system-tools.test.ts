// The small tools of the open system: spend.note books into the journal; media.segments keeps a file's parts as lines of a memory note;
// devices.send_file moves a file piece by piece and lands it under a free name, with nothing partial left after a failure.
// Owns: these assertions only. Never: a real mesh or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { receivePiece, sendFile } from '../../../src/runtime/devices/send-file.ts';
import { scopeOfPath } from '../../../src/runtime/knowledge/memory-tree.ts';
import { Spend } from '../../../src/runtime/spend/ledger.ts';
import { marksFile, mediaSegmentTools, partLine, partsIn } from '../../../src/runtime/tools/builtin/media-segments.ts';
import { spendRef, spendTools } from '../../../src/runtime/tools/builtin/spend.ts';
import { validate } from '../../../src/runtime/tools/validate.ts';
import { agent, harness } from '../chat/harness.ts';
import { str } from '../media/fixtures.ts';
import { mediaSetup } from '../media/setup.ts';

test('spend.note: one line says what it was, where the receipt is, when it renews', () => {
  assert.equal(spendRef({ what: ' Domain for the landing page ', receipt: 'order 123', renewal: '2027-11-01' }), 'Domain for the landing page · receipt: order 123 · renews: 2027-11-01');
  assert.equal(spendRef({ what: 'Stock photo' }), 'Stock photo');
});

test('media.segments: a part goes to a line and back, a line typed by hand counts, other text stays out', () => {
  const span = partLine({ startMs: 12_000, endMs: 18_500, text: 'He laughs\nat the joke' });
  assert.equal(span, '- 0:12.0–0:18.5 He laughs at the joke');
  const both = partLine({ startMs: 0, endMs: 1000, region: { x: 0.1, y: 0.2, width: 0.33333333, height: 0.5 }, text: 'Logo' });
  assert.equal(both, '- 0:00.0–0:01.0 [0.1,0.2,0.3333,0.5] Logo');
  const note = ['---', 'title: x', '---', '', 'Marked parts of media:abc.', '', span, both, '- [0.5,0.5,0.1,0.1] Only a region', '- A note without a place'].join('\n');
  const parts = partsIn(note);
  assert.equal(parts.length, 4);
  assert.deepEqual([parts[0].startMs, parts[0].endMs, parts[0].text], [12_000, 18_500, 'He laughs at the joke']);
  assert.deepEqual(parts[1].region, { x: 0.1, y: 0.2, width: 0.3333, height: 0.5 });
  assert.deepEqual([parts[2].startMs, parts[2].region?.x, parts[2].text], [undefined, 0.5, 'Only a region']);
  assert.equal(parts[3].text, 'A note without a place');
});

function pcs(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-send-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const there = path.join(dir, 'there');
  const here = path.join(dir, 'here');
  mkdirSync(here);
  const remoteServices = { paths: { workspace: there }, devices: { list: () => [{ id: 'dev_me', name: 'My/PC' }] } } as never;
  const calls: unknown[] = [];
  let fail = false;
  const services = {
    paths: { workspace: here, data: dir },
    devices: {
      self: () => ({ id: 'dev_me', name: 'MyPC' }),
      list: () => [{ id: 'dev_me', name: 'MyPC', kind: 'pc', status: 'linked', self: true }, { id: 'dev_tower', name: 'Tower', kind: 'pc', status: 'linked' }],
      call: async (_id: string, _method: string, params: unknown) => {
        calls.push(params);
        if (fail && !(params as { abort?: boolean }).abort) throw new Error('the link dropped');
        return receivePiece(remoteServices, params, 'dev_me');
      },
    },
  };
  const ctx = { services, agent: { id: 'ag_a', name: 'A' }, runId: 'run', mode: 'general', signal: new AbortController().signal, status: () => undefined } as never;
  return { here, there, ctx, calls, breakLink: () => { fail = true; } };
}

const textOf = (output: unknown) => JSON.parse((output as { content: Array<{ text: string }> }).content[0].text) as { ok?: boolean; path?: string; bytes?: number; sentTo?: string };

test('devices.send_file: big files in pieces, empty ones too, and it never overwrites', async (t) => {
  const { here, there, ctx, calls } = pcs(t);
  const big = Buffer.alloc(9 * 1024 * 1024, 7);
  writeFileSync(path.join(here, 'big.bin'), big);
  const sent = textOf(await sendFile.run({ to: 'Tower', path: path.join(here, 'big.bin') }, ctx));
  assert.equal(sent.ok, true);
  assert.equal(sent.sentTo, 'Tower');
  assert.equal(sent.bytes, big.length);
  assert.equal(calls.length, 9, 'nine pieces of at most 1 MiB (B-077)');
  assert.equal(sent.path, path.join(there, 'inbox', 'My_PC', 'big.bin'), "under the sending PC's cleaned name");
  assert.ok(readFileSync(sent.path!).equals(big));

  const again = textOf(await sendFile.run({ to: 'Tower', path: path.join(here, 'big.bin') }, ctx));
  assert.equal(path.basename(again.path!), 'big (2).bin');

  writeFileSync(path.join(here, 'empty.txt'), '');
  const empty = textOf(await sendFile.run({ to: 'Tower', path: path.join(here, 'empty.txt') }, ctx));
  assert.equal(readFileSync(empty.path!).length, 0);
});

test('devices.send_file: a failure leaves no partial file, and this PC or a missing file get a plain answer', async (t) => {
  const { here, there, ctx, breakLink } = pcs(t);
  writeFileSync(path.join(here, 'a.txt'), 'hello');
  breakLink();
  await assert.rejects(Promise.resolve(sendFile.run({ to: 'Tower', path: path.join(here, 'a.txt') }, ctx)), /the link dropped/);
  const inbox = path.join(there, 'inbox', 'My_PC');
  assert.deepEqual(existsSync(inbox) ? readdirSync(inbox) : [], []);
  const self = await sendFile.run({ to: 'this', path: path.join(here, 'a.txt') }, ctx) as { isError?: boolean };
  assert.equal(self.isError, true);
  const none = await sendFile.run({ to: 'Tower', path: path.join(here, 'gone.txt') }, ctx) as { isError?: boolean };
  assert.equal(none.isError, true);
});

test('files.put refuses a piece out of order and a bad id', async (t) => {
  const { there } = pcs(t);
  const services = { paths: { workspace: there }, devices: { list: () => [] } } as never;
  const id = '00000000-0000-4000-8000-000000000000';
  await assert.rejects(receivePiece(services, { id: 'x/../y', name: 'a', offset: 0, dataBase64: '' }, 'dev'), /transfer id/);
  await assert.rejects(receivePiece(services, { id, name: 'a', offset: 5, dataBase64: 'aGk=' }, 'dev'), /does not follow/);
  const done = await receivePiece(services, { id, name: '../../evil.txt', offset: 0, dataBase64: 'aGk=', last: true }, 'dev');
  assert.equal(path.dirname(done.path!), path.join(there, 'inbox', 'linked PC'), 'a name cannot climb out of the inbox');
});

test('spend.note: books into the journal, takes a file id as the receipt, loses nothing of the line, and says when 0 books nothing', async () => {
  const h = harness();
  h.org.add(agent('ag_a', 'A'));
  const services = Object.assign(h.services, { spend: new Spend({ services: () => h.services as never }) });
  const tool = spendTools[0];
  const ctx = { services, agent: { id: 'ag_a', name: 'A' } } as never;
  const args = { amount: 12.5, currency: 'eur', what: 'x'.repeat(120), kind: 'subscription' as const, receipt: 'a'.repeat(64), renewal: '2027-11-01' };
  assert.deepEqual(validate(args, tool.inputSchema), []);
  await tool.run(args, ctx);
  const rows = h.db.all<{ amount: number; currency: string; kind: string; ref: string }>('SELECT amount, currency, kind, ref FROM spend');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].amount, rows[0].currency, rows[0].kind], [12.5, 'EUR', 'subscription']);
  assert.ok(rows[0].ref.endsWith('renews: 2027-11-01'));
  const zero = await tool.run({ amount: 0, currency: 'EUR', what: 'Trial' }, ctx) as { isError?: boolean };
  assert.equal(zero.isError, true);
  assert.equal(h.db.all('SELECT id FROM spend').length, 1);
});

test('media.segments: a mark lands in the memory of the chat of its file, reads back with what a cut needs, and goes again', async () => {
  const { h, temp, chat, media, put, attach } = mediaSetup();
  try {
    Object.assign(h.services, { paths: { ...h.services.paths, data: temp.dir } });
    const file = await put(str('a clip'), 'clip.mp4', 'video/mp4');
    attach(chat.id, file);
    const ctx = { services: h.services, agent: { id: 'ag_ada', name: 'Ada' } } as never;
    const tool = mediaSegmentTools[0];
    const answer = (output: unknown) => JSON.parse((output as { content: Array<{ text: string }> }).content[0].text) as { marksFile: string; parts: Array<{ n: number; text: string; start?: number; end?: number; ref: string; ffmpeg?: string }> };
    const marked = answer(await tool.run({ fileId: file.id, text: 'He laughs', start: '0:12', end: '18.5' }, ctx));
    assert.equal(marked.marksFile, marksFile(temp.dir, media.get(file.id)!));
    const rel = path.relative(path.join(temp.dir, 'memory'), marked.marksFile).split(path.sep).join('/');
    assert.deepEqual(scopeOfPath(rel), { scope: 'conversation', scopeId: chat.id }, 'it reaches who reads that chat');
    assert.deepEqual([marked.parts[0].n, marked.parts[0].text, marked.parts[0].start, marked.parts[0].end], [1, 'He laughs', 12, 18.5]);
    assert.match(marked.parts[0].ref, /#t=12\.000,18\.500$/);
    assert.match(marked.parts[0].ffmpeg ?? '', /-ss 12\.000 -to 18\.500/);
    const note = readFileSync(marked.marksFile, 'utf8');
    assert.ok(note.startsWith('---\ntitle: "Parts of clip.mp4"'));
    assert.ok(note.endsWith('\n- 0:12.0–0:18.5 He laughs\n'));
    assert.equal(answer(await tool.run({ fileId: file.id }, ctx)).parts.length, 1, 'read again');
    assert.deepEqual(answer(await tool.run({ fileId: file.id, remove: 1 }, ctx)).parts, []);
    const stranger = await tool.run({ fileId: file.id }, { services: h.services, agent: { id: 'ag_bo', name: 'Bo' } } as never) as { isError?: boolean };
    assert.equal(stranger.isError, true);
  } finally { temp.cleanup(); }
});
