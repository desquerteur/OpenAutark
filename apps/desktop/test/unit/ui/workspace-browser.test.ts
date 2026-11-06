// The browser pane's rules (src/ui/workspace/browser-model.ts, pages.ts): a tab's name (title, else
// host, else "New tab"; an app tab its kind and what it shows), which tab is shown and which is chosen
// after a close, and the tab list kept in step with main (a tab an agent opens
// joins, one main closes leaves, a blank tab and app tabs stay; an address opens in the blank tab;
// closing the last tab leaves a blank one; a finished download ends with one toast); the app tabs'
// openers (one tab per thing, kept per device) and the find field only on a website tab; a tab an agent opened
// carries that agent (its avatar in the list); every command acts on its own space (a chat's area, the global pane), and a
// page an agent shows opens its surface.
// Owns: these assertions only. Never: Electron, a real window or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appTabId, appTabsOf, chosenAfterClose, displayAddress, fromSideSpace, hostOf, shownId, tabInfos, tabName, toSideSpace } from '../../../src/ui/workspace/browser-model.ts';
import type { SideSpaces, WorkspaceBrowserCommand, WorkspaceBrowserPage } from '../../../src/shared/api/workspace-browser.ts';

const page = (id: string, patch: Partial<WorkspaceBrowserPage> = {}): WorkspaceBrowserPage => ({ id, space: 'global', url: `https://${id}.test/`, title: '', loading: false, back: false, forward: false, ...patch });

test('a tab is named by its title, else its host, else New tab', () => {
  const infos = tabInfos([{ id: 'web-a', kind: 'website' }, { id: 'web-b', kind: 'website' }, { id: 'web-c', kind: 'new' }], [page('web-a', { title: 'Docs' }), page('web-b', { url: 'https://www.shop.test/cart' })]);
  assert.deepEqual(infos.map(tabName), ['Docs', 'shop.test', 'New tab']);
  assert.deepEqual(infos.map((info) => info.blank), [false, false, true]);
  assert.equal(hostOf('not an address'), '');
  assert.equal(tabName({ title: '', host: '', url: 'https://[::1]:80/' }), 'https://[::1]:80/', 'an address without a host name is shown as it is');
});

test('a space to and from side-tabs.json: websites by id, panels with what they show, a blank tab stays in the window', () => {
  const tabs = [{ id: 'web-a', kind: 'website' as const }, { id: 'web-new', kind: 'new' as const }, { id: 'notes:ch_1', kind: 'notes' as const, conversationId: 'ch_1' }, { id: 'day', kind: 'day' as const }];
  const space = toSideSpace(tabs, 'notes:ch_1');
  assert.deepEqual(space, { shown: 'notes:ch_1', tabs: [{ id: 'web-a' }, { id: 'notes:ch_1', conversationId: 'ch_1', panel: 'notes' }, { id: 'day', panel: 'day' }] });
  assert.deepEqual(fromSideSpace(space), tabs.filter((tab) => tab.kind !== 'new'));
  assert.equal(toSideSpace(tabs, 'web-new').shown, undefined, 'a blank tab is shown only here');
  assert.deepEqual(fromSideSpace({ tabs: [{ id: 'x', panel: 'unknown' }, { id: 'notes:other', panel: 'notes', conversationId: 'ch_1' }] }), [], 'a malformed panel is left out');
});

test('a tab an agent opened carries its opener', () => {
  const opener = (chatId?: string) => ({ agentId: 'ag_ada', agentName: 'Ada', ...(chatId ? { chatId } : {}) });
  const pages = [page('web-a', { opener: opener('ch_1') }), page('web-b'), page('web-c', { opener: opener('ch_1') }), page('web-d', { opener: opener() })];
  const infos = tabInfos(pages.map((entry) => ({ id: entry.id, kind: 'website' as const })), pages);
  assert.deepEqual(infos.map((info) => info.opener?.agentName ?? null), ['Ada', null, 'Ada', 'Ada']);
});

test('the shown tab is the chosen one while it exists, else the newest; closing hands over to the next, else the one before', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(shownId(ids, 'b'), 'b');
  assert.equal(shownId(ids, 'gone'), 'c');
  assert.equal(shownId([], 'a'), undefined);
  assert.equal(chosenAfterClose(ids, 'c', 'a'), 'a', 'a tab that is not shown closes: the shown one stays');
  assert.equal(chosenAfterClose(ids, 'b', 'b'), 'c', 'the next one');
  assert.equal(chosenAfterClose(ids, 'c', 'c'), 'b', 'else the one before');
  assert.equal(chosenAfterClose(['a'], 'a', 'a'), undefined, 'the last tab leaves none');
});

