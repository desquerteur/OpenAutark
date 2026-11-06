// The tabs of the person's browser across restarts (main/workspace-tabs.ts, <data>/side-tabs.json): spaces (global, chat:<id>,
// agent:<id> – isSpace) with their panels, only http(s) addresses without user info and without
// token-like query/fragment are kept (a credential link or a token in the path: the site only),
// in order, at most MAX_TABS (B-055: 30) per space; unreadable entries are dropped; the old flat file moves over once; a change from outside is taken over;
// the file is written only when order or addresses change; a closed window parks live tabs as
// entries again. The address rule is shared/api/workspace-browser.ts keptAddress.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TABS, PersonalTabs, readSpaces, type TabFiles } from '../../../src/main/workspace-tabs.ts';
import { browserCommand } from '../../../src/main/workspace-commands.ts';
import { agentSpace, isSpace, keptAddress as savedUrl } from '../../../src/shared/api/workspace-browser.ts';

/** A saved file's websites, all spaces in order. */
const readSaved = (text: string | undefined) => Object.values(readSpaces(text) ?? {}).flatMap((space) => space.tabs.filter((tab) => tab.panel === undefined));
/** The entries not loaded yet, in order. */
const notLoaded = (tabs: PersonalTabs) => tabs.ids().filter((id) => tabs.restoredUrl(id)).map((id) => ({ id, url: tabs.restoredUrl(id) }));

function memoryFiles(initial?: string): TabFiles & { text?: string; writes: number } {
  const files = {
    text: initial, writes: 0,
    read: () => files.text,
    write: (_file: string, text: string) => { files.text = text; files.writes++; },
  };
  return files;
}

test('addresses: http(s) only, no user info, no token-like query or fragment', () => {
  assert.equal(savedUrl('https://example.com/docs?page=2#intro'), 'https://example.com/docs?page=2#intro');
  assert.equal(savedUrl('https://ann:secret@example.com/a'), 'https://example.com/a');
  assert.equal(savedUrl('https://app.example.com/callback?code=abc&state=xyz'), 'https://app.example.com/', 'an OAuth callback: its site only');
  assert.equal(savedUrl('https://app.example.com/home?code=abc&state=xyz'), 'https://app.example.com/home');
  assert.equal(savedUrl('https://example.com/#access_token=abc'), 'https://example.com/');
  assert.equal(savedUrl('https://example.com/s?sessionid=1&q=x'), 'https://example.com/s');
  assert.equal(savedUrl('https://example.com/search?q=cats'), 'https://example.com/search?q=cats');
  // Tokens in the path (review fix): reset, magic sign-in, verify, invite and callback links keep only their site.
  for (const link of ['https://app.example.com/reset-password/9f8e7d6c5b4a', 'https://app.example.com/magic/abc123def456', 'https://example.com/verify-email/u/42/k9Xq',
    'https://team.example.com/invite/QWERTY12', 'https://example.com/auth/callback', 'https://notion.example/loginwithemail', 'https://example.com/account/activate/77aa',
    'https://example.com/t/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0', `https://example.com/d/${'a1'.repeat(40)}`]) {
    assert.equal(savedUrl(link), `${new URL(link).origin}/`, link);
  }
  assert.equal(savedUrl('https://example.com/authors/ann'), 'https://example.com/authors/ann', 'a word that only starts like one');
  assert.equal(savedUrl('https://docs.example.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd/edit'), 'https://docs.example.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd/edit', 'a document id stays');
  assert.equal(savedUrl('file:///C:/secret.txt'), undefined);
  assert.equal(savedUrl('javascript:alert(1)'), undefined);
  assert.equal(savedUrl('not a url'), undefined);
});

test('a saved file is read entry by entry: bad ids, bad addresses and duplicates are left out, at most MAX_TABS (B-055: 30)', () => {
  const tabs = [
    { id: 'web-a', url: 'https://a.example/' }, { id: 'nope', url: 'https://b.example/' }, { id: 'web-c', url: 'file:///x' },
    { id: 'web-a', url: 'https://dup.example/' }, ...Array.from({ length: MAX_TABS + 2 }, (_, i) => ({ id: `web-n${i}`, url: `https://n${i}.example/` })),
  ];
  const read = readSaved(JSON.stringify({ version: 1, tabs }));
  assert.equal(read.length, MAX_TABS);
  assert.deepEqual(read.slice(0, 2), [{ id: 'web-a', url: 'https://a.example/' }, { id: 'web-n0', url: 'https://n0.example/' }]);
  assert.deepEqual(readSaved('{broken'), []);
  assert.deepEqual(readSaved(undefined), []);
});

