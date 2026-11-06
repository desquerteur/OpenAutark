// The side pane between the CEO's PCs and on the phone (src/runtime/devices/sync/tabs.ts, tabs-map.ts; B-076): a space
// travels in its shared form – A's websites arrive on B as 'remote' panels of A, A's file tabs with device A – and back
// to its local form on A; a change goes once and an unchanged space sends nothing (no ping-pong); closing A's website on
// B closes it on A, even when B's copy is older; a copy that does not name A's own new website leaves it in place (and
// it travels back); a PC offline gets everything at the next link-up; an employee's PC is refused. A PC that just joined
// takes the other's pane even when its person changed its own before that pane came; a website closed on B while apart
// stays closed when A's newer copy reaches B first; a path too long to travel stays on its own PC. The phone reads the
// PC's spaces with its websites as 'remote' panels and writes them back; a tab it opens becomes a website of the PC.
// Owns: these assertions only. Never: network, Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { Stamps } from '../../../src/runtime/devices/sync/stamps.ts';
import { paneTabs, setPaneTabs, TabSync } from '../../../src/runtime/devices/sync/tabs.ts';
import { localId, sharedId, sharedSpace } from '../../../src/runtime/devices/sync/tabs-map.ts';
import type { SideSpaces } from '../../../src/shared/api/workspace-browser.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { ManualClock, memoryDb, recordingBus, silentLog } from './fakes.ts';

const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

interface Pc { id: string; dir: string; s: RuntimeServices; tabs: TabSync; clock: ManualClock; repo: DevicesRepo }
class Net {
  readonly pcs = new Map<string, Pc>();
  readonly calls: Array<{ from: string; to: string; method: string; params: unknown }> = [];
  up = true;
}

function makePc(net: Net, id: string, start: number): Pc {
  const dir = mkdtempSync(path.join(os.tmpdir(), `wf-tabs-${id}-`));
  const db = memoryDb();
  const repo = new DevicesRepo(db);
  repo.upsert(record(id, { self: true }));
  const clock = new ManualClock(start);
  const s = {
    db, clock, log: silentLog, bus: recordingBus().bus, paths: { data: dir },
    devices: {
      online: (peer: string) => net.up && net.pcs.has(peer),
      call: async (peer: string, method: string, params: unknown) => {
        const target = net.pcs.get(peer);
        if (!net.up || !target) throw new WorkforceError('unavailable', 'offline');
        const copy = JSON.parse(JSON.stringify(params)) as unknown;
        net.calls.push({ from: id, to: peer, method, params: copy });
        return target.tabs.receive(copy, id);
      },
    },
  } as unknown as RuntimeServices;
  const pc = { id, dir, s, clock, repo, tabs: new TabSync(s, new Stamps(db, clock)) };
  net.pcs.set(id, pc);
  return pc;
}

/** `b` joins `a` as one of the CEO's PCs (or as an employee of `person`). */
function link(a: Pc, b: Pc, person?: string): void {
  a.repo.upsert(record(b.id, person ? { personId: person } : {}));
  b.repo.upsert(record(a.id, { joinedAs: person ? 'employee' : 'ceo' }));
}

const fileOf = (pc: Pc) => path.join(pc.dir, 'side-tabs.json');
const write = (pc: Pc, spaces: SideSpaces) => writeFileSync(fileOf(pc), `${JSON.stringify({ version: 2, spaces }, null, 1)}\n`);
const read = (pc: Pc): SideSpaces => { try { return (JSON.parse(readFileSync(fileOf(pc), 'utf8')) as { spaces: SideSpaces }).spaces; } catch { return {}; } };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const tabCalls = (net: Net) => net.calls.filter((call) => call.method === 'sync.tabs');

