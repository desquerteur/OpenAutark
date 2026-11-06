// B-078 (D20): Fill login in the integrated browser (main/workspace-fill.ts, workspace-page-menu.ts) – the submenu lists
// the page's site first and every other login below (by first letter when there are many); a pick asks the runtime for
// the values and types them with insertText into the fields the isolated-world script focused, never into a script's
// source; the page menu carries the entry only while main's RPC is set and the page is http(s); Ctrl/Cmd+Shift+L opens
// it too. The runtime side (secrets.fillChoices / secrets.fillLogin): suggestions by registrable domain, values for the
// owner only.
// Owns: these assertions. Never: Electron, a window or a real vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillItems, fillLogin, setFillRpc, type FillContents, type FillRpc } from '../../../src/main/workspace-fill.ts';
import { attachPageMenu, isFillKey } from '../../../src/main/workspace-page-menu.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { LoginChoice } from '../../../src/shared/model/login-fill.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';

type Item = { label?: string; type?: string; enabled?: boolean; submenu?: Item[]; click?: () => void };
const labels = (items: Item[] | undefined) => (items ?? []).map((item) => (item.type === 'separator' ? '-' : item.label));

function fakeRpc(choices: LoginChoice[], values = { username: 'robin@site.test', password: 'pa55-word' }) {
  const calls: Array<[string, unknown]> = [];
  const rpc = { call: async (method: string, params: unknown) => { calls.push([method, params]); return method === 'secrets.fillChoices' ? choices : values; } } as unknown as FillRpc;
  return { rpc, calls };
}

function fakePage(fields = { user: true, pass: true }) {
  const typed: string[] = [];
  const scripts: string[] = [];
  const contents: FillContents = {
    getURL: () => 'https://login.site.test/in', isDestroyed: () => false, focus: () => {},
    executeJavaScriptInIsolatedWorld: async (_world, [script]) => { scripts.push(script.code); return script.code.endsWith('("user")') ? fields.user : fields.pass; },
    insertText: async (text) => { typed.push(text); },
  };
  return { contents, typed, scripts };
}

test('the submenu: the site\'s logins first, then all; many logins by first letter; none: one quiet disabled line', () => {
  const picked: string[] = [];
  const item = fillItems([
    { id: 'g1', label: 'Site', site: 'site.test', suggested: true }, { id: 'g2', label: 'Bank', site: 'bank.test' }, { id: 'g3', label: 'Mail' },
  ], (id) => picked.push(id)) as Item;
  assert.deepEqual(labels(item.submenu), ['Site – site.test', '-', 'All logins']);
  assert.deepEqual(labels(item.submenu![2].submenu), ['Bank – bank.test', 'Mail']);
  item.submenu![2].submenu![1].click!();
  assert.deepEqual(picked, ['g3']);
  const many = fillItems(Array.from({ length: 30 }, (_, index) => ({ id: `g${index}`, label: `${index % 2 ? 'Alpha' : 'Beta'} ${index}` })), () => {}) as Item;
  assert.deepEqual(labels(many.submenu), ['A', 'B']);
  assert.equal((fillItems([], () => {}) as Item).enabled, false);
});

test('a pick types username and password with insertText into the fields the script focused – values never in a script', async () => {
  const { rpc, calls } = fakeRpc([]);
  const page = fakePage();
  assert.deepEqual(await fillLogin(rpc, page.contents, 'g1'), { filled: ['username', 'password'] });
  assert.deepEqual(calls, [['secrets.fillLogin', { id: 'g1', url: 'https://login.site.test/in' }]]);
  assert.deepEqual(page.typed, ['robin@site.test', 'pa55-word']);
  assert.ok(page.scripts.every((code) => !code.includes('pa55') && !code.includes('robin@')), 'no value in a script');
  const onlyPass = fakePage({ user: false, pass: true });
  assert.deepEqual(await fillLogin(rpc, onlyPass.contents, 'g1'), { filled: ['password'] });
  assert.deepEqual(onlyPass.typed, ['pa55-word']);
  assert.deepEqual(await fillLogin(rpc, fakePage({ user: false, pass: false }).contents, 'g1'), { error: 'No login field on this page.' });
  assert.deepEqual(await fillLogin(undefined, page.contents, 'g1'), { error: 'This page cannot be filled.' });
});

test('a page that moved to another origin while the login was read gets nothing typed', async () => {
  const { rpc } = fakeRpc([]);
  const page = fakePage();
  let url = 'https://login.site.test/in';
  page.contents.getURL = () => url;
  const slow = { call: async (method: string, params: unknown) => { const out = await rpc.call(method as 'secrets.fillLogin', params as never); url = 'https://evil.test/form'; return out; } } as unknown as FillRpc;
  assert.deepEqual(await fillLogin(slow, page.contents, 'g1'), { error: 'The page changed before the login was filled.' });
  assert.deepEqual(page.typed, []);
  url = 'https://login.site.test/in';
  const midway = fakePage();
  midway.contents.getURL = () => url;
  midway.contents.executeJavaScriptInIsolatedWorld = async () => { url = 'https://evil.test/'; return true; };
  assert.deepEqual(await fillLogin(rpc, midway.contents, 'g1'), { error: 'The page changed before the login was filled.' });
  assert.deepEqual(midway.typed, [], 'checked again right before typing');
});

