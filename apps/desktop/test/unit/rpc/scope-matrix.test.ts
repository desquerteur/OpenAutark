// DEV2 scope matrix: every owner-only RPC method is on an explicit PC-local allow-list (so a new
// method must choose a tier), the spec's chat / manage / permissions lists are registered with
// those rules, and session.info reports exactly what the server enforces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { sessionInfo } from '../../../src/runtime/rpc/handlers/session.ts';
import { allowedScope, scopeDenial } from '../../../src/runtime/rpc/table.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { OWNER, TestClient, rpcFixture } from './s1-helpers.ts';

/** Owner-only methods and why they stay on the PC. Adding an owner-only method means adding it here. */
const PC_LOCAL: Record<string, string> = {
  'system.resources': 'PC diagnostics',
  'system.restartReadiness': 'desktop updater',
  'system.prepareRestart': 'desktop updater',
  'system.backup': 'paths on this PC',
  'system.restore': 'paths on this PC',
  'system.root': 'the data folder of this PC and its map (B-044)',
  'files.open': 'opens a file on this PC',
  'files.openPath': 'opens a file on this PC',
  'pages.list': 'the views in the pages folder of this PC',
  'pages.read': 'the views in the pages folder of this PC',
  'import.legacy': 'reads a path on this PC',
  'onboarding.reset': 'desktop first run ("Set up team again")',
  'onboarding.start': "desktop first run: the app's start text in the Manager's chat (B-044)",
  'computer.preview': "screenshot of this PC's screen",
  'browser.subscribe': "live view of this PC's agent browsers (MP8)",
  'browser.unsubscribe': "live view of this PC's agent browsers (MP8)",
  'knowledge.forget': 'permanent deletion of knowledge – only the person on the PC (CTX5)',
  'secrets.openFolder': 'opens the secrets folder of this PC (B-044)',
  'system.restoreStatus': 'backup paths on this PC (MM7)',
  'system.restartRuntime': 'restarts the runtime on this PC (MM7)',
  'bridges.linkOwner': 'messenger bridges hold bot tokens (C9)',
  'bridges.unlinkOwner': 'messenger bridges hold bot tokens (C9)',
  'media.uses': 'stored files are deleted only on this PC (MM6)',
  'media.delete': 'stored files are deleted only on this PC (MM6)',
  // B-055: the team's feedback inbox (other people's reports) and its setup (keys into the vault) stay on the team's PC.
  'feedback.inboxList': 'team feedback inbox (B-055)',
  'feedback.inboxFetch': 'team feedback inbox (B-055)',
  'feedback.inboxRemove': 'team feedback inbox (B-055)',
  'feedback.inboxScreenshot': 'team feedback inbox (B-055)',
  'feedback.setup': 'writes the team feedback key into the vault (B-055)',
  // B-055 Q8: the person's named pointer – the owner at the app; people of the organisation through their person variant (their chats' browsers), never a phone.
  'pointers.point': "the person's named pointer on this PC's browsers and screen (B-055)",
  'pointers.list': "the named pointers of a surface on this PC (B-055)",
  // F-52: managing people of the organisation and admitting their devices stays with the owner on the PC.
  'people.save': 'people administration (F-52)',
  'people.invite': 'people administration (F-52)',
  'people.closeInvite': 'people administration (F-52)',
  'people.revoke': 'people administration (F-52)',
  'people.removeDevice': 'people administration (F-52)',
  'people.audit': 'people administration (F-52)',
  'people.chats': 'people administration (F-52)',
  'people.directChat': 'the owner’s 1:1 chat with a person (F-52)',
  'people.join': 'tokenless join of a person’s device (F-52, rpc/tokenless.ts)',
  'people.awaitJoin': 'tokenless join of a person’s device (F-52, rpc/tokenless.ts)',
  'models.uses': 'which provider account of this PC serves each model use',
  'catalog.refresh': 'provider and catalog fetches from this PC',
  'devices.list': 'device mesh administration',
  'devices.rename': 'device mesh administration',
  'devices.revoke': 'device mesh administration',
  'remote.state': 'Remote: device mesh administration',
  'remote.connect': 'Remote: device mesh administration',
  'remote.cancel': 'Remote: device mesh administration',
  'remote.decide': 'Remote: device mesh administration (CEO or employee)',
  'remote.relay': 'Remote: the meeting server state (device mesh administration)',
  'remote.nearby': 'Remote: PCs found in this PC\'s network (device mesh administration, B-044)',
  'pwa.state': 'phone access administration',
  'pwa.enable': 'phone access administration',
  'pwa.link': 'phone access administration',
  'pwa.revoke': 'phone access administration',
  'bridges.list': 'messenger bridges hold bot tokens',
  'bridges.connectTelegram': 'messenger bridges hold bot tokens',
  'bridges.disconnect': 'messenger bridges hold bot tokens',
  'chats.delete': 'destructive: desktop only',
  'chats.export': 'writes chat folders and their files to a folder of this PC (B-050 K8)',
  'skills.delete': 'destructive: desktop only',
  'secrets.delete': 'destructive: desktop only',
  'modes.save': "the person's own modes – only on the PC (CTX8)",
  'secrets.deleteGroup': 'destructive: desktop only (X05)',
  'secrets.export': 'writes every chosen value in plain text into a file on this PC (04.11.2026)',
  'modes.delete': "the person's own modes – only on the PC (CTX8)",
  'modes.openFolder': "opens the folder of the person's own modes in this PC's file manager (B-044)",
  'patterns.import': 'fetches a team pattern from a link or reads a picked file – only the person on the PC (F-51)',
  'patterns.refresh': 'fetches an imported team pattern again – only the person on the PC (F-51)',
  'repair.state': 'start problem and pre-update copies of this PC (repair screen)',
  'repair.retry': 'restarts this PC\'s runtime from the repair screen',
  'repair.restore': 'replaces this PC\'s database with a pre-update copy',
  'repair.diagnostics': 'writes a diagnostics file on this PC',
  'privacy.providerHistories': "this PC's provider accounts and their stored sessions (wave 2)",
  'privacy.purgeProviderHistory': "deletes a Claude Code account's stored sessions through its CLI – only the person on the PC (wave 2)",
  // B-044 AGENT-HOME: an agent's home project is a folder of this PC.
  'agents.setHome': "an agent's home project is a folder of this PC (B-044)",
  'agents.openHome': "opens an agent's home project folder in this PC's file manager (B-044)",
  // B-041 My day: connected calendars hold credentials of this PC (an ICS address in the vault, the Google sign-in).
  'calendar.addIcs': 'an ICS address is a credential kept in this PC\'s vault (B-041)',
  'calendar.updateSource': 'connected calendars are managed on this PC (B-041)',
  'calendar.removeSource': 'connected calendars are managed on this PC (B-041)',
  'calendar.sync': 'syncs this PC\'s connected calendars with their accounts (B-041)',
  'calendar.google': 'the Google sign-in of this PC (B-041)',
  'calendar.connectGoogle': 'opens the Google consent in this PC\'s browser (B-041)',
  // B-078 (D20): the owner sees a person's calendar on their page; Fill login types a login into this PC's own browser.
  'calendar.person': 'a person\'s calendar for the owner\'s person page, asked on their linked PC (B-078)',
  'secrets.fillChoices': 'the logins listed in this PC\'s own browser page menu (B-078)',
  'secrets.fillLogin': 'a login\'s values typed into this PC\'s own browser (B-078)',
  'voice.pullLocal': 'downloads a local speech model to this PC and chooses it (B-047 D14)',
  // Connectors: a sign-in opens in this PC's browser (apps.list is 'settings').
  'apps.reconnect': 'opens an app\'s sign-in in this PC\'s browser (B-052)',
  // B-072: several companies on one PC, each with a data folder of its own.
  'companies.list': 'the data folders of the companies on this PC (B-072)',
  'companies.open': 'opens a company window on this PC (B-072)',
  'companies.tool': 'runs an agent tool for another company of this PC, over loopback with its owner token (B-075)',
  'phone.pairLink': 'this PC\'s Remote ID and the QR of its pair link (B-078)',
  // AF-013: what an agent may do on this PC is the person's decision on this PC – never a device's, never an agent's.
  'access.set': 'an agent\'s access mode and rules on this PC (AF-013)',
  'access.setChatMode': 'a chat\'s access mode on this PC (AF-013)',
  'access.setRunMode': 'a running run\'s access mode on this PC (AF-013)',
  'access.pending': 'the approval requests the person answers on this PC (AF-013)',
  'access.answer': 'answers an agent\'s approval request on this PC (AF-013)',
  // AF-014: an agent made from a folder of this PC.
  'folderAgents.find': 'reads a folder of this PC for an agent\'s name, role, instruction files and skills (AF-014)',
  'folderAgents.create': 'hires an agent whose home project is a folder of this PC (AF-014)',
  'folderAgents.homes': 'the home project folders of this PC\'s agents (AF-014)',
  // AF-018: projects are folders of this PC; a session start can hire an agent for one.
  'projects.list': 'the project folders of this PC and their git state (AF-018)',
  'projects.get': 'a project folder of this PC and its git state (AF-018)',
  'projects.add': 'adds a folder of this PC as a project (AF-018)',
  'projects.update': 'renames or pins a project folder of this PC (AF-018)',
  'projects.remove': 'takes a project folder of this PC off the list (AF-018)',
  'projects.startSession': 'starts a session in a project folder of this PC and may hire an agent (AF-018)',
};