/** Two linked PCs, A (the first) and B (joined A), both attached and caught up. */
async function pair(spacesA: SideSpaces, spacesB?: SideSpaces) {
  const net = new Net();
  const a = makePc(net, 'dev_a', 1_000_000);
  const b = makePc(net, 'dev_b', 1_000_000);
  link(a, b);
  write(a, spacesA);
  if (spacesB) write(b, spacesB);
  const offs = [a.tabs.attach(), b.tabs.attach()];
  await a.tabs.catchUp(b.id);
  await b.tabs.catchUp(a.id);
  await settle();
  const done = () => { for (const off of offs) off(); for (const pc of [a, b]) rmSync(pc.dir, { recursive: true, force: true }); };
  return { net, a, b, done };
}

const A_SPACES: SideSpaces = {
  global: { shown: 'web-a1', tabs: [
    { id: 'web-a1', url: 'https://a.example/' }, { id: 'day', panel: 'day' },
    { id: 'file:/x/notes.md', panel: 'file', path: '/x/notes.md' },
  ] },
};

test('A\'s tabs arrive on B as panels of A, and go back to A\'s own form', async (t) => {
  const { a, b, net, done } = await pair(A_SPACES);
  t.after(done);
  assert.deepEqual(read(b).global, { shown: 'remote:dev_a:web-a1', tabs: [
    { id: 'remote:dev_a:web-a1', panel: 'remote', device: 'dev_a', tab: 'web-a1', url: 'https://a.example/' },
    { id: 'day', panel: 'day' },
    { id: 'file@dev_a:/x/notes.md', panel: 'file', path: '/x/notes.md', device: 'dev_a' },
  ] }, 'a website of A is a remote panel, A\'s file names A');
  assert.deepEqual(read(a).global, A_SPACES.global, 'A keeps its own form');
  assert.equal(tabCalls(net).length, 2, 'the link-up sends each PC\'s spaces once, nothing echoes');

  // B reorders and shows A's file: A gets it in its own form.
  const bGlobal = read(b).global!;
  write(b, { global: { shown: 'file@dev_a:/x/notes.md', tabs: [bGlobal.tabs[2]!, bGlobal.tabs[0]!, bGlobal.tabs[1]!] } });
  b.clock.set(1_000_500);
  b.tabs.changed();
  await settle();
  assert.deepEqual(read(a).global, { shown: 'file:/x/notes.md', tabs: [A_SPACES.global!.tabs[2], A_SPACES.global!.tabs[0], A_SPACES.global!.tabs[1]] });
  assert.equal(tabCalls(net).length, 3, 'one change, one call; A sends nothing back');
});

test('a change goes once; looking again without a change sends nothing', async (t) => {
  const { a, b, net, done } = await pair(A_SPACES);
  t.after(done);
  const before = tabCalls(net).length;
  write(a, { global: { tabs: [...A_SPACES.global!.tabs, { id: 'web-a2', url: 'https://two.example/', by: 'ag_mara' }] } });
  a.clock.set(1_000_100);
  a.tabs.changed();
  a.tabs.changed(); // the watcher once more (main's own save of the same content)
  await settle();
  assert.equal(tabCalls(net).length, before + 1);
  assert.deepEqual(read(b).global!.tabs.at(-1), { id: 'remote:dev_a:web-a2', panel: 'remote', device: 'dev_a', tab: 'web-a2', url: 'https://two.example/', by: 'ag_mara' });
  b.tabs.changed();
  await settle();
  assert.equal(tabCalls(net).length, before + 1, 'what B wrote from A\'s copy is no change of B\'s');
});

