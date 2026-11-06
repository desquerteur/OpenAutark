// Files and settings between the CEO's PCs (devices/sync/files.ts, settings.ts): two temporary data folders on a fake
// mesh. The synced roots arrive whole (and nothing else), a removal travels as a tombstone, a change the data folder's
// watcher hands over goes at once (its tap: also the app's own writes, never in an owner's way); settings travel as
// patches without devices, phone access and the window layout (sync-settings.test.ts: per section). Where Windows
// refuses the rename, the pulled file is copied over the target; a pull that failed leaves the link-up incomplete, so
// the next one offers the file again. A stored file's bytes come from a CEO PC when first needed (blobs.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { FileSync } from '../../../src/runtime/devices/sync/files.ts';
import { needBlob } from '../../../src/runtime/devices/sync/blobs.ts';
import { settingsPatch } from '../../../src/runtime/devices/sync/settings.ts';
import { Stamps } from '../../../src/runtime/devices/sync/stamps.ts';
import { deepMerge } from '../../../src/runtime/settings/validate.ts';
import { RootWatcher, type WatchFn } from '../../../src/runtime/root/watcher.ts';
import { ManualClock, memoryDb, recordingBus, silentLog } from './fakes.ts';

const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

const settingsOf = (name: string, width: number) => ({
  profile: { name }, preferences: { theme: name ? 'dark' : 'system', sidebarWidth: width }, devices: { peer: 'lan', peerPort: width }, pwa: { enabled: false, bind: 'lan' },
}) as unknown as Settings;

type Handlers = Map<string, (params: unknown, from: string) => Promise<unknown>>;

