// A phone that reads no PC's pane (src/ui/workspace/pages.ts – one without 'manage') keeps its app tabs and its chosen
// tab on the device over a reload, as before B-076; once it reads its PC's pane, the PC's spaces are its own and the
// device keeps nothing.
// Owns: these assertions only. Never: a real PC, a socket or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const APP_TABS = 'wf.workspaceAppTabs';
const CHOSEN = 'wf.workspaceTab';
const store = new Map<string, string>([[APP_TABS, JSON.stringify({ global: [{ id: 'screen', kind: 'screen' }] })], [CHOSEN, 'screen']]);
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  },
});

test('a phone without its PC\'s pane keeps its tabs over a reload; one that reads its PC\'s pane keeps none', async () => {
  const pages = await import('../../../src/ui/workspace/pages.ts');
  assert.deepEqual(pages.tabsOf('global').map((tab) => tab.id), ['screen'], 'the tabs kept before the reload are back');
  assert.equal(pages.shownOf('global'), 'screen');

  pages.openAgentBrowser('ag_ada'); // Watch on My day
  const watched = pages.tabsOf('global').at(-1)!;
  assert.equal(watched.kind, 'agent');
  assert.deepEqual((JSON.parse(store.get(APP_TABS)!) as { global: Array<{ id: string }> }).global.map((tab) => tab.id), ['screen', watched.id], 'kept for the next start');
  assert.equal(store.get(CHOSEN), watched.id);

  pages.linkPhone({ device: 'dev_pc', send: () => undefined });
  pages.acceptLayout({ global: { tabs: [{ id: 'day', panel: 'day' }] } });
  pages.selectPage('day');
  assert.equal(store.size, 0, 'the PC\'s pane is not kept on the device');
});
