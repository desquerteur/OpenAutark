// Excel (.xlsx) text for office.ts: sheets in workbook order (`# <sheet>`), shared and inline strings
// (phonetic runs skipped), numbers and booleans, one `| a | b |` line per row with cells aligned by
// column (up to OFFICE_LIMITS.columns), at most OFFICE_LIMITS.rows rows per sheet; formulas are not text.
// Owns: these rules. Never: evaluates formulas or reads external links.

import { attr, localName, resolvePart, xmlTokens } from './xml-scan.ts';
import { OFFICE_LIMITS, cells, folderOf, type Out, type Package } from './office-package.ts';

function sharedStrings(xml: string | undefined): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let current: string | undefined;
  let inText = false;
  let phonetic = 0;
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'text') { if (inText && !phonetic && current !== undefined) current += token.text; continue; }
    const name = localName(token.name);
    if (token.kind === 'open') {
      if (name === 'si') current = token.empty ? undefined : '';
      if (token.empty && name === 'si') out.push('');
      else if (name === 'rPh' && !token.empty) phonetic++;
      else if (name === 't') inText = !token.empty;
    } else if (name === 'si') { out.push(current ?? ''); current = undefined; }
    else if (name === 'rPh') phonetic = Math.max(0, phonetic - 1);
    else if (name === 't') inText = false;
  }
  return out;
}

/** 'C7' → 2 (zero-based column), undefined without letters. */
function column(ref: string | undefined): number | undefined {
  const letters = /^([A-Z]{1,3})\d*$/i.exec(ref ?? '')?.[1]?.toUpperCase();
  if (!letters) return undefined;
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function sheetText(xml: string, shared: readonly string[], out: Out): void {
  let row: string[] | undefined;
  let rows = 0;
  let cell: { type?: string; col?: number; value: string } | undefined;
  let capture: 'v' | 't' | undefined;
  let inline = false;
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'text') { if (capture && cell) cell.value += token.text; continue; }
    const name = localName(token.name);
    if (token.kind === 'open') {
      if (name === 'row' && !token.empty) row = [];
      else if (name === 'c' && !token.empty) cell = { type: attr(token.attrs, 't'), col: column(attr(token.attrs, 'r')), value: '' };
      else if (name === 'is' && !token.empty) inline = true;
      else if (name === 'v' && !token.empty && cell) capture = 'v';
      else if (name === 't' && !token.empty && cell && inline) capture = 't';
      continue;
    }
    if (name === 'v' || name === 't') capture = undefined;
    else if (name === 'is') inline = false;
    else if (name === 'c' && cell && row) {
      const raw = cell.value.trim();
      const value = cell.type === 's' ? shared[Number(raw)] ?? '' : cell.type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE') : raw;
      const at = cell.col !== undefined && cell.col < OFFICE_LIMITS.columns ? cell.col : row.length;
      while (row.length < at) row.push('');
      row[at] = value.replace(/\s+/g, ' ').replace(/\|/g, '/');
      cell = undefined;
    } else if (name === 'row' && row) {
      while (row.length && !row[row.length - 1]) row.pop();
      if (row.length) { out.push(cells(row)); if (++rows >= OFFICE_LIMITS.rows) { out.push('[more rows not read]'); return; } }
      row = undefined;
    }
  }
}

export async function xlsxText(pkg: Package, out: Out): Promise<void> {
  const root = await pkg.rels('');
  const book = root.find((rel) => rel.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
  const xml = await pkg.part(book);
  if (!xml) return;
  const rels = await pkg.rels(book);
  const shared = sharedStrings(await pkg.part(rels.find((rel) => rel.type.endsWith('/sharedStrings'))?.target ?? resolvePart(folderOf(book), 'sharedStrings.xml')));
  const sheets: Array<{ name: string; target: string }> = [];
  for (const token of xmlTokens(xml)) {
    if (token.kind !== 'open' || localName(token.name) !== 'sheet') continue;
    const target = rels.find((rel) => rel.id === attr(token.attrs, 'r:id'))?.target;
    if (target) sheets.push({ name: attr(token.attrs, 'name') ?? `Sheet ${sheets.length + 1}`, target });
  }
  for (const sheet of sheets) {
    const part = await pkg.part(sheet.target);
    if (!part) continue;
    out.push('');
    out.push(`# ${sheet.name}`);
    sheetText(part, shared, out);
  }
}