test('the page menu carries Fill login while main\'s RPC is set; Ctrl/Cmd+Shift+L opens it', async () => {
  const { rpc } = fakeRpc([{ id: 'g1', label: 'Site', suggested: true }]);
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const templates: Item[][] = [];
  const page = { on: (name: string, listener: (event: unknown, value: unknown) => void) => listeners.set(name, listener), getURL: () => 'https://site.test/' };
  const window = { isDestroyed: () => false, webContents: { focus: () => {}, send: () => {} } };
  const fakeContents = Object.assign(page, {
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
    reload: () => {}, copy: () => {}, paste: () => {}, isDevToolsOpened: () => false, openDevTools: () => {}, inspectElement: () => {},
  });
  attachPageMenu(fakeContents as never, {
    window: () => window as never, openLink: () => {},
    electron: { Menu: { buildFromTemplate: (items: Item[]) => { templates.push(items); return { popup: () => undefined }; } } as never, clipboard: { writeText: () => {} } },
  });
  const params = { linkURL: '', isEditable: false, x: 1, y: 1, pageURL: 'https://site.test/', editFlags: { canCopy: false, canPaste: false } };
  try {
    listeners.get('context-menu')!({}, params);
    assert.equal(templates.length, 1, 'without main\'s RPC: the menu at once, no entry');
    assert.ok(!labels(templates[0]).includes('Fill login'));
    setFillRpc(rpc);
    listeners.get('context-menu')!({}, params);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(labels(templates[1]).includes('Fill login'));
    let prevented = false;
    listeners.get('before-input-event')!({ preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'L', control: true, meta: false, shift: true, alt: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prevented, process.platform !== 'darwin');
    if (process.platform !== 'darwin') assert.deepEqual(labels(templates[2]), ['Site']);
  } finally { setFillRpc(undefined); }
  assert.equal(isFillKey({ type: 'keyDown', key: 'l', control: true, meta: false, shift: true, alt: false }, false), true);
  assert.equal(isFillKey({ type: 'keyDown', key: 'l', control: true, meta: false, shift: false, alt: false }, false), false, 'Ctrl+L stays the address bar');
});

test('runtime: fillChoices lists the page\'s site first (registrable domain), fillLogin gives main\'s own link the values, nobody else', async () => {
  const table = createHandlerTable();
  const used: Array<[string, string, string | undefined]> = [];
  const secrets = {
    groups: () => [
      { id: 'g_bank', label: 'Bank', kind: 'login', source: 'bank.test', createdAt: 1 },
      { id: 'g_site', label: 'Site', kind: 'login', source: 'www.site.test', createdAt: 1 },
      { id: 'g_card', label: 'Card', kind: 'card', createdAt: 1 },
    ],
    list: () => [
      { id: 's_u', label: 'u', kind: 'text', createdAt: 1, group: { id: 'g_site', label: 'Site', kind: 'login' }, field: 'username' },
      { id: 's_p', label: 'p', kind: 'password', createdAt: 1, group: { id: 'g_site', label: 'Site', kind: 'login' }, field: 'password' },
    ],
    use: async (id: string, agentId: string, domain?: string) => { used.push([id, agentId, domain]); return id === 's_u' ? 'robin' : 'secret'; },
  };
  const ctx = (scope: ClientScope) => ({ scope, services: { secrets } as unknown as RuntimeServices, extras: {}, topics: new Set(), signal: new AbortController().signal } as unknown as HandlerContext);
  const owner: ClientScope = { kind: 'owner' };
  const choices = await table.get('secrets.fillChoices')!.handler({ url: 'https://login.site.test/x' } as never, ctx(owner)) as LoginChoice[];
  assert.deepEqual(choices.map((choice) => [choice.id, choice.suggested ?? false]), [['g_site', true], ['g_bank', false]]);
  const main = { kind: 'owner', main: true } as ClientScope; // main's own link (entry-electron marks the 'main' port)
  assert.deepEqual(await table.get('secrets.fillLogin')!.handler({ id: 'g_site', url: 'https://login.site.test/x' } as never, ctx(main)), { username: 'robin', password: 'secret' });
  assert.deepEqual(used, [['s_u', 'human', 'site.test'], ['s_p', 'human', 'site.test']]);
  // The window, the CLI and loopback HTTP clients are owner scope too – they get no values.
  await assert.rejects(Promise.resolve().then(() => table.get('secrets.fillLogin')!.handler({ id: 'g_site', url: 'https://site.test' } as never, ctx(owner))), /own browser/);
  assert.equal(used.length, 2, 'nothing read for them');
  await assert.rejects(Promise.resolve().then(() => table.get('secrets.fillLogin')!.handler({ id: 'g_site', url: 'https://site.test' } as never, ctx({ kind: 'device', deviceId: 'd', capabilities: ['permissions'], secure: true }))), /own browser/);
  assert.equal(table.get('secrets.fillLogin')!.scope, 'owner');
  await assert.rejects(Promise.resolve().then(() => table.get('secrets.fillChoices')!.handler({ url: 'file:///etc' } as never, ctx(owner))), /http/);
});
