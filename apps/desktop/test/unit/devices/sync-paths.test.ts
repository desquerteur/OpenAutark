// A file tab of another PC reads and writes there (src/runtime/devices/sync/paths.ts, B-076): read, write and list go
// to that PC and answer with its rules – a save on an old stamp stays a conflict there –, a path without another PC
// (or this PC's own id) stays here, an offline PC says "<name> is offline." at once, a PC that is no CEO link gets
// nothing; a media file stored there comes back with its `files` row taken here like a synced row; a save too large for
// one mesh frame is refused before it goes, a read too large for one answers 'large'. Where a tab is
// scrolled to (positions.ts) goes to the CEO PCs under the tab's shared id and arrives under the local one; a bad value
// is refused, the oldest of too many go.
// Owns: these assertions only. Never: network, Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PathList, PathRead, PathWritten } from '../../../src/shared/api/methods-files.ts';
import type { TabPosition } from '../../../src/shared/api/methods-tabs.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { RemotePaths, remotePathsOf } from '../../../src/runtime/devices/sync/paths.ts';
import { positionOf, POSITIONS_MAX, tabPositions } from '../../../src/runtime/devices/sync/positions.ts';
import { onDevice, PATH_OPS } from '../../../src/runtime/rpc/handlers/files-path.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { link, makePc, Net, settle, type Pc } from './sync-net.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Two linked PCs (B joined A as the CEO's), each with a file store and the forwarding. */
function pair(person?: string) {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b, person);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-remote-paths-'));
  for (const pc of [a, b]) {
    pc.h.services.files = new Blobs({ db: pc.h.db, blobs: path.join(dir, pc.id, 'blobs'), clock: pc.h.clock, log: silent });
    const paths = new RemotePaths(pc.h.services, pc.sync, PATH_OPS);
    pc.handlers.set('files.path', (params, from) => paths.serve(params, from));
    pc.handlers.set('tabs.position', (params, from) => tabPositions(pc.h.services).receive(params, from));
  }
  return { net, a, b, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const ctxOf = (pc: Pc) => ({ services: pc.h.services }) as unknown as HandlerContext;
const code = (wanted: string) => (error: unknown) => error instanceof WorkforceError && error.code === wanted;

test('a file of A, opened on B, is read, saved and listed on A – with A\'s stamps and A\'s conflict', async (t) => {
  const { a, b, dir, net, done } = pair();
  t.after(done);
  const note = path.join(dir, 'on-a.md');
  writeFileSync(note, 'hello from A');
  const read = await onDevice(ctxOf(b), { path: note, device: a.id }, 'read', PATH_OPS.read) as PathRead;
  assert.equal(read.text, 'hello from A');
  assert.ok(net.calls.some((call) => call.method === 'files.path' && call.to === a.id), 'the call went to A');
  assert.equal((await onDevice(ctxOf(b), { path: note, since: read.stamp, device: a.id }, 'read', PATH_OPS.read) as PathRead).state, 'same');

  const saved = await onDevice(ctxOf(b), { path: note, text: 'edited on B', base: read.stamp, device: a.id }, 'write', PATH_OPS.write) as PathWritten;
  assert.equal(readFileSync(note, 'utf8'), 'edited on B');
  await assert.rejects(onDevice(ctxOf(b), { path: note, text: 'stale', base: read.stamp, device: a.id }, 'write', PATH_OPS.write), code('conflict'), 'an old stamp stays a conflict');
  assert.notEqual(saved.stamp, read.stamp);

  const list = await onDevice(ctxOf(b), { path: dir, device: a.id }, 'list', PATH_OPS.list) as PathList;
  assert.ok(list.entries.some((entry) => entry.name === 'on-a.md'));
  const calls = net.calls.length;
  await onDevice(ctxOf(b), { path: note, device: b.id }, 'read', PATH_OPS.read);
  await onDevice(ctxOf(b), { path: note }, 'read', PATH_OPS.read);
  assert.equal(net.calls.length, calls, 'this PC\'s own id, or none: read here');
});

test('an offline PC says so at once; a PC that is no CEO link is refused both ways', async (t) => {
  const { a, b, net, done } = pair();
  t.after(done);
  net.up = false;
  await assert.rejects(remotePathsOf(b.h.services).forward(a.id, 'read', { path: '/x' }), (error: unknown) => code('unavailable')(error) && (error as Error).message === 'dev_a is offline.');
  assert.equal(net.calls.length, 0, 'nothing was sent');
  await assert.rejects(remotePathsOf(b.h.services).forward('dev_nobody', 'read', { path: '/x' }), code('not_found'));

  const employee = pair('pe_1');
  t.after(employee.done);
  await assert.rejects(remotePathsOf(employee.a.h.services).forward(employee.b.id, 'read', { path: '/x' }), code('not_found'), 'an employee\'s PC is not asked');
  await assert.rejects(employee.a.handlers.get('files.path')!({ op: 'read', path: '/x' }, employee.b.id), code('forbidden'), 'and gets nothing');
});

test('a media file of A, opened on B, is stored on A and its row arrives on B with the answer', async (t) => {
  const { a, b, dir, done } = pair();
  t.after(done);
  const video = path.join(dir, 'clip.mp4');
  writeFileSync(video, Buffer.from('not really a video, but bytes'));
  const ref = await onDevice(ctxOf(b), { path: video, device: a.id }, 'store', async () => { throw new Error('not here'); }) as FileRef;
  assert.equal(ref.name, 'clip.mp4');
  assert.equal(a.h.services.files.get(ref.id)?.name, 'clip.mp4', 'A stored it');
  assert.equal(b.h.services.files.get(ref.id)?.name, 'clip.mp4', 'B has its row (its bytes come when shown)');
  await assert.rejects(a.handlers.get('files.path')!({ op: 'store', path: 'relative.mp4' }, b.id), code('bad_request'));
});

test('a tab\'s view position goes to the CEO PCs under the shared id and arrives under the local one', async (t) => {
  const { a, b, done } = pair();
  t.after(done);
  const heard: TabPosition[] = [];
  b.h.bus.on('tabs.position', (position) => heard.push(position));
  tabPositions(a.h.services).report({ tab: 'file:/notes.md', fraction: 0.5, line: 40, from: 'win_a' });
  await settle();
  assert.deepEqual(heard, [{ tab: 'file@dev_a:/notes.md', fraction: 0.5, line: 40, from: 'win_a' }], 'B names A\'s file by A');
  assert.deepEqual(tabPositions(b.h.services).list(), heard);

  const back: TabPosition[] = [];
  a.h.bus.on('tabs.position', (position) => back.push(position));
  tabPositions(b.h.services).report({ tab: 'file@dev_a:/notes.md', fraction: 0.25, from: 'phone_b' });
  tabPositions(b.h.services).report({ tab: 'remote:dev_a:web-1', fraction: 0.1, from: 'phone_b' });
  await settle();
  assert.deepEqual(back.map((position) => position.tab), ['file:/notes.md', 'web-1'], 'A hears them under its own ids');

  assert.equal(positionOf({ tab: 'x', fraction: 3, from: 'w' })?.fraction, 1, 'a fraction is clamped');
  assert.equal(positionOf({ tab: 'x', fraction: 0.1, time: -2, line: 2.7, from: 'w' })?.line, 2);
  assert.equal(positionOf({ tab: 'x', fraction: 0.1, time: -2, from: 'w' })?.time, undefined);
  assert.equal(positionOf({ tab: '', fraction: 0.1, from: 'w' }), undefined);
  assert.equal(positionOf({ tab: 'x', fraction: 'half', from: 'w' }), undefined);
  for (let i = 0; i <= POSITIONS_MAX; i++) tabPositions(a.h.services).report({ tab: `file:/f${i}`, fraction: 0, from: 'w' });
  const kept = tabPositions(a.h.services).list();
  assert.equal(kept.length, POSITIONS_MAX);
  assert.ok(!kept.some((position) => position.tab === 'file:/notes.md'), 'the oldest went');
});

test('a save too large for one frame between the PCs stays here with a clear answer; a read that would not fit says large', async (t) => {
  const { a, b, dir, net, done } = pair();
  t.after(done);
  const note = path.join(dir, 'big.md');
  writeFileSync(note, 'small');
  const calls = net.calls.length;
  await assert.rejects(onDevice(ctxOf(b), { path: note, text: 'x'.repeat(8 * 1024 * 1024), device: a.id }, 'write', PATH_OPS.write),
    (error: unknown) => code('bad_request')(error) && /too large to save on dev_a/.test((error as Error).message));
  assert.equal(net.calls.length, calls, 'nothing was sent (an 8 MiB frame would close the link)');
  assert.equal(readFileSync(note, 'utf8'), 'small');

  writeFileSync(note, '\u0001'.repeat(1_500_000)); // text, but sixfold as JSON
  const read = await onDevice(ctxOf(b), { path: note, device: a.id }, 'read', PATH_OPS.read) as PathRead;
  assert.equal(read.state, 'large');
  assert.equal(read.text, undefined);
  assert.equal(read.size, 1_500_000);
});
