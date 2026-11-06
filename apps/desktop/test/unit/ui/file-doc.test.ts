// The file tab's loop against a fake disk: what is typed, saved and followed; line ends survive the text field's LF; a change
// under typed text is a notice and a save over it the person's answer; a tab's id and path rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PathRead } from '../../../src/shared/api/methods-files.ts';
import { FileDoc, fileStatus } from '../../../src/ui/workspace/file-doc.ts';
import { appTabId, appTabsOf } from '../../../src/ui/workspace/browser-model.ts';

class Conflict extends Error {}

function disk(start: string | null) {
  const f = {
    text: start, stamp: 1, writes: [] as Array<{ text: string; base?: string }>, failWrite: '',
    read: async (_path: string, since?: string): Promise<PathRead> => {
      const stamp = f.text === null ? '' : String(f.stamp);
      if (since === stamp) return { path: 'p', state: 'same', size: 0, stamp };
      if (f.text === null) return { path: 'p', state: 'missing', size: 0, stamp };
      return { path: 'p', state: 'text', size: f.text.length, stamp, text: f.text };
    },
    write: async (_path: string, text: string, base?: string) => {
      if (f.failWrite) throw new Error(f.failWrite);
      f.writes.push({ text, ...(base === undefined ? {} : { base }) });
      if (base !== undefined && base !== (f.text === null ? '' : String(f.stamp))) throw new Conflict();
      f.text = text; f.stamp++;
      return { path: 'p', size: text.length, stamp: String(f.stamp) };
    },
    change: (text: string) => { f.text = text; f.stamp++; },
    conflict: (error: unknown) => error instanceof Conflict,
    errorText: (error: unknown) => (error as Error).message,
  };
  return f;
}

test('a save writes what was typed on the stamp it was made on, and the dirty mark follows the text', async () => {
  const f = disk('one');
  const doc = new FileDoc('p', f);
  await doc.load();
  assert.equal(doc.text, 'one');
  assert.equal(doc.state.value.phase, 'text');
  doc.edit('two');
  assert.equal(doc.state.value.dirty, true);
  doc.edit('one');
  assert.equal(doc.state.value.dirty, false, 'typed back to what is saved');
  await doc.save();
  assert.equal(f.writes.length, 0, 'nothing to save');
  doc.edit('two');
  await doc.save();
  assert.deepEqual(f.writes, [{ text: 'two', base: '1' }]);
  assert.equal(doc.state.value.dirty, false);
  assert.equal(f.text, 'two');
});

test('CR LF line ends are shown as LF and written back', async () => {
  const f = disk('a\r\nb\r\n');
  const doc = new FileDoc('p', f);
  await doc.load();
  assert.equal(doc.text, 'a\nb\n');
  doc.edit('a\nb\nc\n');
  await doc.save();
  assert.equal(f.text, 'a\r\nb\r\nc\r\n');
});

test('a change on disk is followed while nothing typed waits', async () => {
  const f = disk('one');
  const doc = new FileDoc('p', f);
  await doc.load();
  const revision = doc.state.value.revision;
  await doc.poll();
  assert.equal(doc.state.value.revision, revision, 'unchanged: nothing happens');
  f.change('from an agent');
  await doc.poll();
  assert.equal(doc.text, 'from an agent');
  assert.equal(doc.state.value.followed, true);
  assert.ok(doc.state.value.revision > revision);
  assert.match(fileStatus(doc.state.value, '13 B'), /reloaded/);
  doc.edit('from an agent!');
  assert.equal(doc.state.value.followed, false);
});

