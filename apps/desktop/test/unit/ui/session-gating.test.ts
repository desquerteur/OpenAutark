// DEV3 UI gating by session.info (src/ui/lib/session.ts): for the owner, a phone (one tier: tokens.FULL_ACCESS)
// and a phone on plain LAN http, the session answers come from the real handler table (rpc/handlers/session.ts –
// what the server enforces), and the UI's gates follow them: can()/secure/notes, the profile menu items, the shell
// gates (palette actions, new-chat hotkey, chat route) and which snapshots the boot asks for (none the runtime
// would refuse).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { sessionInfo } from '../../../src/runtime/rpc/handlers/session.ts';
import { FULL_ACCESS as RUNTIME_FULL } from '../../../src/runtime/pwa/tokens.ts';
import type { MethodName, SessionInfo } from '../../../src/shared/api/methods.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import { loadSnapshots } from '../../../src/ui/lib/load.ts';
import type { LoadCall } from '../../../src/ui/lib/load.ts';
import { rpc, RpcError } from '../../../src/ui/lib/rpc.ts';
import { platform } from '../../../src/ui/lib/platform.ts';
import { HTTPS_NOTE, PC_NOTE, blockedNote, can, holds, isOwner, loadSession, secure, session } from '../../../src/ui/lib/session.ts';
import { accounts, loadAll, loaded, loadError, usage } from '../../../src/ui/lib/store.ts';
import { canStartChat, chatRouteAllowed, paletteActions } from '../../../src/ui/shell/gates.ts';

const table = createHandlerTable();

const OWNER: ClientScope = { kind: 'owner' };
const device = (capabilities: readonly DeviceCapability[], secureTransport = true): ClientScope =>
  ({ kind: 'device', deviceId: 'dv_phone', capabilities: [...capabilities], secure: secureTransport });
const FULL = device(RUNTIME_FULL);
const FULL_PERMISSIONS = device([...RUNTIME_FULL, 'permissions']);
const INSECURE = device([...RUNTIME_FULL, 'permissions'], false);

/** What session.info answers this scope (the same table the server dispatches with). */
const infoFor = (scope: ClientScope): SessionInfo => sessionInfo(table, scope);
const as = (scope: ClientScope): SessionInfo => { session.value = infoFor(scope); return session.value; };

const profileItems = () => [
  can('accounts.list') && 'Usage', 'Settings', can('feedback.create') && 'Feedback',
].filter(Boolean);

function forbidden(): RpcError {
  return new RpcError({ code: 'forbidden', message: 'This device is not allowed to do that.' });
}

/** A runtime fake that refuses exactly what the server refuses for `scope`; records every call. */
function runtimeFor(scope: ClientScope): { call: LoadCall; calls: string[]; refused: string[] } {
  const allowed = new Set<string>(infoFor(scope).allowedMethods);
  const calls: string[] = [];
  const refused: string[] = [];
  const answers: Record<string, unknown> = {
    'session.info': infoFor(scope), 'settings.get': { profile: { name: 'Alex' } }, 'agents.list': [{ id: 'ag_manager', name: 'Manager' }],
    'todos.list': [{ id: 'ta_todo', title: 'Sign the delivery note', assigneeKind: 'human', status: 'open' }], 'ui.state': { drafts: {} },
    'chats.list': [], 'agents.activity': [], 'tasks.list': [], 'accounts.list': [{ id: 'acc_1' }], 'usage.list': [{ accountId: 'acc_1' }], 'system.info': {},
  };
  const call = (async (method: string) => {
    calls.push(method);
    if (!allowed.has(method)) { refused.push(method); throw forbidden(); }
    if (!(method in answers)) throw new RpcError({ code: 'not_found', message: `unexpected call ${method}` });
    return answers[method];
  }) as unknown as LoadCall;
  return { call, calls, refused };
}

test('loadSession keeps the answer; before it and after a failure a phone may do nothing', async () => {
  assert.equal(platform, 'pwa', 'unit tests run as the browser/phone build');
  session.value = null;
  assert.equal(can('todos.list'), false, 'no session answer yet: a phone shows no gated control');
  assert.equal(isOwner(), false);
  assert.equal(secure.value, false);
  const info = await loadSession(async () => infoFor(FULL));
  assert.equal(info?.kind, 'device');
  assert.equal(can('todos.list'), true);
  await loadSession(async () => { throw new RpcError({ code: 'unavailable', message: 'Connection to the runtime was lost.' }); });
  assert.equal(session.value, null, 'a failed answer falls back to the conservative default');
  assert.equal(can('todos.list'), false);
});

test('owner: every control, every settings section, secure, no notes', () => {
  as(OWNER);
  assert.equal(isOwner(), true);
  assert.equal(secure.value, true);
  assert.equal(holds('permissions'), true);
  for (const method of ['accounts.list', 'secrets.list', 'secrets.delete', 'pwa.state'] as MethodName[]) assert.equal(can(method), true, method);
  assert.equal(blockedNote('secrets.list'), undefined);
  assert.deepEqual(profileItems(), ['Usage', 'Settings', 'Feedback']);
});

