// O6: restoring archived agents (OrgService.restore and RPC agents.restore), the avatar rules
// (image avatars name a stored image, short initials/emoji) and avatar file ids as references,
// agents.update's 'Works on' check (this PC is stored as none, only linked PCs otherwise) and a
// rename from the editor keeping the initials color (the same rule restore follows).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { restoredAgent } from '../../../src/runtime/org/restore.ts';
import { avatarFiles, checkAvatar } from '../../../src/runtime/org/avatar-files.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { PALETTE_SIZE, paletteIndex } from '../../../src/runtime/org/avatar.ts';
import { draftOf, editorPatch } from '../../../src/ui/team/editor-model.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Device } from '../../../src/shared/model/devices.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const TEMPLATES = path.join(RESOURCES, 'agents');
const FILE_A = 'a'.repeat(64);
const FILE_B = 'b'.repeat(64);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function setup() {
  const recorder = recordingBus();
  const time = clock();
  const org = new Org({ db: memoryDb(), bus: recorder.bus, clock: time, templatesDir: TEMPLATES });
  return { org, time, ...recorder };
}

const code = (expected: string) => (error: unknown) => error instanceof WorkforceError && error.code === expected;

test('restore: back under the old manager while active; former reports stay where they are', () => {
  const { org, of, time } = setup();
  const manager = org.ensureSeed()!;
  const lead = org.create({ name: 'Lena Lead', managerId: manager.id, createdBy: 'human' });
  const report = org.create({ name: 'Ravi', managerId: lead.id, createdBy: 'human' });
  org.setStatus(lead.id, 'working', 'drafting');
  org.archive(lead.id);
  assert.equal(org.get(report.id)?.managerId, manager.id, 'archive moved the report up');
  time.advance(5_000);
  const before = of('agent.upserted').length;

  const back = org.restore(lead.id);
  assert.equal(back.archivedAt, undefined);
  assert.equal(back.managerId, manager.id);
  assert.equal(back.status, 'idle');
  assert.equal(back.statusNote, undefined);
  assert.equal(back.updatedAt, time.now());
  assert.ok(org.list().some((agent) => agent.id === lead.id), 'active again');
  assert.equal(org.get(report.id)?.managerId, manager.id, 'former reports are not moved back');
  assert.equal(of('agent.upserted').length, before + 1);
  assert.equal((of('agent.upserted').at(-1) as Agent).id, lead.id);
  assert.deepEqual(org.restore(lead.id), back, 'restoring an active agent changes nothing');
  assert.throws(() => org.restore('ag_missing'), code('not_found'));
});

test('restore: the person when the old manager is archived; an archived space is dropped', () => {
  const { org } = setup();
  const manager = org.ensureSeed()!;
  const brand = org.saveSpace({ name: 'Brand', kind: 'brand' });
  const lead = org.create({ name: 'Lead', managerId: manager.id, createdBy: 'human' });
  const editor = org.create({ name: 'Editor', managerId: lead.id, spaceId: brand.id, createdBy: 'human' });
  const writer = org.create({ name: 'Writer', managerId: lead.id, spaceId: brand.id, createdBy: 'human' });
  org.archive(editor.id);
  org.archive(lead.id);
  const backEditor = org.restore(editor.id);
  assert.equal(backEditor.managerId, undefined, 'its manager is archived: it reports to the person');
  assert.equal(backEditor.spaceId, brand.id, 'an active space is kept');
  org.archive(writer.id);
  org.archiveSpace(brand.id);
  const backWriter = org.restore(writer.id);
  assert.equal(backWriter.managerId, manager.id, 'archiving the lead moved the writer up to the Manager');
  assert.equal(backWriter.spaceId, undefined, 'an archived space is dropped');
});