test('a change under typed text is a notice: Reload takes the disk, Ctrl+S keeps the text', async () => {
  const f = disk('one');
  const doc = new FileDoc('p', f);
  await doc.load();
  doc.edit('mine');
  f.change('theirs');
  await doc.poll();
  assert.equal(doc.text, 'mine', 'typed text stays');
  assert.equal(doc.state.value.changed, true);
  assert.match(fileStatus(doc.state.value, ''), /Changed on disk/);
  await doc.load();
  assert.equal(doc.text, 'theirs');
  assert.equal(doc.state.value.changed, false);
  assert.equal(doc.state.value.dirty, false);

  doc.edit('mine again');
  f.change('theirs again');
  await doc.poll();
  await doc.save();
  assert.equal(f.text, 'mine again');
  assert.equal(f.writes.at(-1)?.base, undefined, 'with the notice up a save overwrites');
  assert.equal(doc.state.value.changed, false);
});

test('a save that meets a newer file becomes the notice instead of overwriting', async () => {
  const f = disk('one');
  const doc = new FileDoc('p', f);
  await doc.load();
  doc.edit('mine');
  f.change('theirs'); // no poll came between
  await doc.save();
  assert.equal(f.text, 'theirs');
  assert.equal(doc.state.value.changed, true);
  assert.equal(doc.state.value.dirty, true);
  await doc.save();
  assert.equal(f.text, 'mine');
});

test('a missing file is a new one: a save creates it, also empty; a failed save keeps the text and says why', async () => {
  const f = disk(null);
  const doc = new FileDoc('p', f);
  await doc.load();
  assert.equal(doc.state.value.fresh, true);
  assert.match(fileStatus(doc.state.value, ''), /New file/);
  f.failWrite = 'The system does not allow writing p.';
  await doc.save();
  assert.equal(doc.state.value.error, f.failWrite);
  f.failWrite = '';
  await doc.save();
  assert.equal(f.text, '');
  assert.equal(doc.state.value.fresh, false);
});

test('a look that crossed our own save is no change on disk', async () => {
  const f = disk('one');
  let answer!: (read: PathRead) => void;
  const crossing = new FileDoc('p', { ...f, read: (at, since) => since === undefined ? f.read(at) : new Promise<PathRead>((resolve) => { answer = resolve; }) });
  await crossing.load();
  crossing.edit('two');
  const look = crossing.poll();
  await crossing.save();
  crossing.edit('two more');
  answer({ path: 'p', state: 'text', size: 3, stamp: String(f.stamp), text: 'two' });
  await look;
  assert.equal(crossing.state.value.changed, false);
  assert.equal(crossing.text, 'two more');
});

test('a Reload that fails keeps the field and the draft, and says why', async () => {
  const f = disk('one');
  let locked = false;
  const doc = new FileDoc('p', { ...f, read: (at, since) => { if (locked) throw new Error('locked'); return f.read(at, since); } });
  await doc.load();
  doc.edit('typed');
  locked = true;
  await doc.load();
  assert.equal(doc.state.value.phase, 'text');
  assert.equal(doc.state.value.error, 'locked');
  assert.equal(doc.state.value.dirty, true);
  assert.equal(doc.text, 'typed');
});

test('other contents only say what they are, and open keeps a draft', async () => {
  const doc = new FileDoc('p', { ...disk('x'), read: async () => ({ path: 'p', state: 'binary', size: 9, stamp: '1' }) });
  await doc.open();
  assert.equal(doc.state.value.phase, 'binary');
  const f = disk('one');
  const draft = new FileDoc('p', f);
  await draft.open();
  draft.edit('typed');
  await draft.open();
  assert.equal(draft.text, 'typed');
  assert.equal(draft.state.value.dirty, true);
});

test('file and folder tabs are one tab per path and come back from storage', () => {
  assert.equal(appTabId({ kind: 'file', path: 'C:\\a\\b.md' }), 'file:C:\\a\\b.md');
  assert.equal(appTabId({ kind: 'folder', path: '/a' }), 'folder:/a');
  assert.deepEqual(appTabsOf([
    { id: 'file:/a/b.md', kind: 'file', path: '/a/b.md' },
    { id: 'folder:/a', kind: 'folder', path: '/a' },
    { id: 'file:/other', kind: 'file', path: '/a/b.md' },
    { id: 'file:', kind: 'file' },
  ]).map((tab) => tab.id), ['file:/a/b.md', 'folder:/a']);
});