test('restored tabs keep their order until shown; saving writes only real changes; a closed window parks live tabs', () => {
  const files = memoryFiles(JSON.stringify({ version: 1, tabs: [{ id: 'web-1', url: 'https://one.example/' }, { id: 'web-2', url: 'https://two.example/' }] }));
  const tabs = new PersonalTabs({ file: 'tabs.json', files });
  assert.deepEqual(notLoaded(tabs), [{ id: 'web-1', url: 'https://one.example/' }, { id: 'web-2', url: 'https://two.example/' }]);
  assert.equal(tabs.restoredUrl('web-2'), 'https://two.example/');

  tabs.save(new Map());
  assert.equal(files.writes, 0, 'nothing changed');
  tabs.shown('web-2'); // the person opened the second one: it loads, keeps its place
  tabs.shown('web-3'); // a new tab goes to the end
  assert.deepEqual(tabs.ids(), ['web-1', 'web-2', 'web-3']);
  tabs.save(new Map([['web-2', 'https://two.example/next?token=abc'], ['web-3', 'https://three.example/']]));
  assert.equal(files.writes, 1);
  assert.deepEqual(readSaved(files.text), [
    { id: 'web-1', url: 'https://one.example/' }, { id: 'web-2', url: 'https://two.example/next' }, { id: 'web-3', url: 'https://three.example/' },
  ], 'a not-yet-loaded tab keeps its saved address; the token is not saved');
  tabs.save(new Map([['web-2', 'https://two.example/next?token=other'], ['web-3', 'https://three.example/']]));
  assert.equal(files.writes, 1, 'the same saved state is not written again');

  tabs.closed('web-1');
  tabs.save(new Map([['web-2', 'https://two.example/next'], ['web-3', 'https://three.example/']]));
  assert.deepEqual(readSaved(files.text).map((tab) => tab.id), ['web-2', 'web-3']);

  // A page that is just starting to load shows about:blank: its last saved address is kept.
  tabs.save(new Map([['web-2', 'about:blank'], ['web-3', 'https://three.example/']]));
  assert.deepEqual(readSaved(files.text).map((tab) => tab.url), ['https://two.example/next', 'https://three.example/']);
  tabs.shown('web-4');
  tabs.park(new Map([['web-2', 'https://two.example/after'], ['web-3', 'about:blank'], ['web-4', 'about:blank']]));
  assert.deepEqual(notLoaded(tabs), [{ id: 'web-2', url: 'https://two.example/after' }, { id: 'web-3', url: 'https://three.example/' }], 'a tab that never had a web address is dropped');
  const restarted = new PersonalTabs({ file: 'tabs.json', files });
  assert.deepEqual(restarted.ids(), ['web-2', 'web-3'], 'the file keeps the last saved state until the next save');
});