test('restore: a name taken meanwhile gets a unique variant, generated initials follow', () => {
  const { org } = setup();
  org.ensureSeed();
  const ada = org.create({ name: 'Ada Lovelace', createdBy: 'human' });
  const color = ada.avatar.color;
  org.archive(ada.id);
  org.create({ name: 'Ada Lovelace', createdBy: 'human' });
  const back = org.restore(ada.id);
  assert.equal(back.name, 'Ada Lovelace 2');
  assert.deepEqual(back.avatar, { kind: 'initials', value: 'AL', color });
  const emoji = org.create({ name: 'Emo', createdBy: 'human' });
  org.update(emoji.id, { avatar: { kind: 'emoji', value: '🎬', color: 2 } });
  org.archive(emoji.id);
  org.create({ name: 'Emo', createdBy: 'human' });
  assert.deepEqual(org.restore(emoji.id).avatar, { kind: 'emoji', value: '🎬', color: 2 }, 'custom avatars stay');
});

test('a rename from the editor keeps the picked initials color; the letters follow the name', () => {
  const { org } = setup();
  org.ensureSeed();
  const ada = org.create({ name: 'Ada', createdBy: 'human' });
  const picked = ((ada.avatar.color ?? 0) + 2) % PALETTE_SIZE;
  const colored = org.update(ada.id, editorPatch(ada, { ...draftOf(ada), avatar: { ...ada.avatar, color: picked } }) as Partial<Agent>);
  assert.deepEqual(colored.avatar, { kind: 'initials', value: 'A', color: picked });
  const patch = editorPatch(colored, { ...draftOf(colored), name: 'Grace' });
  assert.deepEqual(patch, { name: 'Grace' }, 'the editor leaves the generated avatar out of a rename');
  assert.deepEqual(org.update(ada.id, patch).avatar, { kind: 'initials', value: 'G', color: picked }, 'the runtime keeps the color');
  const legacy = org.create({ name: 'Lin', createdBy: 'human' });
  org.update(legacy.id, { avatar: { kind: 'initials', value: 'L' } });
  assert.equal(org.get(legacy.id)!.avatar.color, undefined);
  assert.deepEqual(org.update(legacy.id, { name: 'Max' }).avatar, { kind: 'initials', value: 'M', color: paletteIndex(legacy.id) }, 'no stored color: the stable hash color');
});

test('restoredAgent is pure and never keeps itself as its manager', () => {
  const agent = { id: 'ag_1', name: 'A', role: '', avatar: { kind: 'initials', value: 'A' }, instructions: '', mode: 'general', skills: [], modelPolicy: {}, status: 'paused', statusNote: 'x', managerId: 'ag_1', createdBy: 'human', createdAt: 1, updatedAt: 1, archivedAt: 2 } as Agent;
  const next = restoredAgent(agent, { manager: agent, name: 'A', now: 9 });
  assert.equal(next.managerId, undefined);
  assert.equal(next.status, 'idle');
  assert.equal(agent.archivedAt, 2, 'input untouched');
});

test('avatar rules: images name a stored file, initials and emoji stay short; image ids are references', () => {
  const { org } = setup();
  const manager = org.ensureSeed()!;
  assert.throws(() => org.update(manager.id, { avatar: { kind: 'image', value: 'not-a-file' } }), code('bad_request'));
  assert.throws(() => org.update(manager.id, { avatar: { kind: 'emoji', value: '🎬 🎥' } }), code('bad_request'));
  assert.throws(() => org.update(manager.id, { avatar: { kind: 'initials', value: 'ABCDEFGHIJKLMNOPQ' } }), code('bad_request'));
  assert.deepEqual(checkAvatar({ kind: 'emoji', value: ' 👩‍💻 ' }), { kind: 'emoji', value: '👩‍💻' });
  const other = org.create({ name: 'Other', createdBy: 'human' });
  org.update(manager.id, { avatar: { kind: 'image', value: FILE_A } });
  org.update(other.id, { avatar: { kind: 'image', value: FILE_B } });
  org.archive(other.id);
  assert.deepEqual(org.avatarFileIds(), [FILE_A, FILE_B], 'archived agents keep their image referenced');
  assert.deepEqual(avatarFiles([{ avatar: { kind: 'image', value: FILE_A } }, { avatar: { kind: 'image', value: FILE_A } }, { avatar: { kind: 'emoji', value: 'x' } }]), [FILE_A]);
});

