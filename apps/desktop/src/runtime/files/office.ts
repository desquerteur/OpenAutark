// Text of Office Open XML documents – Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) – for the
// chat attachments (files/store.ts, context/attachments.ts). The package is read with
// the bounded ZIP reader (zip.ts) and its XML parts with the forward-only scanner (xml-scan.ts):
// Word paragraphs with headings (from the document's own styles, so localized style names work),
// lists, tables as `| a | b |` rows, text boxes once (fallback copies skipped), footnotes/endnotes;
// Excel sheets in workbook order (`# <sheet>`) with shared/inline strings, numbers and booleans per
// row; PowerPoint slides in presentation order (`# Slide n: <title>`) with their text and notes.
// Deleted/moved-away tracked changes and field codes are left out. Legacy binary files (.doc/.xls/
// .ppt) and OpenDocument files are not read.
// Owns: the kinds, the Word rules and the dispatch (limits, package and output lines:
// office-package.ts; Excel: office-sheets.ts; PowerPoint: office-slides.ts). Never: runs macros or
// embedded objects, follows external relationships, or throws for a damaged document (it yields '').

import { attr, resolvePart, xmlTokens } from './xml-scan.ts';
import { Full, OFFICE_LIMITS, Out, Package, cells, folderOf } from './office-package.ts';
import { xlsxText } from './office-sheets.ts';
import { pptxText } from './office-slides.ts';

export { OFFICE_LIMITS } from './office-package.ts';

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export const OFFICE_MIMES: Readonly<Record<string, OfficeKind>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** The Office kind of a file extension ('docx') or a mime type; undefined otherwise. */
export function officeKind(extOrMime: string): OfficeKind | undefined {
  const value = extOrMime.toLowerCase();
  if (value === 'docx' || value === 'xlsx' || value === 'pptx') return value;
  return OFFICE_MIMES[value];
}

// ---------------------------------------------------------------- Word

/** styleId → heading level from the document's styles ("heading 1"…, "Title", or an outline level). */
function headingStyles(xml: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!xml) return out;
  let id: string | undefined;
  let name = '';
  let outline: number | undefined;
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'open') {
      if (token.name === 'w:style') { id = attr(token.attrs, 'w:styleId'); name = ''; outline = undefined; }
      else if (token.name === 'w:name' && id) name = (attr(token.attrs, 'w:val') ?? '').toLowerCase();
      else if (token.name === 'w:outlineLvl' && id) outline = Number(attr(token.attrs, 'w:val'));
    } else if (token.kind === 'close' && token.name === 'w:style' && id) {
      const heading = /^heading\s*([1-9])$/.exec(name);
      const level = heading ? Number(heading[1]) : name === 'title' ? 1 : outline !== undefined && outline >= 0 && outline < 9 ? outline + 1 : 0;
      if (level) out.set(id, Math.min(level, 6));
      id = undefined;
    }
  }
  return out;
}

interface Para { text: string; level: number; list: boolean }

function wordText(xml: string, styles: ReadonlyMap<string, number>, out: Out): void {
  const paras: Para[] = [];
  const cellStack: string[][] = [];
  const rowStack: string[][] = [];
  let skip = 0; // mc:Fallback copies, moved-away text, field codes
  let inText = false;
  let inTabs = false;
  const emit = (line: string) => { if (cellStack.length) cellStack[cellStack.length - 1].push(line); else out.push(line); };
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'text') {
      if (inText && !skip && paras.length) paras[paras.length - 1].text += token.text;
      continue;
    }
    const name = token.name;
    if (token.kind === 'open') {
      if (name === 'mc:Fallback' || name === 'w:moveFrom' || name === 'w:instrText') { if (!token.empty) skip++; continue; }
      const para = paras[paras.length - 1];
      if (name === 'w:p' && !token.empty) paras.push({ text: '', level: 0, list: false });
      else if (name === 'w:p') emit('');
      else if (name === 'w:t') inText = !token.empty;
      else if (name === 'w:tabs') inTabs = !token.empty;
      else if (name === 'w:tab' && !inTabs && para && !skip) para.text += '\t';
      else if ((name === 'w:br' || name === 'w:cr') && para && !skip) para.text += '\n';
      else if (name === 'w:pStyle' && para) para.level = styles.get(attr(token.attrs, 'w:val') ?? '') ?? para.level;
      else if (name === 'w:outlineLvl' && para) { const level = Number(attr(token.attrs, 'w:val')); if (level >= 0 && level < 6) para.level = level + 1; }
      else if (name === 'w:numPr' && para) para.list = true;
      else if (name === 'w:tr' && !token.empty) rowStack.push([]);
      else if (name === 'w:tc' && !token.empty) cellStack.push([]);
      continue;
    }
    if (name === 'mc:Fallback' || name === 'w:moveFrom' || name === 'w:instrText') { skip = Math.max(0, skip - 1); continue; }
    if (name === 'w:t') inText = false;
    else if (name === 'w:tabs') inTabs = false;
    else if (name === 'w:p') {
      const para = paras.pop();
      if (!para) continue;
      const text = para.text.split('\n').map((part) => part.trim()).filter(Boolean).join('\n'); // = /\s*\n\s*/ → '\n', then trim – linear
      emit(!text ? '' : para.level ? `${'#'.repeat(para.level)} ${text.replace(/\n/g, ' ')}` : para.list ? `- ${text}` : text);
    } else if (name === 'w:tc') {
      const cell = cellStack.pop() ?? [];
      rowStack[rowStack.length - 1]?.push(cell.filter(Boolean).join(' ').replace(/\|/g, '/'));
    } else if (name === 'w:tr') {
      const row = rowStack.pop() ?? [];
      if (row.some(Boolean)) emit(cells(row));
    }
  }
}

async function docxText(pkg: Package, out: Out): Promise<void> {
  const root = await pkg.rels('');
  const main = root.find((rel) => rel.type.endsWith('/officeDocument'))?.target ?? 'word/document.xml';
  const xml = await pkg.part(main);
  if (!xml) return;
  const styles = headingStyles(await pkg.part(resolvePart(folderOf(main), 'styles.xml')));
  wordText(xml, styles, out);
  for (const rel of await pkg.rels(main)) {
    const kind = rel.type.endsWith('/footnotes') ? 'Footnotes' : rel.type.endsWith('/endnotes') ? 'Endnotes' : undefined;
    const part = kind ? await pkg.part(rel.target) : undefined;
    if (!kind || !part || !/<w:t[\s>]/.test(part)) continue;
    out.push('');
    out.push(`## ${kind}`);
    wordText(part, styles, out);
  }
}

export async function officeText(bytes: Uint8Array, kind: OfficeKind): Promise<string> {
  if (bytes.byteLength > OFFICE_LIMITS.bytes) return '';
  const out = new Out();
  try {
    const pkg = new Package(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (kind === 'docx') await docxText(pkg, out);
    else if (kind === 'xlsx') await xlsxText(pkg, out);
    else await pptxText(pkg, out);
  } catch (error) {
    if (!(error instanceof Full)) return '';
  }
  return out.text();
}
