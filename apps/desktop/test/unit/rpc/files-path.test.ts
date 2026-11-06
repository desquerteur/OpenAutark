// files.readPath / writePath / listPath behind the pane's file tab: anywhere on the PC, for the owner and a phone holding
// 'manage' on a secure transport (B-076: its pane is the PC's; never over plain LAN http); what is text, what only says
// what it is; a save on an old stamp is a conflict.
// And files.openPath's `anywhere`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PathList, PathRead, PathWritten } from '../../../src/shared/api/methods-files.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { LIST_MAX_ENTRIES, register, TEXT_MAX_BYTES } from '../../../src/runtime/rpc/handlers/files-path.ts';
import { OWNER, PHONE, S1_MODULES, TestClient, rpcFixture } from './s1-helpers.ts';

function setup() {
  const table = new HandlerTable();
  for (const add of [...S1_MODULES, register]) add(table);
  const fixture = rpcFixture({ table });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-files-path-')); // outside the workspace and the data folder
  return { ...fixture, dir, owner: new TestClient(fixture.server, OWNER), phone: new TestClient(fixture.server, PHONE), cleanup: () => { fixture.cleanup(); rmSync(dir, { recursive: true, force: true }); } };
}

test('readPath says what a path holds, anywhere on the PC', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const read = (file: string, since?: string) => f.owner.call<PathRead>('files.readPath', { path: file, ...(since === undefined ? {} : { since }) });
  const note = path.join(f.dir, 'note.md');
  writeFileSync(note, '﻿hello\r\n');
  const text = await read(note);
  assert.equal(text.state, 'text');
  assert.equal(text.text, '﻿hello\r\n', 'BOM and line ends arrive as they are');
  assert.equal((await read(note, text.stamp)).state, 'same');
  assert.equal((await read(note, text.stamp)).text, undefined);
  writeFileSync(note, 'longer text');
  assert.equal((await read(note, text.stamp)).state, 'text');

  const binary = path.join(f.dir, 'a.bin');
  writeFileSync(binary, Buffer.from([0x41, 0, 0x42]));
  assert.equal((await read(binary)).state, 'binary');
  writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x41]));
  assert.equal((await read(binary)).state, 'binary', 'not UTF-8');

  const large = path.join(f.dir, 'large.log');
  writeFileSync(large, Buffer.alloc(TEXT_MAX_BYTES + 1, 0x61));
  const big = await read(large);
  assert.equal(big.state, 'large');
  assert.equal(big.text, undefined);

  assert.equal((await read(path.join(f.dir, 'nope', 'x.md'))).state, 'missing');
  assert.equal((await read(path.join(f.dir, 'nope.md'), '')).state, 'same', 'still missing');
  assert.equal((await read(f.dir)).state, 'folder');
  assert.equal((await f.owner.request('files.readPath', { path: 'relative/x.md' })).error?.code, 'bad_request');
});

test('writePath writes, creates folders and refuses a save on an old stamp', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const file = path.join(f.dir, 'deep', 'er', 'a.txt');
  const first = await f.owner.call<PathWritten>('files.writePath', { path: file, text: 'one\ttwo\r\n\u0001', base: '' });
  assert.equal(readFileSync(file, 'utf8'), 'one\ttwo\r\n\u0001', 'control characters and line ends stay');
  assert.equal(first.size, statSync(file).size);
  const second = await f.owner.call<PathWritten>('files.writePath', { path: file, text: 'three', base: first.stamp });
  assert.equal(readFileSync(file, 'utf8'), 'three');
  utimesSync(file, new Date(), new Date(Date.now() + 5000)); // someone else changed it
  assert.equal((await f.owner.request('files.writePath', { path: file, text: 'late', base: second.stamp })).error?.code, 'conflict');
  assert.equal(readFileSync(file, 'utf8'), 'three');
  await f.owner.call('files.writePath', { path: file, text: 'mine' }); // no base: the person's answer to the notice
  assert.equal(readFileSync(file, 'utf8'), 'mine');
  assert.equal((await f.owner.request('files.writePath', { path: f.dir, text: 'x' })).error?.code, 'conflict');
  assert.equal((await f.owner.request('files.writePath', { path: file })).error?.code, 'bad_request');
});