test('an app tab is named by its kind and what it shows; only well-formed stored app tabs come back', () => {
  const infos = tabInfos([{ id: 'notes:c1', kind: 'notes', conversationId: 'c1' }, { id: 'screen', kind: 'screen' }], [], (entry) => entry.kind === 'notes' ? 'Launch plan' : 'This PC');
  assert.deepEqual(infos.map((info) => [info.kind, info.host, tabName(info), info.blank, info.url]), [['notes', 'Notes', 'Launch plan', false, ''], ['screen', 'Screen', 'This PC', false, '']]);
  assert.deepEqual(appTabsOf([
    { id: 'notes:c1', kind: 'notes', conversationId: 'c1' }, { id: 'media:f', kind: 'media', fileId: 'f' }, { id: 'screen', kind: 'screen' },
    { id: 'notes:x', kind: 'notes', conversationId: 'c1' }, { id: 'web-1', kind: 'website' }, { id: 'media:', kind: 'media' }, { id: 'media', kind: 'media' }, { id: 'activity', kind: 'activity' }, null, 'screen',
  ]).map((tab) => tab.id), ['notes:c1', 'media:f', 'screen', 'media', 'activity']);
  assert.deepEqual(appTabsOf('not a list'), []);
});

test('panels are tabs: My day and Work once each, one tab per agent\'s browser; only well-formed ones come back', () => {
  assert.deepEqual([appTabId({ kind: 'day' }), appTabId({ kind: 'work' }), appTabId({ kind: 'agent', agentId: 'ag_1' })], ['day', 'work', 'agent:ag_1']);
  assert.deepEqual(appTabsOf([
    { id: 'day', kind: 'day' }, { id: 'work', kind: 'work' }, { id: 'agent:ag_1', kind: 'agent', agentId: 'ag_1' },
    { id: 'other', kind: 'day' }, { id: 'agent:x', kind: 'agent', agentId: 'ag_1' }, { id: 'agent:', kind: 'agent' },
  ]).map((tab) => tab.id), ['day', 'work', 'agent:ag_1']);
  const [info] = tabInfos([{ id: 'agent:ag_1', kind: 'agent', agentId: 'ag_1' }], [], () => 'Ada\'s browser');
  assert.equal(info.agentId, 'ag_1', 'its avatar on the tab');
  assert.equal(tabName(info), 'Ada\'s browser');
  const [site] = tabInfos([{ id: 'web-a', kind: 'website' }], [page('web-a', { favicon: 'data:image/png;base64,AA', loading: true })]);
  assert.equal(site.favicon, 'data:image/png;base64,AA');
  assert.equal(site.loading, true);
});

