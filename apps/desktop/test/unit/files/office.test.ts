// Office documents as text (files/office.ts on files/zip.ts + xml-scan.ts): Word headings from the
// document's own (localized) styles, lists, tables, text boxes once, no tracked deletions or field
// codes, footnotes; Excel sheets in workbook order with shared/inline/boolean/number cells aligned by
// column; PowerPoint slides in presentation order with titles and notes, no slide-number chrome.
// Limits: a "zip bomb" entry stops at the inflate budget, a damaged or encrypted package yields ''.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICE_LIMITS, officeKind, officeText } from '../../../src/runtime/files/office.ts';
import { ZIP_LIMITS, ZipError, readEntry, zipBudget, zipEntries } from '../../../src/runtime/files/zip.ts';
import { resolvePart, xmlTokens } from '../../../src/runtime/files/xml-scan.ts';
import { docx, pptx, xlsx, zip } from './office-fixture.ts';

test('docx: headings from localized styles, lists, tables, a text box once, no deletions or field codes, footnotes', async () => {
  const text = await officeText(docx(), 'docx');
  const lines = text.split('\n');
  assert.equal(lines[0], '# Quarterly plan');
  assert.ok(lines.includes('Budget & scope \tQ4'), text);
  assert.ok(lines.includes('- First step'));
  assert.ok(lines.includes('Field result'));
  assert.ok(lines.includes('| Owner | Due |'));
  assert.ok(lines.includes('| Mara | 2026-11-01 |'));
  assert.equal(text.split('Box text').length - 1, 1, 'the fallback copy of the text box is skipped');
  assert.ok(!text.includes('old wording'), 'tracked deletions are not text');
  assert.ok(!text.includes('PAGEREF'), 'field codes are not text');
  assert.match(text, /## Footnotes\nSource: board minutes/);
});

test('xlsx: sheets in workbook order, shared and inline strings, booleans, numbers, aligned columns, no formulas', async () => {
  const text = await officeText(xlsx(), 'xlsx');
  assert.equal(text, ['# Revenue', '| Region |  | Total |', '| North | TRUE | 1250.5 |', '', '# Notes', '| Checked by finance |'].join('\n'));
  assert.ok(!text.includes('SUM('), 'formulas are not text');
  assert.ok(!text.includes('ノース'), 'phonetic runs are skipped');
});

test('pptx: slides in presentation order with titles, body text and notes; slide numbers and images left out', async () => {
  const text = await officeText(pptx(), 'pptx');
  assert.equal(text, ['# Slide 1: Launch review', 'Goals', 'Risks', '', '# Slide 2: Next steps', 'Hire an editor', 'Notes: Mention the budget'].join('\n'));
});

test('limits: an entry that inflates beyond the budget stops there; damaged, encrypted or foreign packages yield nothing', async () => {
  const bomb = zip([{ name: 'word/document.xml', data: Buffer.alloc(2 * 1024 * 1024, 0x41), claimSize: 10 }]);
  const entry = zipEntries(bomb).get('word/document.xml')!;
  await assert.rejects(readEntry(bomb, entry, zipBudget(1024 * 1024)), (error: unknown) => error instanceof ZipError && /too large/.test(error.message));
  const claimed = zip([{ name: 'a.xml', data: 'x', claimSize: ZIP_LIMITS.entryBytes + 1 }]);
  await assert.rejects(readEntry(claimed, zipEntries(claimed).get('a.xml')!, zipBudget()), /too large/);
  assert.equal(await officeText(Buffer.from('not a zip at all'), 'docx'), '');
  const truncated = docx().subarray(0, 200);
  assert.equal(await officeText(truncated, 'docx'), '');
  const locked = zip([{ name: '_rels/.rels', data: '<x/>' }, { name: 'word/document.xml', data: '<w:document/>', flags: 0x1 }]);
  assert.equal(await officeText(locked, 'docx'), '');
  assert.equal(await officeText(xlsx(), 'docx'), '', 'a workbook has no Word document part');
  assert.equal(await officeText(Buffer.alloc(OFFICE_LIMITS.bytes + 1), 'docx'), '', 'oversized files are not opened');
});

test('a long document is cut at the character limit with a marker', async () => {
  const paragraph = `<w:p><w:r><w:t>${'word '.repeat(2000)}</w:t></w:r></w:p>`;
  const body = `<w:document xmlns:w="w"><w:body>${paragraph.repeat(120)}</w:body></w:document>`;
  const bytes = zip([{ name: 'word/document.xml', data: body }]);
  const text = await officeText(bytes, 'docx');
  assert.ok(text.length <= OFFICE_LIMITS.chars + 20, `${text.length}`);
  assert.ok(text.endsWith('[truncated]'));
});

test('scanner: tokens as before, and crafted unclosed constructs stay linear (no event-loop stall)', async () => {
  assert.deepEqual([...xmlTokens('<?xml v?><!-- c --><a x="1 > 2" y=\'q\'/>t&amp;u<![CDATA[<raw>]]><b/></a><!DOCTYPE z>< nope>end')], [
    { kind: 'open', name: 'a', attrs: ' x="1 > 2" y=\'q\'', empty: true }, { kind: 'text', text: 't&u' }, { kind: 'text', text: '<raw>' },
    { kind: 'open', name: 'b', attrs: '', empty: true }, { kind: 'close', name: 'a' }, { kind: 'text', text: ' nope>end' },
  ]);
  // A raw '<' inside a tag (not well-formed): no tag – that '<' is skipped and what follows reads as text.
  assert.deepEqual([...xmlTokens('<a y=\'<\'/>z')], [{ kind: 'text', text: 'a y=\'' }, { kind: 'text', text: '\'/>z' }]);
  assert.deepEqual([...xmlTokens('<w:t xml:space="preserve">a b</w:t><w:br/>')], [
    { kind: 'open', name: 'w:t', attrs: ' xml:space="preserve"', empty: false }, { kind: 'text', text: 'a b' }, { kind: 'close', name: 'w:t' },
    { kind: 'open', name: 'w:br', attrs: '', empty: true },
  ]);
  const crafted = ['<a '.repeat(200_000), '<!--x'.repeat(100_000), '<a b="'.repeat(100_000), '<?x'.repeat(100_000), '<![CDATA['.repeat(50_000), `<w:p>${' '.repeat(300_000)}x</w:p>`];
  for (const part of crafted) {
    const started = performance.now();
    let count = 0;
    for (const _token of xmlTokens(part)) count++;
    const took = performance.now() - started;
    assert.ok(took < 1500, `${part.slice(0, 12)}…: ${Math.round(took)} ms for ${count} tokens`);
  }
  const started = performance.now();
  const spaces = `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${' \t'.repeat(400_000)}x${' '.repeat(400_000)}</w:t></w:r></w:p></w:body></w:document>`;
  assert.equal(await officeText(zip([{ name: 'word/document.xml', data: spaces }]), 'docx'), 'x');
  assert.ok(performance.now() - started < 3000, 'long whitespace runs are trimmed in linear time');
});

test('kinds and part paths', () => {
  assert.equal(officeKind('DOCX'), 'docx');
  assert.equal(officeKind('application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'pptx');
  assert.equal(officeKind('doc'), undefined, 'legacy binary formats are not read');
  assert.equal(resolvePart('ppt/slides', '../notesSlides/n1.xml'), 'ppt/notesSlides/n1.xml');
  assert.equal(resolvePart('xl', '/xl/worksheets/s.xml'), 'xl/worksheets/s.xml');
  assert.equal(resolvePart('', '../../x.xml'), 'x.xml', 'never above the package root');
});
