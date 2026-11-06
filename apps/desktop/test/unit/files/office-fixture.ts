// Tiny Office Open XML packages for the office/zip tests: a ZIP writer (stored or deflated entries,
// local headers + central directory + end record) and minimal docx/xlsx/pptx part sets. No binary
// fixture files: every test builds the bytes it needs.

import { deflateRawSync } from 'node:zlib';

export interface FixtureEntry { name: string; data: string | Buffer; store?: boolean; flags?: number; claimSize?: number }

/** A ZIP archive of `entries` (deflated unless `store`). */
export function zip(entries: readonly FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = entry.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0x800, 6);
    local.writeUInt16LE(entry.store ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.claimSize ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0x800, 8);
    central.writeUInt16LE(entry.store ? 0 : 8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.claimSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rootRels = (target: string) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="${target}"/></Relationships>`;
const rels = (items: Array<[string, string, string]>) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;

/** A Word document: a localized heading style, a list item, a table, a text box with its fallback copy, a tracked deletion, a field code and a footnote. */
export function docx(): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>
<w:p><w:pPr><w:pStyle w:val="berschrift1"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Quarterly plan</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Budget &amp; scope </w:t></w:r><w:r><w:tab/><w:t>Q4</w:t></w:r><w:del><w:r><w:delText>old wording</w:delText></w:r></w:del></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First step</w:t></w:r></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGEREF _Toc1</w:instrText></w:r><w:r><w:t>Field result</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Due</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Mara</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026-11-01</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>
</w:body></w:document>`;
  const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const footnotes = `<w:footnotes ${W}><w:footnote w:id="1"><w:p><w:r><w:t>Source: board minutes</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  return zip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: rootRels('word/document.xml') },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/footnotes.xml', data: footnotes },
    { name: 'word/_rels/document.xml.rels', data: rels([['rId1', 'styles', 'styles.xml'], ['rId2', 'footnotes', 'footnotes.xml']]) },
  ]);
}

/** A workbook with two sheets in workbook order (not part order): shared, inline, numeric and boolean cells and a gap column. */
export function xlsx(): Buffer {
  const book = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Revenue" sheetId="1" r:id="rId2"/><sheet name="Notes" sheetId="2" r:id="rId1"/></sheets></workbook>`;
  const shared = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Region</t></si><si><r><t>Tot</t></r><r><t>al</t></r></si><si><t>North</t><rPh><t>ノース</t></rPh></si></sst>`;
  const revenue = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="b"><v>1</v></c><c r="C2"><f>SUM(1,2)</f><v>1250.5</v></c></row>
<row r="3"></row></sheetData></worksheet>`;
  const notes = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Checked by finance</t></is></c></row></sheetData></worksheet>`;
  return zip([
    { name: '_rels/.rels', data: rootRels('xl/workbook.xml') },
    { name: 'xl/workbook.xml', data: book },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([['rId1', 'worksheet', 'worksheets/sheet2.xml'], ['rId2', 'worksheet', '/xl/worksheets/sheet1.xml'], ['rId3', 'sharedStrings', 'sharedStrings.xml']]) },
    { name: 'xl/sharedStrings.xml', data: shared },
    { name: 'xl/worksheets/sheet1.xml', data: revenue },
    { name: 'xl/worksheets/sheet2.xml', data: notes, store: true },
  ]);
}

const sp = (ph: string | undefined, ...paras: string[]) =>
  `<p:sp><p:nvSpPr><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
const slide = (...shapes: string[]) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

/** A deck whose presentation order differs from the part numbers; the second slide has notes and a slide number placeholder. */
export function pptx(): Buffer {
  const presentation = `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`;
  return zip([
    { name: '_rels/.rels', data: rootRels('ppt/presentation.xml') },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels([['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml']]) },
    { name: 'ppt/slides/slide2.xml', data: slide(sp('ctrTitle', 'Launch review'), sp(undefined, 'Goals', 'Risks')) },
    { name: 'ppt/slides/slide1.xml', data: slide(sp('title', 'Next steps'), sp('body', 'Hire an editor'), sp('sldNum', '2')) },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels([['rId1', 'notesSlide', '../notesSlides/notesSlide1.xml']]) },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: slide(sp('sldImg'), sp('body', 'Mention the budget')) },
  ]);
}
