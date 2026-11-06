// PowerPoint (.pptx) text for office.ts: slides in presentation order (`# Slide n: <title>`), the text
// of their shapes and tables (slide numbers, dates, footers and images left out), and the speaker notes
// ("Notes: …"); fallback copies of alternate content are skipped. Owns: these rules. Never: runs media
// or embedded objects.

import { attr, localName, xmlTokens } from './xml-scan.ts';
import { OFFICE_LIMITS, type Out, type Package } from './office-package.ts';

interface Shape { ph?: string; paras: string[] }

/** The text shapes of a slide or notes part (placeholder type, paragraphs) plus table/loose paragraphs. */
function shapes(xml: string): Shape[] {
  const out: Shape[] = [];
  const stack: Shape[] = [];
  const loose: Shape = { paras: [] };
  let para: string | undefined;
  let inText = false;
  let skip = 0;
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'text') { if (inText && !skip && para !== undefined) para += token.text; continue; }
    const name = token.name;
    if (token.kind === 'open') {
      if (name === 'mc:Fallback') { if (!token.empty) skip++; }
      else if (name === 'p:sp' && !token.empty) stack.push({ paras: [] });
      else if (name === 'p:ph' && stack.length) stack[stack.length - 1].ph = attr(token.attrs, 'type') ?? 'body';
      else if (name === 'a:p' && !token.empty) para = '';
      else if (name === 'a:t') inText = !token.empty;
      else if (name === 'a:br' && para !== undefined) para += '\n';
      continue;
    }
    if (name === 'mc:Fallback') skip = Math.max(0, skip - 1);
    else if (name === 'a:t') inText = false;
    else if (name === 'a:p' && para !== undefined) {
      const text = para.trim();
      if (text && !skip) (stack[stack.length - 1] ?? loose).paras.push(text);
      para = undefined;
    } else if (name === 'p:sp') { const shape = stack.pop(); if (shape?.paras.length) out.push(shape); }
  }
  if (loose.paras.length) out.push(loose);
  return out;
}

const TITLE = new Set(['title', 'ctrTitle']);
const CHROME = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);

export async function pptxText(pkg: Package, out: Out): Promise<void> {
  const root = await pkg.rels('');
  const deck = root.find((rel) => rel.type.endsWith('/officeDocument'))?.target ?? 'ppt/presentation.xml';
  const xml = await pkg.part(deck);
  const rels = await pkg.rels(deck);
  let slides: string[] = [];
  for (const token of xml ? xmlTokens(xml) : []) {
    if (token.kind !== 'open' || localName(token.name) !== 'sldId') continue;
    const target = rels.find((rel) => rel.id === attr(token.attrs, 'r:id'))?.target;
    if (target) slides.push(target);
  }
  if (!slides.length) {
    slides = [...pkg.entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }
  let number = 0;
  for (const slide of slides.slice(0, OFFICE_LIMITS.slides)) {
    const part = await pkg.part(slide);
    if (!part) continue;
    number++;
    const parts = shapes(part);
    const title = parts.filter((shape) => shape.ph && TITLE.has(shape.ph)).flatMap((shape) => shape.paras).join(' ').replace(/\s+/g, ' ');
    out.push('');
    out.push(`# Slide ${number}${title ? `: ${title}` : ''}`);
    for (const shape of parts) if (!shape.ph || (!TITLE.has(shape.ph) && !CHROME.has(shape.ph))) for (const text of shape.paras) out.push(text);
    const notes = (await pkg.rels(slide)).find((rel) => rel.type.endsWith('/notesSlide'))?.target;
    const notesXml = notes ? await pkg.part(notes) : undefined;
    const said = notesXml ? shapes(notesXml).filter((shape) => shape.ph === 'body').flatMap((shape) => shape.paras) : [];
    if (said.length) out.push(`Notes: ${said.join('\n')}`);
  }
}

/** The text of an Office document ('' when it has none or cannot be read). */
