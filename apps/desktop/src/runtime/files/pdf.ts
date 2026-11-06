// PDF text extraction with Mozilla pdf.js, ported from the proven legacy code
// (legacy/src/attachments.cjs): DOMMatrix polyfill, no eval, no system fonts/font faces,
// stop at errors, 15 s timeout, at most 100 pages and 100,000 characters.
// Owns: the extraction call and its limits. Never: executes PDF scripts/actions, caches
// (store.ts caches the result) or loads pdf.js before the first PDF actually needs text.

import { WorkforceError } from '../../shared/errors.ts';

export const PDF_LIMITS = { pages: 100, chars: 100_000, timeoutMs: 15_000 };

export type PdfTextExtractor = (bytes: Uint8Array) => Promise<string>;

/** Default extractor. Returns '' for PDFs without readable text (scans); throws user-safe errors. */
export const extractPdfText: PdfTextExtractor = async (bytes) => {
  const global = globalThis as unknown as { DOMMatrix?: unknown };
  global.DOMMatrix ||= (await import('@thednp/dommatrix')).default;
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: Uint8Array.from(bytes), // pdf.js transfers/detaches the buffer; never hand it ours
    // (legacy also passed isEvalSupported: false; pdf.js 6 removed eval and that option)
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    verbosity: 0,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void task.destroy();
        reject(new WorkforceError('timeout', 'The PDF took too long to read.'));
      }, PDF_LIMITS.timeoutMs);
    });
    const document = await Promise.race([task.promise, timeout]);
    if (document.numPages > PDF_LIMITS.pages) throw new WorkforceError('bad_request', `Choose a PDF with at most ${PDF_LIMITS.pages} pages.`);
    let text = '';
    for (let page = 1; page <= document.numPages; page++) {
      const current = await Promise.race([document.getPage(page), timeout]);
      const content = await Promise.race([current.getTextContent(), timeout]);
      text += content.items.map((item) => ('str' in item ? item.str : '')).join(' ') + '\n';
      current.cleanup();
      // Unlike legacy (which refused long PDFs for one chat context), the store keeps the head;
      // callers decide how much context they can afford via text(id, maxChars).
      if (text.length >= PDF_LIMITS.chars) return text.slice(0, PDF_LIMITS.chars);
    }
    return text.trim() ? text : '';
  } catch (error) {
    if (error instanceof WorkforceError) throw error;
    if ((error as { name?: string })?.name === 'PasswordException') throw new WorkforceError('bad_request', 'Unlock this PDF before attaching it.');
    throw new WorkforceError('bad_request', 'This PDF could not be read. Attach an unlocked PDF or an image.');
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => {});
  }
};
