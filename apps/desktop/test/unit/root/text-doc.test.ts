// B-044: the data folder's text documents (runtime/root/text-doc.ts) on a temp folder –
// - canonical compare and the stale-base rule; the bounded, validated read (missing, too large, not text,
//   a folder or a link instead of a file);
// - the atomic write (folder created, no temporary file left, the watcher told) and the app's own write
//   versus an outside edit (isOutside, adopt), the read cache following the file;
// - writeFrom: same, conflict (the file left alone), written – also over a missing or a problem file, which
//   is kept as the rejected copy; the rejected copy's name, move and copy;
// - the quiet notice hook (notice.ts): told only when a problem comes, changes or goes.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TextNotice } from '../../../src/runtime/root/notice.ts';
import { canonical, isRejectedName, readText, rejectedPath, staleBase, TextDoc, writeAtomic, type OwnWrites } from '../../../src/runtime/root/text-doc.ts';
import { clock, tempDir } from '../store/helpers.ts';

const LIMITS = { maxBytes: 64, maxChars: 20 };

function setup() {
  const temp = tempDir('wf-text-doc-');
  const time = clock();
  const writes: Array<[string, string | null]> = [];
  const own: OwnWrites = { wrote: (file, content) => { writes.push([file, content]); } };
  const notices: Array<TextNotice | undefined> = [];
  const file = path.join(temp.dir, 'prompts', 'identity.md');
  const doc = new TextDoc<string>({ file, limits: { maxBytes: 256, maxChars: 100 }, clock: time, writes: own, onNotice: (notice) => { notices.push(notice); } });
  return { temp, time, writes, notices, file, doc, read: () => readFileSync(file, 'utf8') };
}

test('canonical and staleBase: BOM, CR and trailing white space are no change; a stale base only when the text moved on', () => {
  assert.equal(canonical('﻿a\r\nb\r  \n\n'), 'a\nb');
  assert.equal(staleBase('B', 'A', 'C'), true, 'changed meanwhile, the edit says something else');
  assert.equal(staleBase('B\r\n', 'B', 'C'), false, 'the base is current');
  assert.equal(staleBase('B', 'A', 'B\n'), false, 'the edit already says what is there');
});

test('readText: missing, ok, too large (bytes or characters), not text, a folder or a link is unreadable', () => {
  const t = tempDir('wf-text-read-');
  try {
    const file = (name: string, content?: string | Buffer) => {
      const target = path.join(t.dir, name);
      if (content !== undefined) writeFileSync(target, content);
      return target;
    };
    assert.deepEqual(readText(file('none.md'), LIMITS), { kind: 'missing' });
    const ok = readText(file('ok.md', 'Hello.\r\n'), LIMITS);
    assert.equal(ok.kind === 'ok' && ok.text, 'Hello.');
    assert.equal(readText(file('big.md', 'x'.repeat(65)), LIMITS).kind, 'problem');
    const long = readText(file('long.md', 'y'.repeat(21)), LIMITS);
    assert.equal(long.kind === 'problem' && long.problem, 'too-large');
    const nul = readText(file('nul.md', Buffer.from([0x61, 0x00, 0x62])), LIMITS);
    assert.equal(nul.kind === 'problem' && nul.problem, 'not-text');
    const latin = readText(file('latin.md', Buffer.from([0x61, 0xe4, 0x62])), LIMITS);
    assert.equal(latin.kind === 'problem' && latin.problem, 'not-text');
    mkdirSync(path.join(t.dir, 'folder.md'));
    const folder = readText(path.join(t.dir, 'folder.md'), LIMITS);
    assert.equal(folder.kind === 'problem' && folder.problem, 'unreadable');
    let linked = false;
    try { symlinkSync(path.join(t.dir, 'ok.md'), path.join(t.dir, 'link.md')); linked = true; } catch { /* no symlink right on this PC */ }
    if (linked) {
      const link = readText(path.join(t.dir, 'link.md'), LIMITS);
      assert.equal(link.kind === 'problem' && link.problem, 'unreadable', 'a link is never followed');
    }
  } finally { t.cleanup(); }
});