test('a phone: the org, chats and tasks on the phone; PC-local controls are not offered', () => {
  as(FULL);
  assert.equal(isOwner(), false);
  assert.equal(secure.value, true);
  assert.deepEqual(profileItems(), ['Usage', 'Settings', 'Feedback'], 'B-078: plans and accounts from the owner\'s phone on its secure tunnel');
  assert.equal(can('usage.list'), true, 'quota badges have data on the phone');
  assert.equal(blockedNote('secrets.list'), undefined, 'B-078: a paired phone holds permissions (secure transport)');
  assert.equal(can('accounts.login'), true);
  assert.equal(blockedNote('agents.create'), undefined);
  for (const method of ['pwa.state', 'secrets.delete'] as MethodName[]) assert.equal(can(method), false, method);
});

test('full-access phone with the permissions tier on a secure transport: permissions, secrets (create) and spend', () => {
  as(FULL_PERMISSIONS);
  for (const method of ['secrets.list', 'secrets.save', 'spend.list'] as MethodName[]) {
    assert.equal(can(method), true, method);
    assert.equal(blockedNote(method), undefined, method);
  }
  assert.equal(can('secrets.delete'), false, 'deleting a secret stays on the PC');
});

test('phone on plain LAN http: sensitive controls say to open the HTTPS address; the rest works', () => {
  as(INSECURE);
  assert.equal(secure.value, false);
  assert.equal(holds('permissions'), true);
  for (const method of ['secrets.list', 'secrets.save', 'spend.list'] as MethodName[]) {
    assert.equal(can(method), false, method);
    assert.equal(blockedNote(method), HTTPS_NOTE, method);
  }
  assert.equal(can('agents.create'), true, 'only the sensitive set needs a secure transport');
  assert.equal(blockedNote('pwa.state'), PC_NOTE, 'PC-local controls keep the PC note');
  // Without the tier, plain http changes nothing about the note: the tier is missing first.
  as(device(RUNTIME_FULL.filter((tier) => tier !== 'permissions'), false));
  assert.equal(blockedNote('secrets.list'), PC_NOTE);
  as(INSECURE);
  assert.equal(can('accounts.list'), false, 'B-078: accounts need the secure tunnel too');
});

test('shell gates: the owner and phones keep New chat (palette, mod+n) and the chat view', () => {
  session.value = null;
  assert.equal(chatRouteAllowed(), true, 'before the session answers, a chat route renders as before');
  as(OWNER);
  assert.deepEqual([...paletteActions('ch_main')].sort(), ['a:day', 'a:feedback', 'a:new-chat', 'a:new-task', 'a:sidebar', 'a:work-resume', 'a:work-stop']);
  assert.equal(paletteActions().has('a:new-task'), false, 'New task in this chat needs an open chat');
  as(FULL);
  assert.equal(paletteActions('ch_main').has('a:new-chat'), true);
  assert.equal(canStartChat(), true);
  assert.equal(chatRouteAllowed(), true);
  assert.ok(paletteActions('ch_main').has('a:day'), 'My day (todos.list) is on every paired device');
});

test('the boot asks only for what the session allows: no refused call for any tier', async () => {
  const cases: Array<[string, ClientScope, { accounts: boolean; usage: boolean; chats: boolean }]> = [
    ['owner', OWNER, { accounts: true, usage: true, chats: true }],
    ['full', FULL, { accounts: true, usage: true, chats: true }], // B-078: accounts on the secure phone
    ['insecure', INSECURE, { accounts: false, usage: true, chats: true }],
  ];
  for (const [name, scope, expected] of cases) {
    const runtime = runtimeFor(scope);
    await loadSession(runtime.call);
    const snapshot = await loadSnapshots({ call: runtime.call, optional: can, scoped: can });
    assert.deepEqual(runtime.refused, [], `${name}: no call is refused (${runtime.calls.join(', ')})`);
    assert.equal(runtime.calls[0], 'session.info', `${name}: session.info comes first`);
    assert.equal(runtime.calls.includes('accounts.list'), expected.accounts, `${name}: accounts.list`);
    assert.equal(runtime.calls.includes('usage.list'), expected.usage, `${name}: usage.list`);
    assert.equal(runtime.calls.includes('chats.list'), expected.chats, `${name}: chats.list`);
    assert.deepEqual(snapshot.todos.map((task) => task.id), ['ta_todo'], `${name}: the For-you list loads`);
    assert.deepEqual(snapshot.accounts, expected.accounts ? [{ id: 'acc_1' }] : []);
  }
});

test('store.loadAll asks session.info first and gates the snapshots with it', async () => {
  for (const [scope, usageLoaded] of [[FULL, true]] as const) {
    const runtime = runtimeFor(scope);
    (rpc as unknown as { call: unknown }).call = runtime.call;
    loaded.value = false;
    loadError.value = null;
    accounts.value = [];
    usage.value = [];
    await loadAll();
    await new Promise((resolve) => setTimeout(resolve, 5)); // the trailing system.info
    assert.equal(loadError.value, null);
    assert.equal(loaded.value, true);
    assert.equal(runtime.calls[0], 'session.info');
    assert.deepEqual(runtime.refused, [], `nothing refused: ${runtime.calls.join(', ')}`);
    assert.equal(session.value?.kind, 'device');
    assert.equal(usage.value.length > 0, usageLoaded, 'usage (quota badges) loads where usage.list is allowed');
    assert.deepEqual(accounts.value, [{ id: 'acc_1' }], 'B-078: the secure phone loads the accounts too');
  }
});