test('spaces: a tab lives in one, panels and the shown tab go in the file, MAX_TABS counts per space', () => {
  const files = memoryFiles();
  const tabs = new PersonalTabs({ file: 'side-tabs.json', files });
  tabs.shown('web-a');
  tabs.shown('web-b', 'chat:ch_1', 'ag_ada');
  assert.equal(tabs.spaceOf('web-b'), 'chat:ch_1');
  assert.equal(tabs.byOf('web-b'), 'ag_ada');
  assert.equal(tabs.sizeOf('chat:ch_1'), 1);
  tabs.setLayout({ global: { shown: 'day', tabs: [{ id: 'day', panel: 'day' }, { id: 'web-a' }] }, 'chat:ch_1': { tabs: [{ id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' }] } });
  tabs.save(new Map([['web-a', 'https://a.example/'], ['web-b', 'https://b.example/x?token=1']]));
  assert.deepEqual(JSON.parse(files.text!), { version: 2, spaces: {
    global: { shown: 'day', tabs: [{ id: 'day', panel: 'day' }, { id: 'web-a', url: 'https://a.example/' }] },
    'chat:ch_1': { tabs: [{ id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' }, { id: 'web-b', url: 'https://b.example/x', by: 'ag_ada' }] },
  } }, 'a website the window does not list yet stays, at its space\'s end');
  assert.equal(tabs.shownOf('global'), 'day');

  const back = new PersonalTabs({ file: 'side-tabs.json', files });
  assert.deepEqual(back.ids(), ['web-a', 'web-b']);
  assert.equal(back.restoredUrl('web-b'), 'https://b.example/x', 'it survives a restart and loads when used');
  assert.equal(back.spaceOf('web-b'), 'chat:ch_1');
  assert.equal(back.byOf('web-b'), 'ag_ada');
  assert.deepEqual(back.layout()['chat:ch_1']!.tabs[0], { id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' });

  const many = Array.from({ length: MAX_TABS + 5 }, (_, i) => ({ id: `web-n${i}`, url: `https://n${i}.example/` }));
  const full = readSpaces(JSON.stringify({ version: 2, spaces: { global: { tabs: many }, 'chat:x': { tabs: [{ id: 'web-c', url: 'https://c.example/' }] }, 'nonsense': { tabs: many }, 'chat:../x': { tabs: many } } }))!;
  assert.equal(full.global!.tabs.length, MAX_TABS);
  assert.deepEqual(Object.keys(full), ['global', 'chat:x'], 'only real spaces');
});

test("an agent's area is a space of its own (agent:<id>): the file keeps it, the window may lay it out, a website opens there", () => {
  assert.equal(agentSpace('ag_ada'), 'agent:ag_ada');
  for (const ok of ['global', 'chat:ch_1', 'agent:ag_ada', 'agent:a.b-c:1']) assert.ok(isSpace(ok), ok);
  for (const bad of ['agent:', 'agent:../x', 'agents:ag', 'person:p1', 'agent:a b', `agent:${'x'.repeat(129)}`, 7]) assert.ok(!isSpace(bad), String(bad));
  const files = memoryFiles(JSON.stringify({ version: 2, spaces: { 'agent:ag_ada': { shown: 'notes:ch_1', tabs: [{ id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' }, { id: 'web-r', url: 'https://report.example/', by: 'ag_ada' }] } } }));
  const tabs = new PersonalTabs({ file: 'side-tabs.json', files });
  assert.equal(tabs.spaceOf('web-r'), 'agent:ag_ada');
  assert.equal(tabs.shownOf('agent:ag_ada'), 'notes:ch_1');
  tabs.shown('web-s', 'agent:ag_ada', 'ag_ada');
  tabs.setLayout({ ...tabs.layout(), 'agent:ag_bo': { tabs: [{ id: 'screen', panel: 'screen' }] } });
  tabs.save(new Map([['web-r', 'https://report.example/'], ['web-s', 'https://second.example/']]));
  assert.deepEqual(JSON.parse(files.text!).spaces, {
    'agent:ag_ada': { shown: 'notes:ch_1', tabs: [{ id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' }, { id: 'web-r', url: 'https://report.example/', by: 'ag_ada' }, { id: 'web-s', url: 'https://second.example/', by: 'ag_ada' }] },
    'agent:ag_bo': { tabs: [{ id: 'screen', panel: 'screen' }] },
  });
  assert.equal(browserCommand({ action: 'open', id: 'web-t', url: 'https://t.example/', space: 'agent:ag_ada' }).action, 'open');
  assert.throws(() => browserCommand({ action: 'open', id: 'web-t', url: 'https://t.example/', space: 'agent:../x' }), /Invalid browser space/);
});

test('the old flat file moves over once', () => {
  const store = new Map<string, string>([['old.json', JSON.stringify({ version: 1, tabs: [{ id: 'web-1', url: 'https://one.example/' }] })]]);
  const files: TabFiles = { read: (file) => store.get(file), write: (file, text) => { store.set(file, text); }, remove: (file) => { store.delete(file); } };
  const tabs = new PersonalTabs({ file: 'side-tabs.json', oldFile: 'old.json', files });
  assert.deepEqual(tabs.ids(), ['web-1']);
  assert.equal(store.has('old.json'), false);
  assert.deepEqual(JSON.parse(store.get('side-tabs.json')!).spaces.global.tabs, [{ id: 'web-1', url: 'https://one.example/' }]);
  assert.deepEqual(new PersonalTabs({ file: 'side-tabs.json', oldFile: 'old.json', files }).ids(), ['web-1'], 'and is not looked for again');
});

test('a change from outside is taken over: new tabs wait as entries, gone ones close, a new address navigates; broken text changes nothing', () => {
  const files = memoryFiles();
  const tabs = new PersonalTabs({ file: 'side-tabs.json', files });
  tabs.shown('web-live');
  tabs.shown('web-gone');
  tabs.save(new Map([['web-live', 'https://live.example/'], ['web-gone', 'https://gone.example/']]));
  assert.equal(tabs.reload(), undefined, 'our own write is nothing new');
  files.text = JSON.stringify({ version: 2, spaces: { global: { tabs: [{ id: 'web-live', url: 'https://live.example/next' }, { id: 'day', panel: 'day' }] }, 'chat:c': { shown: 'web-new', tabs: [{ id: 'web-new', url: 'https://new.example/' }] } } });
  assert.deepEqual(tabs.reload(), { closed: ['web-gone'], navigate: [{ id: 'web-live', url: 'https://live.example/next' }] });
  assert.equal(tabs.restoredUrl('web-new'), 'https://new.example/');
  assert.equal(tabs.spaceOf('web-new'), 'chat:c');
  assert.equal(tabs.shownOf('chat:c'), 'web-new');
  files.text = '{broken';
  assert.equal(tabs.reload(), undefined);
  assert.deepEqual(tabs.ids(), ['web-live', 'web-new']);
});

test('a save never writes over an outside edit that is not taken over yet; a broken file does get overwritten; a file in another form than ours does not count as an edit', () => {
  const files = memoryFiles();
  const tabs = new PersonalTabs({ file: 'side-tabs.json', files });
  tabs.shown('web-keep');
  tabs.shown('web-gone', 'chat:c');
  const live = new Map([['web-keep', 'https://keep.example/'], ['web-gone', 'https://gone.example/']]);
  tabs.save(live);
  // the chat's space leaves the file (runtime/root/side-tabs.ts) while a save is on its way, before the watcher's reload
  const edited = JSON.stringify({ version: 2, spaces: { global: { tabs: [{ id: 'web-keep', url: 'https://keep.example/' }] } } });
  files.text = edited;
  tabs.save(new Map([...live, ['web-keep', 'https://keep.example/moved']]));
  assert.equal(files.text, edited, 'the edit stands');
  assert.deepEqual(tabs.reload()?.closed, ['web-gone']);
  tabs.save(new Map([['web-keep', 'https://keep.example/moved']]));
  assert.ok(!Object.hasOwn(JSON.parse(files.text!).spaces, 'chat:c'));
  assert.equal(readSaved(files.text)[0].url, 'https://keep.example/moved', 'after the reload saving goes on');

  files.text = '{broken';
  tabs.save(new Map([['web-keep', 'https://keep.example/again']]));
  assert.equal(readSaved(files.text)[0].url, 'https://keep.example/again');

  const compact = memoryFiles(edited);
  const started = new PersonalTabs({ file: 'side-tabs.json', files: compact });
  started.shown('web-keep');
  started.save(new Map([['web-keep', 'https://keep.example/later']]));
  assert.equal(readSaved(compact.text)[0].url, 'https://keep.example/later', 'the form it had at the start is no edit');

  const other = memoryFiles(edited);
  const reread = new PersonalTabs({ file: 'side-tabs.json', files: other });
  other.text = `${JSON.stringify({ version: 2, spaces: JSON.parse(edited).spaces }, null, 1)}\n`; // an outside edit that lands on exactly what this holds
  assert.equal(reread.reload(), undefined);
  reread.save(new Map([['web-keep', 'https://keep.example/later']]));
  assert.equal(readSaved(other.text)[0].url, 'https://keep.example/later', 'saving goes on');
});

test('a read-only profile: saving fails quietly', () => {
  const files: TabFiles = { read: () => undefined, write: () => { throw new Error('EROFS'); } };
  const tabs = new PersonalTabs({ file: 'tabs.json', files });
  tabs.shown('web-1');
  assert.doesNotThrow(() => tabs.save(new Map([['web-1', 'https://one.example/']])));
});