test('listPath lists folders first, says what is above and that a folder is missing', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  writeFileSync(path.join(f.dir, 'b.md'), '');
  writeFileSync(path.join(f.dir, 'a10.md'), '');
  writeFileSync(path.join(f.dir, 'a9.md'), '');
  mkdirSync(path.join(f.dir, 'z'));
  const list = await f.owner.call<PathList>('files.listPath', { path: f.dir });
  assert.deepEqual(list.entries.map((entry) => entry.name), ['z', 'a9.md', 'a10.md', 'b.md']);
  assert.deepEqual(list.entries.map((entry) => entry.folder), [true, false, false, false]);
  assert.equal(list.entries[0].path, path.join(f.dir, 'z'));
  assert.equal(list.parent, path.dirname(f.dir));
  assert.equal(list.total, 4);
  const root = await f.owner.call<PathList>('files.listPath', { path: path.parse(f.dir).root });
  assert.equal(root.parent, undefined, 'nothing above a root');
  assert.equal((await f.owner.call<PathList>('files.listPath', { path: path.join(f.dir, 'gone') })).missing, true);
  assert.equal((await f.owner.request('files.listPath', { path: path.join(f.dir, 'b.md') })).error?.code, 'conflict');
  assert.ok(LIST_MAX_ENTRIES >= 1000);
});

test('the three methods are for the person on the PC and a phone holding manage on a secure transport', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  for (const method of ['files.readPath', 'files.listPath']) assert.equal((await f.phone.request(method, { path: f.dir })).error?.code, 'forbidden');
  assert.equal((await f.phone.request('files.writePath', { path: path.join(f.dir, 'x'), text: 'x' })).error?.code, 'forbidden');
  const lan = new TestClient(f.server, { kind: 'device', deviceId: 'dev_lan', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage'], secure: false });
  for (const [method, params] of [['files.readPath', { path: f.dir }], ['files.listPath', { path: f.dir }], ['files.writePath', { path: path.join(f.dir, 'lan.md'), text: 'x' }]] as const) {
    const refused = await lan.request(method, params);
    assert.equal(refused.error?.code, 'forbidden', `${method} over plain LAN http`);
    assert.equal(refused.error?.details?.needsSecure, true);
  }
  assert.throws(() => statSync(path.join(f.dir, 'lan.md')), 'nothing was written');
  const full = new TestClient(f.server, { kind: 'device', deviceId: 'dev_full', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage'], secure: true });
  await full.call<PathWritten>('files.writePath', { path: path.join(f.dir, 'from-phone.md'), text: 'typed on the phone' });
  assert.equal((await full.call<PathRead>('files.readPath', { path: path.join(f.dir, 'from-phone.md') })).text, 'typed on the phone');
  assert.ok((await full.call<PathList>('files.listPath', { path: f.dir })).entries.some((entry) => entry.name === 'from-phone.md'));
});

test('files.openPath reaches the whole PC only when asked to, and still only shows what can run', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const report = path.join(f.dir, 'report.pdf');
  writeFileSync(report, '%PDF-1.4');
  const script = path.join(f.dir, 'run.bat');
  writeFileSync(script, 'echo hi');
  assert.equal((await f.owner.request('files.openPath', { path: report })).error?.code, 'forbidden');
  await f.owner.call('files.openPath', { path: report, anywhere: true });
  assert.equal(f.opened.length, 1);
  assert.equal((await f.owner.request('files.openPath', { path: script, anywhere: true })).error?.code, 'forbidden');
  await f.owner.call('files.openPath', { path: script, anywhere: true, reveal: true });
  assert.equal(f.opened.length, 2);
});
