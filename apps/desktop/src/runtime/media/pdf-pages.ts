// PDF page count for the media library with Mozilla pdf.js, loaded the same lazy way as the
// text extractor (files/pdf.ts): DOMMatrix polyfill, no system fonts/font faces, stop at
// errors, a timeout. Only the document catalogue is opened – no page is rendered or read.
// Owns: the page-count call and its limits. Never: executes PDF scripts/actions, loads pdf.js
// before a PDF actually needs counting, or throws (undefined for unreadable/locked PDFs).

import { PDF_LIMITS } from '../files/pdf.ts';

export type PdfPageCounter = (bytes: Uint8Array) => Promise<number | undefined>;

/** Largest PDF the library counts (bytes are held in memory while pdf.js opens them). */
export const PDF_COUNT_MAX_BYTES = 64 * 1024 * 1024;

export const countPdfPages: PdfPageCounter = async (bytes) => {
  const global = globalThis as unknown as { DOMMatrix?: unknown };
  let task: { promise: Promise<{ numPages: number }>; destroy(): Promise<void> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    global.DOMMatrix ||= (await import('@thednp/dommatrix')).default;
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    task = getDocument({
      data: Uint8Array.from(bytes), // pdf.js detaches the buffer it gets; never hand it ours
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: true,
      verbosity: 0,
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), PDF_LIMITS.timeoutMs);
    });
    const document = await Promise.race([task.promise, timeout]);
    return document.numPages > 0 ? document.numPages : undefined;
  } catch {
    return undefined; // locked, damaged or too slow: the row simply has no page count
  } finally {
    clearTimeout(timer);
    await task?.destroy().catch(() => {});
  }
};