function rpcSetup(devices: Device[] = []) {
  const f = rpcFixture({ table: createHandlerTable() });
  const org = new Org({ db: f.db, bus: f.bus, clock: f.clock, templatesDir: TEMPLATES });
  const self = { id: 'dev_self', name: 'Desk', kind: 'pc', role: 'home', fingerprint: '', addresses: [], caps: {}, status: 'online', self: true } as Device;
  Object.assign(f.services, { org, devices: { self: () => self, list: () => [self, ...devices], online: () => true, call: async () => undefined } });
  const manager = org.ensureSeed()!;
  return { ...f, org, manager };
}

const deviceScope = (capabilities: DeviceCapability[]): ClientScope => ({ kind: 'device', deviceId: 'dev_phone', capabilities, secure: true });

test('RPC agents.restore: manage tier, returns the active agent', async (t) => {
  const f = rpcSetup();
  t.after(f.cleanup);
  const lead = f.org.create({ name: 'Lead', managerId: f.manager.id, createdBy: 'human' });
  f.org.archive(lead.id);
  const chatOnly = new TestClient(f.server, deviceScope(['todo', 'chat']));
  assert.equal((await chatOnly.request('agents.restore', { id: lead.id })).error?.code, 'forbidden');
  const phone = new TestClient(f.server, deviceScope(['todo', 'chat', 'tasks', 'settings', 'manage']));
  const back = await phone.call<Agent>('agents.restore', { id: lead.id });
  assert.equal(back.archivedAt, undefined);
  assert.equal(back.managerId, f.manager.id);
  const owner = new TestClient(f.server, OWNER);
  assert.equal((await owner.request('agents.restore', { id: 'ag_missing00001' })).error?.code, 'not_found');
  assert.equal((await owner.request('agents.restore', {})).error?.code, 'bad_request');
});

test('RPC agents.update: an image avatar must be an uploaded image', async (t) => {
  const f = rpcSetup();
  t.after(f.cleanup);
  const owner = new TestClient(f.server, OWNER);
  const text = await f.services.files.put(new TextEncoder().encode('plain text'), 'note.txt');
  const image = await f.services.files.put(new Uint8Array(PNG), 'face.png');
  for (const value of [FILE_A, text.id, 'x']) {
    const response = await owner.request('agents.update', { id: f.manager.id, patch: { avatar: { kind: 'image', value } } });
    assert.equal(response.error?.code, 'bad_request', value);
  }
  const saved = await owner.call<Agent>('agents.update', { id: f.manager.id, patch: { avatar: { kind: 'image', value: image.id } } });
  assert.deepEqual(saved.avatar, { kind: 'image', value: image.id });
  assert.deepEqual(f.org.avatarFileIds(), [image.id]);
});

test("RPC agents.update: 'Works on' takes this PC (stored as none) or a linked PC only", async (t) => {
  const linked = { id: 'dev_lab', name: 'Lab', kind: 'pc', role: 'home', fingerprint: '', addresses: [], caps: {}, status: 'online', self: false } as Device;
  const revoked = { ...linked, id: 'dev_old', name: 'Old', status: 'revoked' } as Device;
  const phone = { ...linked, id: 'dev_phone2', name: 'Phone', kind: 'phone', role: 'client' } as Device;
  const f = rpcSetup([linked, revoked, phone]);
  t.after(f.cleanup);
  const owner = new TestClient(f.server, OWNER);
  const set = (deviceId: string | null) => owner.request('agents.update', { id: f.manager.id, patch: { deviceId } });
  assert.equal(((await set('dev_lab')).result as Agent).deviceId, 'dev_lab');
  assert.equal(((await set('dev_self')).result as Agent).deviceId, undefined, 'this PC is the default');
  for (const value of ['dev_old', 'dev_phone2', 'dev_unknown']) assert.equal((await set(value)).error?.code, 'bad_request', value);
  await set('dev_lab');
  assert.equal(((await set(null)).result as Agent).deviceId, undefined, 'null clears');
});