test('the resting address is the address alone, without the https:// and www. every page has', () => {
  assert.equal(displayAddress('https://www.example.com/'), 'example.com');
  assert.equal(displayAddress('https://example.com/docs/a?b=1'), 'example.com/docs/a?b=1');
  assert.equal(displayAddress('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(displayAddress('http://www.old.test/x'), 'http://old.test/x');
  assert.equal(displayAddress(''), '');
});

/** The pane's store against a fake desktop bridge (one for the file – the modules keep their state): main's tabs are `main`, every command is recorded. */
let shared: ReturnType<typeof build> | undefined;
function pane() { return (shared ??= build()); }
async function build() {
  const main: WorkspaceBrowserPage[] = [];
  const commands: WorkspaceBrowserCommand[] = [];
  const listeners: Array<(pages: WorkspaceBrowserPage[]) => void> = [];
  const layoutListeners: Array<(spaces: SideSpaces) => void> = [];
  const store = new Map<string, string>();
  const write = (listener: (pages: WorkspaceBrowserPage[]) => void) => listener([...main]);
  const native = {
    command: async (command: WorkspaceBrowserCommand) => {
      commands.push(command);
      if (command.action === 'open') {
        const at = main.findIndex((item) => item.id === command.id);
        const next = page(command.id, { url: command.url });
        if (at < 0) main.push(next); else main[at] = next;
      } else if (command.action === 'close') main.splice(main.findIndex((item) => item.id === command.id), 1);
      return [...main];
    },
    onChanged: (listener: (pages: WorkspaceBrowserPage[]) => void) => { listeners.push(listener); return () => undefined; },
    layout: async () => ({}),
    onLayout: (listener: (spaces: SideSpaces) => void) => { layoutListeners.push(listener); return () => undefined; },
  };
  Object.assign(globalThis, {
    window: { workforce: { connect: () => undefined, workspaceBrowser: native } },
    localStorage: { getItem: (name: string) => store.get(name) ?? null, setItem: (name: string, value: string) => { store.set(name, value); } },
  });
  const pages = await import('../../../src/ui/workspace/pages.ts');
  const { toasts } = await import('../../../src/ui/lib/toasts.ts');
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const emit = () => { for (const listener of listeners) write(listener); };
  const lastLayout = () => (commands.filter((command) => command.action === 'layout').at(-1) as { spaces: SideSpaces } | undefined)?.spaces;
  const outside = (spaces: SideSpaces) => { for (const listener of layoutListeners) listener(spaces); };
  return { pages, main, commands, emit, settle, toasts, store, lastLayout, outside };
}

test('the pane keeps its tabs in step with main and opens addresses where the person works', async () => {
  const { pages, main, commands, emit, settle, toasts, lastLayout } = await pane();
  main.push(page('web-old', { restored: true }));
  pages.watchPersonalBrowser();
  await settle();
  assert.equal(pages.pagesListed.value, true);
  assert.deepEqual(pages.tabsOf('global'), [{ id: 'web-old', kind: 'website' }], 'restored tabs are listed, never selected by the list');

  pages.ensureTab();
  assert.equal(pages.tabsOf('global').length, 1, 'a pane with a tab needs no blank one');

  pages.addPage();
  const blank = pages.tabsOf('global').at(-1)!;
  assert.equal(blank.kind, 'new');
  assert.equal(pages.shownOf('global'), blank.id);
  pages.addPage();
  assert.equal(pages.tabsOf('global').length, 2, 'a second New tab shows the blank one again');

  await pages.goTo(blank.id, 'example.test/docs');
  assert.deepEqual(commands.filter((command) => command.action === 'open').at(-1), { action: 'open', id: blank.id, url: 'https://example.test/docs', space: 'global' });
  assert.equal(pages.tabsOf('global').find((item) => item.id === blank.id)?.kind, 'website', 'the blank tab became a website tab');
  assert.deepEqual(lastLayout()?.global, { shown: blank.id, tabs: [{ id: 'web-old' }, { id: blank.id }] }, 'main gets the order and the shown tab');

  await pages.goTo(blank.id, 'two words');
  assert.match((commands.filter((command) => command.action === 'open').at(-1) as { url: string }).url, /^https:\/\/www\.google\.com\/search\?q=two\+words$/, 'words search');
  await pages.goTo(blank.id, 'ftp://x.test/');
  assert.match(pages.openError.value?.message ?? '', /HTTP or HTTPS/, 'a refused address says why');

  main.push(page('web-agent', { background: true }));
  emit();
  assert.deepEqual(pages.tabsOf('global').map((item) => item.id), ['web-old', blank.id, 'web-agent'], 'a tab an agent opened joins the list');
  assert.equal(pages.shownOf('global'), blank.id, 'a background tab does not take the selection');
  main.push(page('web-popup'));
  emit();
  assert.equal(pages.shownOf('global'), 'web-popup', 'a page a site opened takes it');

  main.splice(main.findIndex((item) => item.id === 'web-agent'), 1);
  emit();
  assert.ok(!pages.tabsOf('global').some((item) => item.id === 'web-agent'), 'a tab main closed leaves the list');

  main.find((item) => item.id === 'web-old')!.download = { name: 'report.pdf', state: 'saved' };
  emit();
  emit();
  assert.deepEqual(toasts.value.map((toast) => [toast.title, toast.body]), [['Saved to downloads/personal', 'report.pdf']], 'one finished download, one toast');
});

test('closing tabs: the shown one hands over, others stay, the last leaves a blank tab', async () => {
  const { pages, main, commands, emit } = await pane();
  main.length = 0; // a new session: main has no tab, the pane's blank ones stay
  emit();
  commands.length = 0;
  for (const url of ['https://a.test/', 'https://b.test/', 'https://c.test/']) await pages.openWebsite(url);
  const [a, b, c] = pages.tabsOf('global').filter((item) => item.kind === 'website').map((item) => item.id) as [string, string, string];
  assert.equal(pages.shownOf('global'), c, 'the opened link is shown');
  assert.equal(await pages.openWebsite('https://b.test/'), b, 'a tab already at that address is only shown');
  assert.equal(pages.shownOf('global'), b);
  assert.equal(main.length, 3);

  await pages.closePage(b);
  assert.equal(pages.shownOf('global'), c, 'the next tab is shown');
  await pages.closePage(a);
  assert.equal(pages.shownOf('global'), c, 'a tab that was not shown closes: the choice stays');
  assert.deepEqual(commands.filter((command) => command.action === 'close').map((command) => (command as { id: string }).id), [b, a]);

  pages.addPage();
  await pages.closeOthers(c);
  assert.deepEqual(pages.tabsOf('global').map((item) => item.id), [c]);
  assert.equal(pages.shownOf('global'), c);
  await pages.closePage(c);
  assert.equal(pages.tabsOf('global').length, 1, 'closing the last tab leaves a blank one');
  assert.equal(pages.tabsOf('global')[0]!.kind, 'new');
  assert.equal(main.length, 0);
});

test('app tabs: one per thing, shown at once, kept in main\'s file and through main\'s list; find only on a website tab', async () => {
  const { pages, main, commands, emit, lastLayout } = await pane();
  main.length = 0;
  emit();
  await pages.openWebsite('https://site.test/');
  const site = pages.shownOf('global');
  assert.equal(pages.openFind(), true, 'Ctrl+F on a website tab opens its find field');
  assert.equal(pages.findOpen.value?.id, site);

  pages.openNotes('chat-1');
  assert.equal(pages.shownOf('global'), 'notes:chat-1');
  assert.equal(pages.findOpen.value, null, 'another tab closes the find field');
  assert.equal(pages.openFind(), false, 'no find field on an app tab');
  pages.openNotes('chat-1');
  pages.openVideo({ conversationId: 'chat-1' });
  pages.openVideo({ conversationId: 'chat-1', fileId: 'f2' });
  pages.openMedia({ fileId: 'f1' });
  pages.openMedia({});
  pages.openScreen();
  const apps = pages.tabsOf('global').filter((entry) => entry.kind !== 'website' && entry.kind !== 'new');
  assert.deepEqual(apps.map((entry) => entry.id), ['notes:chat-1', 'video:chat-1', 'media:f1', 'screen'], 'opening the same thing again shows its tab');
  assert.equal((apps[1] as { fileId?: string }).fileId, 'f2', 'a video tab opened on a file shows that file');
  pages.nameTab('media:f1', 'cover.png');
  assert.deepEqual(lastLayout()?.global?.tabs.filter((entry) => entry.panel).map((entry) => entry.name ?? entry.id), ['notes:chat-1', 'video:chat-1', 'cover.png', 'screen'], 'main keeps them');

  main.push(page('web-agent', { background: true }));
  emit();
  assert.ok(pages.tabsOf('global').some((entry) => entry.id === 'screen'), 'main\'s list leaves app tabs alone');
  commands.length = 0;
  await pages.closePage('screen');
  assert.deepEqual(commands.filter((command) => command.action !== 'layout'), [], 'closing an app tab only changes the layout');
  assert.equal(pages.shownOf('global'), 'web-agent');
  await pages.closeOthers(site);
  assert.deepEqual(pages.tabsOf('global').map((entry) => entry.id), [site]);
});

test('a panel asked to replace itself stays: a folder tab opening the path it already shows', async () => {
  const { pages } = await pane();
  pages.openPanel({ kind: 'folder', path: 'C:\\locked' });
  const id = pages.shownOf('global');
  pages.openPanel({ kind: 'folder', path: 'C:\\locked' }, id);
  assert.ok(pages.tabsOf('global').some((tab) => tab.id === id));
  assert.equal(pages.shownOf('global'), id);
  pages.closePage(id);
});

test('spaces: a chat\'s area has its own tabs and shown tab, the global pane only global ones; what an agent shows opens its surface', async () => {
  const { pages, main, emit, settle, lastLayout, outside } = await pane();
  await settle();
  const opened: string[] = [];
  pages.setOpener((space) => opened.push(space));
  const ids = (space: string) => pages.tabsOf(space).map((entry) => entry.id);
  const globalTabs = ids('global');
  const globalShown = pages.shownOf('global');
  const ada = (chatId: string) => ({ agentId: 'ag_ada', agentName: 'Ada', chatId });

  // An agent opens a tab in the chat, in the background: it is listed there, global does not notice, nothing opens.
  main.push(page('web-chat', { space: 'chat:ch_1', background: true, opener: ada('ch_1') }));
  emit();
  assert.deepEqual(ids('chat:ch_1'), ['web-chat']);
  assert.deepEqual(ids('global'), globalTabs);
  assert.equal(pages.shownOf('global'), globalShown);
  assert.equal(opened.length, 0, 'a tab in the background opens no surface'); // not deepEqual(opened, []): its assertion would narrow opened to never[]

  // Every command acts on its own space: a new tab in the chat's area takes its own address field.
  pages.addPage('chat:ch_1');
  const blank = pages.tabsOf('chat:ch_1').at(-1)!;
  assert.equal(blank.kind, 'new');
  assert.equal(pages.shownOf('chat:ch_1'), blank.id);
  assert.equal(pages.addressFocus.value.space, 'chat:ch_1', 'the area\'s address field, not the pane\'s');
  assert.deepEqual(lastLayout()?.['chat:ch_1'], { tabs: [{ id: 'web-chat' }] }, 'a blank tab goes nowhere');
  pages.selectPage('web-chat', 'chat:ch_1');
  assert.deepEqual(lastLayout()?.['chat:ch_1'], { shown: 'web-chat', tabs: [{ id: 'web-chat' }] });
  assert.deepEqual(ids('global'), globalTabs);

  // An empty chat gets its blank tab when its area asks; global stays as it is.
  pages.ensureTab('chat:ch_2');
  assert.equal(pages.tabsOf('chat:ch_2')[0]?.kind, 'new');
  assert.deepEqual(ids('global'), globalTabs);

  // A chat's notes open in its area and open it; a panel in place of a blank tab lands where that tab is.
  pages.openNotes('ch_1', 'chat:ch_1');
  assert.equal(pages.shownOf('chat:ch_1'), 'notes:ch_1');
  assert.ok(!ids('global').includes('notes:ch_1'), 'not in global');
  assert.deepEqual(opened, ['chat:ch_1']);
  pages.openPanel({ kind: 'day' }, blank.id);
  assert.deepEqual(ids('chat:ch_1'), ['web-chat', 'day', 'notes:ch_1'], 'My day took the blank tab\'s place in the chat\'s area');
  assert.ok(!ids('global').includes('day'));

  // browser.show (an agent's page, not in the background) is its space's shown tab and opens that surface.
  opened.length = 0;
  main.push(page('web-shown', { space: 'chat:ch_9', opener: ada('ch_9') }));
  emit();
  assert.equal(pages.shownOf('chat:ch_9'), 'web-shown');
  assert.deepEqual(opened, ['chat:ch_9']);
  assert.equal(pages.shownOf('global'), globalShown, 'global never changes by itself');

  // A space's own tabs only count for "a tab already at that address".
  const url = main.find((item) => item.id === 'web-shown')!.url;
  assert.equal(await pages.openWebsite(url, { space: 'chat:ch_9' }), 'web-shown');
  const own = await pages.openWebsite(url);
  assert.notEqual(own, 'web-shown');
  assert.equal(pages.shownOf('global'), own);
  assert.ok(!ids('chat:ch_9').includes(own!), 'the global tab stays in global');

  // Closing in one space leaves the other.
  await pages.closePage('day', 'chat:ch_1');
  assert.deepEqual(ids('chat:ch_1'), ['web-chat', 'notes:ch_1']);
  assert.ok(ids('global').includes(own!));

  // Someone edits the file: the panels and the shown tab follow; a blank tab stays.
  outside({ ...lastLayout()!, 'chat:ch_2': { shown: 'day', tabs: [{ id: 'day', panel: 'day' }] } });
  assert.deepEqual(pages.tabsOf('chat:ch_2').map((entry) => entry.kind), ['day', 'new']);
  assert.equal(pages.shownOf('chat:ch_2'), 'day');
  assert.deepEqual(ids('chat:ch_1'), ['web-chat', 'notes:ch_1'], 'the other spaces stay');

  // The same app tab in two spaces: a panel asked from it alone lands where it is shown, whatever the order of the spaces.
  pages.openPanel({ kind: 'day' });
  pages.selectPage(own!, 'global');
  assert.equal(Object.keys(lastLayout()!)[0], 'global', 'the pane holds My day first');
  opened.length = 0;
  pages.openPanel({ kind: 'folder', path: 'C:\\data' }, 'day');
  assert.deepEqual(pages.tabsOf('chat:ch_2').map((entry) => entry.kind), ['folder', 'new'], 'the area that shows My day');
  assert.ok(ids('global').includes('day'), 'the pane\'s My day stays');
  assert.deepEqual(opened, ['chat:ch_2']);

  // Where the frame has no global pane (the phone layout), a way in that names no space lands in the open chat's area.
  opened.length = 0;
  pages.setOpener((space) => opened.push(space), () => 'chat:ch_1');
  pages.openScreen();
  assert.equal(pages.shownOf('chat:ch_1'), 'screen');
  assert.ok(!ids('global').includes('screen'), 'not in global');
  assert.deepEqual(opened, ['chat:ch_1']);
  pages.setOpener(() => undefined);
});