test('write: atomic into a new folder, the watcher told; an outside edit is outside until adopted; the cache follows the file', () => {
  const t = setup();
  try {
    t.doc.write('Own.\n');
    assert.equal(t.read(), 'Own.\n');
    assert.deepEqual(readdirSync(path.dirname(t.file)), ['identity.md'], 'no temporary file left');
    assert.deepEqual(t.writes, [[t.file, 'Own.\n']]);
    const own = t.doc.check();
    assert.equal(own.kind === 'ok' && own.text, 'Own.');
    assert.equal(t.doc.isOutside(own), false, 'the app wrote it');
    assert.equal(t.doc.check(), own, 'unchanged: the cached read');

    writeFileSync(t.file, 'Outside, longer.\n');
    const outside = t.doc.check();
    assert.equal(outside.kind === 'ok' && outside.text, 'Outside, longer.');
    assert.equal(t.doc.isOutside(outside), true);
    if (outside.kind === 'ok') t.doc.adopt(outside.sig);
    assert.equal(t.doc.isOutside(t.doc.check()), false, 'taken over');
    assert.equal(t.doc.isOutside({ kind: 'missing' }), true);

    writeAtomic(path.join(t.temp.dir, 'a', 'b', 'c.json'), '{}\n');
    assert.equal(readFileSync(path.join(t.temp.dir, 'a', 'b', 'c.json'), 'utf8'), '{}\n', 'without a watcher too');
  } finally { t.temp.cleanup(); }
});

test('writeFrom: same, conflict (the file left alone), written – over a missing file and over a problem file kept aside', () => {
  const t = setup();
  try {
    assert.equal(t.doc.writeFrom('', 'First.'), 'written', 'missing: written');
    assert.equal(t.read(), 'First.');
    assert.equal(t.doc.writeFrom('Old.', 'First.\r\n'), 'same');
    writeFileSync(t.file, 'Changed in an editor.');
    assert.equal(t.doc.writeFrom('First.', 'Second.'), 'conflict');
    assert.equal(t.read(), 'Changed in an editor.', 'never overwritten unseen');
    assert.equal(t.doc.writeFrom('Changed in an editor.\n', 'Second.'), 'written', 'the base is current');
    assert.equal(t.read(), 'Second.');

    writeFileSync(t.file, Buffer.from([0x00, 0x01]));
    assert.equal(t.doc.writeFrom('Second.', 'Third.'), 'written');
    assert.equal(t.read(), 'Third.');
    assert.deepEqual([...readFileSync(path.join(path.dirname(t.file), 'identity.rejected.md'))], [0x00, 0x01], 'the problem file is kept once');
  } finally { t.temp.cleanup(); }
});

test('rejected copy: <name>.rejected.<ext>, moved or copied, and a text the app refused', () => {
  const t = setup();
  try {
    assert.equal(path.basename(rejectedPath('/x/SYSTEM.md')), 'SYSTEM.rejected.md');
    assert.equal(path.basename(rejectedPath('/x/settings.json')), 'settings.rejected.json');
    assert.equal(path.basename(rejectedPath('/x/README')), 'README.rejected');
    assert.equal(isRejectedName('settings.rejected.json'), true);
    assert.equal(isRejectedName('SYSTEM.md'), false);

    const kept = path.join(path.dirname(t.file), 'identity.rejected.md');
    assert.equal(t.doc.keepRejected(), false, 'nothing to keep');
    t.doc.write('One.\n');
    assert.equal(t.doc.keepRejected('copy'), true);
    assert.equal(readFileSync(kept, 'utf8'), 'One.\n');
    assert.ok(existsSync(t.file), 'a copy leaves the file');
    t.doc.write('Two.\n');
    assert.equal(t.doc.keepRejected(), true);
    assert.equal(readFileSync(kept, 'utf8'), 'Two.\n', 'an older copy goes');
    assert.equal(t.doc.check().kind, 'missing', 'moved away');
    t.doc.writeRejected('{"broken": true}\n');
    assert.equal(readFileSync(kept, 'utf8'), '{"broken": true}\n');
    assert.deepEqual(t.writes.at(-1), [kept, '{"broken": true}\n'], 'the watcher hears about it too');
  } finally { t.temp.cleanup(); }
});

test('quiet notice: the hook hears a problem when it comes, changes or goes – never twice', () => {
  const t = setup();
  try {
    assert.equal(t.doc.setNotice(undefined), false, 'nothing to clear');
    assert.equal(t.doc.setNotice('invalid', 'The section "voice" is not valid.'), true);
    t.time.advance(5);
    assert.equal(t.doc.setNotice('invalid', 'The section "voice" is not valid.'), false);
    assert.equal(t.doc.setNotice('invalid', 'The section "day" is not valid.'), true);
    assert.equal(t.doc.notice?.detail, 'The section "day" is not valid.');
    assert.equal(t.doc.setNotice(undefined), true);
    assert.equal(t.doc.notice, undefined);
    assert.deepEqual(t.notices.map((notice) => notice?.problem), ['invalid', 'invalid', undefined]);
    const start = t.notices[0]!.at;
    assert.deepEqual(t.notices.map((notice) => notice && notice.at - start), [0, 5, undefined]);
  } finally { t.temp.cleanup(); }
});