/** The spec's tier lists (DEV2). */
const CHAT = ['chats.update', 'chats.members', 'chats.archive', 'chats.direct' /* B-050 */, 'messages.edit', 'messages.delete', 'models.list', 'models.recent', 'efforts.forModel',
  'usage.list', 'modes.list', 'spaces.list', 'agents.templates', 'knowledge.search', 'knowledge.list', 'knowledge.history', 'knowledge.save',
  'knowledge.expire', 'skills.list', 'skills.get', 'media.describe', 'feedback.create', 'feedback.list', 'feedback.send', 'feedback.dismiss',
  'voice.transcribe', 'runs.items' /* C5: chat devices read run details */,
  'voice.localModels', 'voice.speak' /* B-047 D14: a phone reads answers in the PC's local voice */,
  'splits.list', 'splits.get' /* B-057: an agent's splits, with the runs.items rule through the group's parent run */,
  'access.get' /* AF-013: the composer's mode cell */];
const MANAGE = ['agents.create', 'agents.update', 'agents.archive', 'agents.export', 'spaces.save', 'spaces.archive',
  'schedules.update', 'schedules.delete', 'schedules.runNow', 'models.setPolicy', 'routing.preview', 'skills.save', 'agents.runs', 'runs.cancel',
  'splits.stop' /* B-057: the rights of runs.cancel */,
  // B-076: the phone's side pane is its PC's – its tabs and their view positions.
  'tabs.get', 'tabs.set', 'tabs.position', 'tabs.positions'];