test('closing A\'s website on B closes it on A – also when B\'s copy is older than A\'s last change', async (t) => {
  const { a, b, net, done } = await pair({ global: { tabs: [{ id: 'web-a1', url: 'https://a.example/' }, { id: 'web-a2', url: 'https://b.example/' }, { id: 'day', panel: 'day' }] } });
  t.after(done);
  write(b, { global: { tabs: read(b).global!.tabs.filter((tab) => tab.id !== 'remote:dev_a:web-a1') } });
  b.clock.set(1_000_200);
  b.tabs.changed();
  await settle();
  assert.deepEqual(read(a).global!.tabs.map((tab) => tab.id), ['web-a2', 'day'], 'A closed its own tab');

  // Apart for a moment: A changes later than B closes web-a2, so B's copy loses – its close still counts.
  net.up = false;
  write(a, { global: { tabs: [...read(a).global!.tabs, { id: 'work', panel: 'work' }] } });
  a.clock.set(1_000_900);
  a.tabs.changed();
  write(b, { global: { tabs: read(b).global!.tabs.filter((tab) => tab.id !== 'remote:dev_a:web-a2') } });
  b.clock.set(1_000_300);
  b.tabs.changed();
  net.up = true;
  await b.tabs.catchUp(a.id);
  await a.tabs.catchUp(b.id);
  await settle();
  assert.deepEqual(read(a).global!.tabs.map((tab) => tab.id), ['day', 'work'], 'an older copy that closed it still closes it, A\'s own change stays');
  assert.deepEqual(read(b).global!.tabs.map((tab) => tab.id), ['day', 'work'], 'and B gets A\'s change without the closed tab');
});

test('a newer copy that does not name A\'s own new website leaves it in place, and it travels back', async (t) => {
  const { a, b, net, done } = await pair(A_SPACES);
  t.after(done);
  net.up = false;
  write(a, { global: { ...A_SPACES.global!, tabs: [...A_SPACES.global!.tabs, { id: 'web-a3', url: 'https://three.example/' }] } });
  a.clock.set(1_000_100);
  a.tabs.changed(); // B is offline: nothing arrives
  write(b, { global: { tabs: [{ id: 'work', panel: 'work' }, ...read(b).global!.tabs] } });
  b.clock.set(1_000_900); // B's change is the later one
  b.tabs.changed();
  net.up = true;
  await b.tabs.catchUp(a.id);
  await a.tabs.catchUp(b.id);
  await settle();
  assert.deepEqual(read(a).global!.tabs.map((tab) => tab.id), ['work', 'web-a1', 'day', 'file:/x/notes.md', 'web-a3'], 'B\'s order, A\'s new tab at the end');
  assert.deepEqual(read(b).global!.tabs.map((tab) => tab.id), ['work', 'remote:dev_a:web-a1', 'day', 'file@dev_a:/x/notes.md', 'remote:dev_a:web-a3']);
});