async function makePc(pcs: Map<string, { handlers: Handlers }>, id: string, settings: Settings) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sync-${id}-`));
  const data = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await mkdir(data, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const db = memoryDb();
  const { bus } = recordingBus();
  const repo = new DevicesRepo(db);
  repo.upsert(record(id, { self: true }));
  const handlers = new Map<string, (params: unknown, from: string) => Promise<unknown>>();
  const store = { current: settings };
  const blobs = path.join(data, 'blobs');
  const fileRows = new Set<string>(); // the `files` rows here (blob metadata)
  const s = {
    db, bus, clock: new ManualClock(), log: silentLog, paths: { data, workspace, blobs },
    files: { get: (fileId: string) => (fileRows.has(fileId) ? { id: fileId } : undefined), path: (fileId: string) => path.join(blobs, fileId.slice(0, 2), fileId.slice(2, 4), fileId) },
    settings: { get: () => store.current, update: (patch: unknown) => { store.current = deepMerge(store.current, patch); bus.emit('settings.updated', store.current); return store.current; } },
    devices: {
      online: (peer: string) => pcs.has(peer),
      call: async (peer: string, method: string, params: unknown) => {
        const target = pcs.get(peer);
        if (!target) throw new WorkforceError('unavailable', 'offline');
        return target.handlers.get(method)!(JSON.parse(JSON.stringify(params)), id);
      },
    },
  } as unknown as RuntimeServices;
  const files = new FileSync(s, new Stamps(db, s.clock));
  handlers.set('sync.file', (params, from) => files.receive(params, from));
  const pc = { id, root, data, workspace, repo, files, handlers, store, s, fileRows };
  pcs.set(id, pc);
  return pc;
}
type Pc = Awaited<ReturnType<typeof makePc>>;

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test('settings travel as a patch: devices, phone access and the window layout stay on each PC, a removed key goes', () => {
  const local = { ...settingsOf('', 300), voice: { vocabulary: ['Autark'], ttsVoice: 'old' } } as unknown as Settings;
  const incoming = { profile: { name: 'Lena' }, preferences: { theme: 'dark' }, voice: { vocabulary: ['Autark', 'Teydra'] } };
  assert.deepEqual(settingsPatch(local, incoming), { profile: { name: 'Lena' }, preferences: { theme: 'dark' }, voice: { vocabulary: ['Autark', 'Teydra'], ttsVoice: null } });
  assert.deepEqual(settingsPatch(local, incoming, true), { profile: { name: 'Lena' }, preferences: { theme: 'dark' }, voice: { vocabulary: ['Autark', 'Teydra'] } }, 'at the first link what only this PC has stays');
});

test('synced roots arrive whole, a removal follows, a watcher tap sends a change at once – and the settings come along', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a', settingsOf('Lena', 300));
  const b = await makePc(pcs, 'dev_b', settingsOf('', 260));
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true }); });
  a.repo.upsert(record('dev_b'));
  b.repo.upsert(record('dev_a', { joinedAs: 'ceo' }));
  const put = async (base: string, rel: string, text: string) => { await mkdir(path.dirname(path.join(base, rel)), { recursive: true }); await writeFile(path.join(base, rel), text); };
  await put(a.data, 'agents/ag_1/SYSTEM.md', '# Mara\nWrites.');
  await put(a.data, 'memory/notes/a.md', 'first note');
  await put(a.data, 'theme.css', ':root { --accent: teal; }');
  await put(a.workspace, 'skills/report/SKILL.md', '# Report');
  await put(a.data, 'agents/README.md', 'generated map');
  await put(a.data, 'connectors/status.json', '{}');
  await put(a.data, 'logs/runtime.log', 'never');
  const watcher = new RootWatcher({ root: a.data, clock: a.s.clock, watch: false, debounceMs: 1 }); // the data folder's watcher, without the OS
  watcher.register('memory', () => {});
  a.files.attach((listener) => watcher.tap(listener));
  b.files.attach();

  assert.ok(await a.files.catchUp('dev_b', undefined));
  assert.equal(await readFile(path.join(b.data, 'agents/ag_1/SYSTEM.md'), 'utf8'), '# Mara\nWrites.');
  assert.equal(await readFile(path.join(b.data, 'memory/notes/a.md'), 'utf8'), 'first note');
  assert.equal(await readFile(path.join(b.data, 'theme.css'), 'utf8'), ':root { --accent: teal; }');
  assert.equal(await readFile(path.join(b.workspace, 'skills/report/SKILL.md'), 'utf8'), '# Report');
  for (const rel of ['agents/README.md', 'connectors/status.json', 'logs/runtime.log']) assert.equal(existsSync(path.join(b.data, rel)), false, rel);
  assert.equal(b.store.current.profile.name, 'Lena', 'the PC that joined takes the settings');
  assert.equal((b.store.current.preferences as { sidebarWidth: number }).sidebarWidth, 260, 'its window layout stays');
  assert.equal(b.store.current.devices.peerPort, 260, 'its devices section stays');

  const clock = a.s.clock as ManualClock;
  const cursor = clock.now();
  clock.set(cursor + 1000);
  await rm(path.join(a.data, 'memory/notes/a.md'));
  assert.ok(await a.files.catchUp('dev_b', cursor));
  assert.equal(existsSync(path.join(b.data, 'memory/notes/a.md')), false, 'the removal travels');

  await put(a.data, 'memory/notes/b.md', 'second note');
  watcher.nudge('memory', ['notes', 'b.md']);
  watcher.flush();
  await settle(1300);
  assert.equal(await readFile(path.join(b.data, 'memory/notes/b.md'), 'utf8'), 'second note', 'a change the watcher hands over goes at once');
  watcher.stop();

  a.s.settings.update({ profile: { name: 'Lena Berg' } });
  await settle();
  assert.equal(b.store.current.profile.name, 'Lena Berg', 'a settings change goes at once');
});

test('the data folder watcher\'s tap hears every handed-over path – the app\'s own writes too – and never stops an owner', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-tap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let fire: ((name: string) => void) | undefined;
  const watch: WatchFn = (_target, _options, listener) => {
    fire = (name) => listener('change', name);
    return Object.assign(new EventEmitter(), { close: () => {} }) as unknown as FSWatcher;
  };
  const watcher = new RootWatcher({ root: dir, clock: new ManualClock(), watch, debounceMs: 1, recursive: true });
  const owner: string[] = [];
  const tapped: string[] = [];
  watcher.register('memory', (event) => { owner.push(event.parts?.join('/') ?? '*'); });
  const off = watcher.tap((name, parts) => { tapped.push([name, ...(parts ?? [])].join('/')); });
  watcher.tap(() => { throw new Error('a broken tap'); });
  watcher.start();
  t.after(() => watcher.stop());
  const file = path.join(dir, 'memory', 'a.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'written by the app');
  watcher.wrote(file, 'written by the app');
  const event = (name: string) => { fire!(name); watcher.flush(); };

  event('memory/a.md');
  event('logs/runtime.log');
  assert.deepEqual(owner, [], 'the owner skips the app\'s own write');
  assert.deepEqual(tapped, ['memory/a.md'], 'the tap hears it; a path no owner has is not handed over');

  await writeFile(file, 'edited outside');
  event('memory/a.md');
  assert.deepEqual(owner, ['a.md'], 'a broken tap never stops the owner');
  assert.deepEqual(tapped, ['memory/a.md', 'memory/a.md']);

  off();
  event('memory/a.md');
  assert.equal(tapped.length, 2, 'off ends it');
});

test('where Windows refuses the rename the pulled file is copied over; a failed pull leaves the link-up incomplete and comes again', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a', settingsOf('Lena', 300));
  const b = await makePc(pcs, 'dev_b', settingsOf('', 260));
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true }); });
  a.repo.upsert(record('dev_b'));
  b.repo.upsert(record('dev_a', { joinedAs: 'ceo' }));
  await mkdir(path.join(a.data, 'agents/ag_1'), { recursive: true });
  await writeFile(path.join(a.data, 'agents/ag_1/agent.json'), '{"name":"Mara"}');
  await mkdir(path.join(b.data, 'agents/ag_1'), { recursive: true });
  await writeFile(path.join(b.data, 'agents/ag_1/agent.json'), '{}');
  await utimes(path.join(b.data, 'agents/ag_1/agent.json'), new Date(2026, 0, 1), new Date(2026, 0, 1)); // B's is older

  const refuse = (code: string) => async () => { throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code }); };
  b.files.move = refuse('ENOSPC');
  assert.equal(await a.files.catchUp('dev_b', undefined), false, 'a pull that failed: the link-up is incomplete');
  assert.equal(await readFile(path.join(b.data, 'agents/ag_1/agent.json'), 'utf8'), '{}');
  assert.deepEqual((await readdir(path.join(b.data, 'agents/ag_1'))).filter((name) => name.endsWith('.tmp')), [], 'no temp file stays');

  b.files.move = refuse('EPERM'); // the next link-up (the cursor did not move): the rename is refused, the copy works
  assert.equal(await a.files.catchUp('dev_b', undefined), true);
  assert.equal(await readFile(path.join(b.data, 'agents/ag_1/agent.json'), 'utf8'), '{"name":"Mara"}');
  assert.deepEqual((await readdir(path.join(b.data, 'agents/ag_1'))).filter((name) => name.endsWith('.tmp')), []);
});

test('a stored file\'s bytes come from a CEO PC when first needed – checked by their hash, never from an employee\'s PC', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a', settingsOf('Lena', 300));
  const b = await makePc(pcs, 'dev_b', settingsOf('', 260));
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true }); });
  a.repo.upsert(record('dev_b'));
  b.repo.upsert(record('dev_a', { joinedAs: 'ceo' }));
  const bytes = Buffer.from('a picture of Lena');
  const id = createHash('sha256').update(bytes).digest('hex');
  await mkdir(path.dirname(a.s.files.path(id)), { recursive: true });
  await writeFile(a.s.files.path(id), bytes);
  a.fileRows.add(id);
  b.fileRows.add(id); // its row arrived with the rows (tables.ts), its bytes not yet

  assert.equal(await needBlob(b.s, id), true);
  assert.deepEqual(await readFile(b.s.files.path(id)), bytes, 'the bytes are there');
  assert.equal(await needBlob(b.s, id), true, 'there already: no second pull');
  const other = createHash('sha256').update('nobody has this').digest('hex');
  b.fileRows.add(other);
  assert.equal(await needBlob(b.s, other), false, 'no CEO PC has it');
  assert.equal(existsSync(b.s.files.path(other)), false);
  assert.deepEqual(await readdir(path.join(b.s.paths.blobs, 'tmp')), [], 'no part file stays');

  a.repo.upsert(record('dev_b', { personId: 'per_lena000001' })); // now an employee's PC
  await assert.rejects(a.files.receive({ op: 'blob', id, offset: 0 }, 'dev_b'), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
});