/** B-076: the file tabs' paths (read, write, list, media) – the whole disk – for 'manage' only on a secure transport. */
const MANAGE_SECURE = ['files.readPath', 'files.writePath', 'files.listPath', 'files.uploadPath'];
/** B-078 ("alles vom Handy"): plans, keys and sign-ins from the owner's phone app – its loopback tunnel is secure. */
const SETTINGS_SECURE = ['accounts.list', 'accounts.detect', 'accounts.add', 'accounts.update', 'accounts.login', 'accounts.logout', 'accounts.remove',
  'accounts.install', 'accounts.useReset', 'accounts.test', 'accounts.try'];
const PERMISSIONS = ['secrets.list', 'secrets.save', 'spend.list',
  'secrets.groups', 'secrets.saveGroup' /* X05 */, 'secrets.folder' /* B-044 */, 'secrets.import' /* 29.10.2026 password import */];

const FULL: DeviceCapability[] = ['todo', 'chat', 'tasks', 'settings', 'manage'];
/** F-52: a method with a person variant keeps its rule for everyone else in `base`. */
const base = (rule: unknown): unknown => (rule && typeof rule === 'object' && 'person' in rule ? (rule as unknown as { base: unknown }).base : rule);
const device = (capabilities: DeviceCapability[], secure = true): ClientScope => ({ kind: 'device', deviceId: 'dev_tier', capabilities, secure });

test('every owner-only method is on the PC-local allow-list, and the list has no stale entries', () => {
  const table = createHandlerTable();
  const ownerOnly = table.methods().filter((method) => base(table.get(method)!.scope) === 'owner');
  const missing = ownerOnly.filter((method) => !(method in PC_LOCAL));
  assert.deepEqual(missing, [], 'owner-only methods must be PC-local (or get a device tier)');
  const stale = Object.keys(PC_LOCAL).filter((method) => base(table.get(method)?.scope) !== 'owner');
  assert.deepEqual(stale, [], 'allow-list entries must exist and be owner-only');
  // Even the widest device scope reaches none of them.
  const widest = device([...FULL, 'permissions']);
  for (const method of ownerOnly) assert.ok(!allowedScope(table.get(method)!.scope, widest), method);
});