test('a PC that joins keeps its own websites; one that was offline gets every space at the link-up', async (t) => {
  const { a, b, done } = await pair(A_SPACES, { global: { tabs: [{ id: 'web-b1', url: 'https://bee.example/' }, { id: 'work', panel: 'work' }] }, 'chat:ch_1': { tabs: [{ id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' }] } });
  t.after(done);
  assert.deepEqual(read(b).global!.tabs.map((tab) => tab.id), ['remote:dev_a:web-a1', 'day', 'file@dev_a:/x/notes.md', 'web-b1'], 'B took A\'s pane and kept its own website');
  assert.deepEqual(read(a).global!.tabs.map((tab) => tab.id), ['web-a1', 'day', 'file:/x/notes.md', 'remote:dev_b:web-b1'], 'which reached A');
  assert.deepEqual(read(a)['chat:ch_1'], { tabs: [{ id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' }] }, 'a space only B had reached A');
});

test('only the CEO\'s own PCs: an employee\'s PC is refused', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a', 1);
  const e = makePc(net, 'dev_e', 1);
  link(a, e, 'pe_1');
  await assert.rejects(a.tabs.receive({ spaces: {} }, e.id), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
  for (const pc of [a, e]) rmSync(pc.dir, { recursive: true, force: true });
});

test('ids travel both ways: websites, paths with their PC, everything else as it is', () => {
  for (const [id, shared] of [['web-x1', 'remote:me:web-x1'], ['file:C:\\a\\b.txt', 'file@me:C:\\a\\b.txt'], ['folder:/srv', 'folder@me:/srv'], ['media:/v/a.mp4', 'media@me:/v/a.mp4'], ['day', 'day'], [`media:${'a'.repeat(64)}`, `media:${'a'.repeat(64)}`], ['remote:other:web-y', 'remote:other:web-y'], ['file@other:/z', 'file@other:/z']] as const) {
    assert.equal(sharedId(id, 'me'), shared, id);
    assert.equal(localId(shared, 'me'), id, shared);
  }
  const long = `https://long.example/${'p'.repeat(1600)}`;
  assert.equal(sharedSpace({ tabs: [{ id: 'web-l', url: long }] }, 'me').tabs[0]!.url, 'https://long.example/', 'a long address is shortened to its site (main\'s panel limit)');
});

test('the phone reads the PC\'s spaces with its websites as remote panels and writes them back', (t) => {
  const net = new Net();
  const pc = makePc(net, 'dev_pc', 1);
  t.after(() => rmSync(pc.dir, { recursive: true, force: true }));
  write(pc, { global: { shown: 'web-1', tabs: [{ id: 'web-1', url: 'https://one.example/', by: 'ag_1' }, { id: 'web-2', url: 'https://two.example/' }, { id: 'file:/a.md', panel: 'file', path: '/a.md' }, { id: 'remote:dev_o:web-9', panel: 'remote', device: 'dev_o', tab: 'web-9', url: 'https://other.example/' }] } });
  const pane = paneTabs(pc.s);
  assert.equal(pane.device, 'dev_pc');
  assert.deepEqual(pane.spaces.global, { shown: 'remote:dev_pc:web-1', tabs: [
    { id: 'remote:dev_pc:web-1', panel: 'remote', device: 'dev_pc', tab: 'web-1', url: 'https://one.example/', by: 'ag_1' },
    { id: 'remote:dev_pc:web-2', panel: 'remote', device: 'dev_pc', tab: 'web-2', url: 'https://two.example/' },
    { id: 'file:/a.md', panel: 'file', path: '/a.md' },
    { id: 'remote:dev_o:web-9', panel: 'remote', device: 'dev_o', tab: 'web-9', url: 'https://other.example/' },
  ] }, 'the PC\'s own file stays as it is');

  // The phone closes web-2 and the other PC's tab, reorders, opens a new website and a new address it cannot keep.
  const [one, , file] = pane.spaces.global!.tabs;
  setPaneTabs(pc.s, { global: { shown: 'remote:dev_pc:web-new', tabs: [file, one, { id: 'remote:dev_pc:web-new', panel: 'remote', device: 'dev_pc', tab: 'web-new', url: 'https://new.example/' }, { id: 'remote:dev_pc:web-bad', panel: 'remote', device: 'dev_pc', tab: 'web-bad', url: 'ftp://no.example/' }] } }, ['remote:dev_pc:web-2', 'remote:dev_o:web-9']);
  assert.deepEqual(read(pc).global, { shown: 'web-new', tabs: [
    { id: 'file:/a.md', panel: 'file', path: '/a.md' },
    { id: 'web-1', url: 'https://one.example/', by: 'ag_1' },
    { id: 'web-new', url: 'https://new.example/' },
  ] }, 'the PC\'s own websites keep their entries; the new one is the PC\'s now');

  // A stale phone copy that does not name a website the PC opened meanwhile leaves it.
  write(pc, { global: { tabs: [...read(pc).global!.tabs, { id: 'web-3', url: 'https://three.example/' }] } });
  setPaneTabs(pc.s, { global: { tabs: [{ id: 'day', panel: 'day' }] } }, []);
  assert.deepEqual(read(pc).global!.tabs.map((tab) => tab.id), ['day', 'web-1', 'web-new', 'web-3']);
});

test('a PC that just joined: what its person changes before the other\'s pane came stays at 0, so the pane it joined wins', async (t) => {
  const net = new Net();
  const a = makePc(net, 'dev_a', 1_000_000);
  const b = makePc(net, 'dev_b', 1_000_000);
  link(a, b);
  write(a, A_SPACES);
  write(b, { global: { tabs: [{ id: 'day', panel: 'day' }] } });
  const offs = [a.tabs.attach(), b.tabs.attach()];
  t.after(() => { for (const off of offs) off(); for (const pc of [a, b]) rmSync(pc.dir, { recursive: true, force: true }); });
  // The link-up is still busy (a first one carries all of A's rows): B's person opens a tab meanwhile.
  write(b, { global: { shown: 'work', tabs: [{ id: 'day', panel: 'day' }, { id: 'work', panel: 'work' }] } });
  b.clock.set(1_000_500);
  b.tabs.changed();
  await settle();
  assert.deepEqual(read(a).global, A_SPACES.global, 'A\'s pane stays as it is');
  await a.tabs.catchUp(b.id);
  await b.tabs.catchUp(a.id);
  await settle();
  assert.deepEqual(read(a).global, A_SPACES.global, 'also after the link-up: A\'s file tab and shown tab are there');
  assert.deepEqual(read(b).global!.tabs.map((tab) => tab.id), ['remote:dev_a:web-a1', 'day', 'file@dev_a:/x/notes.md'], 'B took the pane it joined');

  // Once A's pane is there, B's changes are B's own again.
  write(b, { global: { tabs: [...read(b).global!.tabs, { id: 'work', panel: 'work' }] } });
  b.clock.set(1_000_900);
  b.tabs.changed();
  await settle();
  assert.deepEqual(read(a).global!.tabs.map((tab) => tab.id), ['web-a1', 'day', 'file:/x/notes.md', 'work']);
});

test('a website of A closed on B while apart stays closed when A\'s newer pane reaches B first', async (t) => {
  const { a, b, net, done } = await pair({ global: { tabs: [{ id: 'web-a1', url: 'https://a.example/' }, { id: 'day', panel: 'day' }] } });
  t.after(done);
  net.up = false;
  write(b, { global: { tabs: read(b).global!.tabs.filter((tab) => tab.id !== 'remote:dev_a:web-a1') } });
  b.clock.set(1_000_300);
  b.tabs.changed(); // A is offline: the close stays on B
  write(a, { global: { tabs: [...read(a).global!.tabs, { id: 'work', panel: 'work' }] } });
  a.clock.set(1_000_900);
  a.tabs.changed();
  net.up = true;
  await a.tabs.catchUp(b.id); // A's newer copy arrives before B's link-up sent anything
  await b.tabs.catchUp(a.id);
  await settle();
  assert.deepEqual(read(b).global!.tabs.map((tab) => tab.id), ['day', 'work'], 'the closed tab does not come back on B');
  assert.deepEqual(read(a).global!.tabs.map((tab) => tab.id), ['day', 'work'], 'and A closed it');
});

test('a path too long to travel with its PC\'s name stays on its own PC, kept there by every copy', async (t) => {
  const long = `/x/${'d'.repeat(586)}.md`; // 'file:' + 592 fits main's 600 here; 'file@dev_a:' + 592 does not
  const spaces: SideSpaces = { global: { shown: 'day', tabs: [{ id: 'web-a1', url: 'https://a.example/' }, { id: 'day', panel: 'day' }, { id: `file:${long}`, panel: 'file', path: long }] } };
  const { a, b, done } = await pair(spaces);
  t.after(done);
  assert.deepEqual(read(a).global, spaces.global, 'A keeps it after the link-up');
  assert.deepEqual(read(b).global!.tabs.map((tab) => tab.id), ['remote:dev_a:web-a1', 'day'], 'B never gets it');
  assert.equal(sharedSpace(spaces.global, 'dev_a').tabs.length, 2, 'it does not travel');

  const onB = read(b).global!.tabs;
  write(b, { global: { shown: 'day', tabs: [onB[1]!, onB[0]!] } });
  b.clock.set(1_000_500);
  b.tabs.changed();
  await settle();
  assert.deepEqual(read(a).global!.tabs.map((tab) => tab.id), ['day', 'web-a1', `file:${long}`], 'B\'s order, the long path kept at the end');
});
