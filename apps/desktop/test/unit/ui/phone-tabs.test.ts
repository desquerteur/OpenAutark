// The phone's side pane is its PC's (src/ui/workspace/phone-tabs.ts with pages.ts, B-076): the PC's spaces arrive and
// send nothing back; choosing a tab, reordering or closing one sends that space once – a closed remote tab by name, so
// a tab the PC opened meanwhile stays –; a blank tab stays on the phone and leaves the PC's choice; an address typed
// into it becomes a website of the PC ('remote' with the PC's id); a file tab opens with its content, not the system app.
// Owns: these assertions only. Never: a real PC, a socket or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SideSpaces } from '../../../src/shared/api/workspace-browser.ts';

const PC: SideSpaces = {
  global: { shown: 'remote:dev_pc:web-1', tabs: [
    { id: 'remote:dev_pc:web-1', panel: 'remote', device: 'dev_pc', tab: 'web-1', url: 'https://one.example/' },
    { id: 'day', panel: 'day' },
    { id: 'file:/srv/a.md', panel: 'file', path: '/srv/a.md' },
    { id: 'remote:dev_b:web-9', panel: 'remote', device: 'dev_b', tab: 'web-9', url: 'https://other.example/' },
  ] },
};

test('phoneChanges: only spaces that differ, the remote tabs no space lists any more, a blank tab keeps the PC\'s choice', async () => {
  const { phoneChanges } = await import('../../../src/ui/workspace/phone-tabs.ts');
  assert.equal(phoneChanges(PC, structuredClone(PC)), undefined, 'the same spaces send nothing');
  assert.equal(phoneChanges(PC, { ...structuredClone(PC), 'chat:ch_1': { tabs: [] } }), undefined, 'an empty space is no space');
  const tabs = PC.global!.tabs;
  assert.equal(phoneChanges(PC, { global: { tabs } }), undefined, 'a blank tab shown here leaves the PC\'s shown tab');
  assert.deepEqual(phoneChanges(PC, { global: { shown: 'day', tabs } }), { spaces: { global: { shown: 'day', tabs } }, closed: [] });
  assert.deepEqual(phoneChanges(PC, { global: { shown: 'day', tabs: [tabs[1]!, tabs[2]!] } }), {
    spaces: { global: { shown: 'day', tabs: [tabs[1]!, tabs[2]!] } }, closed: ['remote:dev_pc:web-1', 'remote:dev_b:web-9'],
  });
});

test('the phone\'s pane: the PC\'s spaces come in, what the person does goes back', async () => {
  const pages = await import('../../../src/ui/workspace/pages.ts');
  const { phoneChanges } = await import('../../../src/ui/workspace/phone-tabs.ts');
  const files = await import('../../../src/ui/workspace/file-tabs.ts');
  let known: SideSpaces = structuredClone(PC);
  const sent: Array<{ spaces: SideSpaces; closed: string[] }> = [];
  pages.linkPhone({ device: 'dev_pc', send: (layout) => { const change = phoneChanges(known, layout); if (change) { known = { ...known, ...change.spaces }; sent.push(change); } } });
  pages.acceptLayout(structuredClone(PC));
  pages.pagesListed.value = true;
  assert.deepEqual(pages.tabsOf('global').map((tab) => tab.id), PC.global!.tabs.map((tab) => tab.id));
  assert.equal(pages.shownOf('global'), 'remote:dev_pc:web-1');
  assert.equal(sent.length, 0, 'taking the PC\'s spaces sends nothing back');
  assert.equal(pages.hasPane(), true);

  pages.selectPage('day');
  assert.deepEqual(sent.at(-1)?.spaces.global?.shown, 'day', 'choosing a tab goes to the PC');

  const before = sent.length;
  pages.addPage();
  const blank = pages.tabsOf('global').at(-1)!;
  assert.equal(blank.kind, 'new');
  assert.equal(sent.length, before, 'a blank tab stays here');
  await pages.goTo(blank.id, 'https://news.example/');
  const opened = pages.tabsOf('global').at(-1)!;
  assert.deepEqual(opened, { id: `remote:dev_pc:${blank.id}`, kind: 'remote', device: 'dev_pc', tab: blank.id, url: 'https://news.example/' }, 'an address becomes a website of the PC');
  assert.equal(pages.shownOf('global'), opened.id);
  assert.ok(sent.at(-1)?.spaces.global?.tabs.some((tab) => tab.id === opened.id && tab.panel === 'remote'));

  await pages.closePage('remote:dev_pc:web-1');
  assert.deepEqual(sent.at(-1)?.closed, ['remote:dev_pc:web-1'], 'a closed tab is named');
  assert.ok(!sent.at(-1)?.spaces.global?.tabs.some((tab) => tab.id === 'remote:dev_pc:web-1'));

  files.openFileTab('/srv/b.md');
  assert.equal(pages.tabsOf('global').at(-1)?.id, 'file:/srv/b.md', 'a file opens as a tab with its content');
  files.openFileTab('/srv/c.md', undefined, undefined, 'dev_b');
  assert.deepEqual(pages.tabsOf('global').at(-1), { id: 'file@dev_b:/srv/c.md', kind: 'file', path: '/srv/c.md', device: 'dev_b' }, 'one of another PC names it');
});