test('the chat, manage and permissions tiers are registered as specified', () => {
  const table = createHandlerTable();
  for (const method of CHAT) assert.deepEqual(base(table.get(method)?.scope), { capability: 'chat' }, method);
  for (const method of MANAGE) assert.deepEqual(base(table.get(method)?.scope), { capability: 'manage' }, method);
  for (const method of MANAGE_SECURE) assert.deepEqual(base(table.get(method)?.scope), { capability: 'manage', secure: true }, method);
  for (const method of PERMISSIONS) assert.deepEqual(base(table.get(method)?.scope), { capability: 'permissions', secure: true }, method);
  for (const method of SETTINGS_SECURE) assert.deepEqual(base(table.get(method)?.scope), { capability: 'settings', secure: true }, method);
  assert.equal(base(table.get('session.info')?.scope), 'any');
});

test('tiers: a todo link, a full link, and the permissions opt-in on secure vs LAN transport', () => {
  const table = createHandlerTable();
  const may = (method: string, scope: ClientScope) => allowedScope(table.get(method)!.scope, scope);
  const todo = device(['todo']);
  assert.ok(may('todos.list', todo) && may('tasks.complete', todo));
  for (const method of ['chats.list', 'messages.send', 'tasks.list', 'agents.create', 'settings.update', 'modes.list']) assert.ok(!may(method, todo), method);
  const full = device(FULL, false); // plain LAN http
  for (const method of [...CHAT, ...MANAGE, 'settings.update', 'tasks.create', 'todos.list']) assert.ok(may(method, full), method);
  for (const method of PERMISSIONS) assert.ok(!may(method, full), `${method} needs the opt-in`);
  for (const method of MANAGE_SECURE) assert.equal(scopeDenial(table.get(method)!.scope, full), 'insecure', `${method}: no paths over plain LAN http`);
  for (const method of MANAGE_SECURE) assert.ok(may(method, device(FULL, true)), method);
  for (const method of MANAGE_SECURE) assert.ok(!may(method, device(['todo', 'chat', 'tasks', 'settings'], true)), `${method} needs manage`);
  const optedInLan = device([...FULL, 'permissions'], false);
  for (const method of PERMISSIONS) assert.equal(scopeDenial(table.get(method)!.scope, optedInLan), 'insecure', method);
  const optedIn = device([...FULL, 'permissions'], true);
  for (const method of PERMISSIONS) assert.ok(may(method, optedIn), method);
  // A scope without `secure` counts as insecure (fail closed).
  assert.equal(scopeDenial({ capability: 'permissions' }, { kind: 'device', deviceId: 'd', capabilities: ['permissions'] }), 'insecure');
  assert.equal(scopeDenial('owner', { kind: 'peer', deviceId: 'pc' }), 'scope');
});

test('session.info lists exactly the methods the server allows for the caller', async (t) => {
  const table = createHandlerTable();
  const f = rpcFixture({ table });
  t.after(f.cleanup);
  const owner = await new TestClient(f.server, OWNER).call<{ kind: string; secure: boolean; capabilities: string[]; allowedMethods: string[] }>('session.info');
  assert.equal(owner.kind, 'owner');
  assert.equal(owner.secure, true);
  assert.deepEqual(owner.capabilities, [...FULL, 'permissions']);
  assert.deepEqual(owner.allowedMethods, table.methods());
  for (const scope of [device(['todo']), device(FULL, false), device([...FULL, 'permissions'], false), device([...FULL, 'permissions'], true)]) {
    const info = await new TestClient(f.server, scope).call<{ kind: string; secure: boolean; capabilities: string[]; allowedMethods: string[] }>('session.info');
    assert.equal(info.kind, 'device');
    assert.equal(info.secure, (scope as { secure?: boolean }).secure === true);
    assert.deepEqual(info.capabilities, (scope as { capabilities: string[] }).capabilities);
    assert.deepEqual(info.allowedMethods, table.methods().filter((method) => allowedScope(table.get(method)!.scope, scope)));
    assert.deepEqual(sessionInfo(table, scope), info);
  }
  const todoInfo = sessionInfo(table, device(['todo']));
  assert.ok(todoInfo.allowedMethods.includes('todos.list') && !todoInfo.allowedMethods.includes('chats.list'));
});

test('a refused call on plain LAN http says that the HTTPS address is needed', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const lan = new TestClient(f.server, device([...FULL, 'permissions'], false));
  const insecure = await lan.request('secrets.list', {});
  assert.equal(insecure.error?.code, 'forbidden');
  assert.equal(insecure.error?.details?.needsSecure, true);
  const plain = await new TestClient(f.server, device(['todo'])).request('secrets.list', {});
  assert.equal(plain.error?.code, 'forbidden');
  assert.equal(plain.error?.details?.needsSecure, undefined);
  await assert.rejects(f.server.call('secrets.list', {}, device(['permissions'], false)), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
});
