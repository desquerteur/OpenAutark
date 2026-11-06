// Measured facts of a stored file for the media library: kind from the mime type, image size
// (PNG/JPEG/GIF/WebP headers), audio/video duration and video size (container headers) and
// PDF page count (pdf.js, lazily) – all without external tools.
// Owns: the mime → kind rule, the "does this row still need a probe" rule and the dispatch to the
// parsers. Never: writes the database, holds a file open beyond one probe, reads more than bounded
// windows (except a PDF ≤ PDF_COUNT_MAX_BYTES for pdf.js), or throws for unparseable content
// (missing facts instead).

import { open } from 'node:fs/promises';
import type { MediaKind } from '../../shared/model/media.ts';
import { imageSize } from '../files/mime.ts';
import { flacDuration, mp3Duration, oggDuration, wavDuration, type ByteSource } from './probe-audio.ts';
import { matroskaFacts, mp4Facts, type ContainerFacts } from './probe-container.ts';
import { PDF_COUNT_MAX_BYTES, type PdfPageCounter } from './pdf-pages.ts';

export interface MediaFacts {
  /** Set when the content corrects the mime kind (an audio-only WebM/MP4 is 'audio'). */
  kind?: MediaKind;
  width?: number;
  height?: number;
  durationMs?: number;
  pages?: number;
}

const IMAGE_HEAD = 512 * 1024; // JPEG SOF can sit behind a large EXIF thumbnail
const SIZED_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DOCUMENT = /^(?:text\/|application\/(?:pdf|json|xml|yaml|rtf|epub\+zip|msword|vnd\.ms-|vnd\.openxmlformats-officedocument|vnd\.oasis\.opendocument))/;

const baseMime = (mime: string): string => mime.split(';')[0].trim().toLowerCase();

export function kindOf(mime: string): MediaKind {
  const type = baseMime(mime);
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return DOCUMENT.test(type) ? 'document' : 'other';
}

type Parser = (src: ByteSource) => Promise<ContainerFacts | undefined>;
const duration = (parse: (src: ByteSource) => Promise<number | undefined>): Parser =>
  async (src) => { const durationMs = await parse(src); return durationMs === undefined ? undefined : { durationMs }; };

const WAV = ['audio/wav', 'audio/x-wav', 'audio/wave'];
const TIMED: Record<string, Parser> = {
  ...Object.fromEntries(WAV.map((type) => [type, duration(wavDuration)])),
  'audio/mpeg': duration(mp3Duration), 'audio/mp3': duration(mp3Duration),
  'audio/ogg': duration(oggDuration), 'audio/opus': duration(oggDuration), 'video/ogg': duration(oggDuration),
  'audio/flac': duration(flacDuration), 'audio/x-flac': duration(flacDuration),
  'audio/mp4': mp4Facts, 'audio/x-m4a': mp4Facts, 'video/mp4': mp4Facts, 'video/quicktime': mp4Facts, 'video/x-m4v': mp4Facts,
  'video/webm': matroskaFacts, 'audio/webm': matroskaFacts, 'video/x-matroska': matroskaFacts, 'audio/x-matroska': matroskaFacts,
};

/** True when a row lacks a fact the probe can measure for its type. */
export function needsProbe(info: { kind: MediaKind; mime: string; width?: number; durationMs?: number; pages?: number }): boolean {
  const type = baseMime(info.mime);
  if (info.kind === 'image') return info.width === undefined && SIZED_IMAGES.has(type);
  if (info.kind === 'audio' || info.kind === 'video') return info.durationMs === undefined && type in TIMED;
  return type === 'application/pdf' && info.pages === undefined;
}

/** Facts of bytes behind a ByteSource (tests pass in-memory sources). */
export async function probeSource(src: ByteSource, mime: string, deps: { pdfPages: PdfPageCounter }): Promise<MediaFacts> {
  const type = baseMime(mime);
  if (type.startsWith('image/')) {
    return SIZED_IMAGES.has(type) ? imageSize(await src.read(0, IMAGE_HEAD), type) ?? {} : {};
  }
  if (type === 'application/pdf') {
    if (src.size > PDF_COUNT_MAX_BYTES) return {};
    const pages = await deps.pdfPages(await src.read(0, src.size));
    return pages ? { pages } : {};
  }
  const parse = TIMED[type];
  if (!parse) return {};
  const facts = await parse(src);
  if (!facts) return {};
  const { audioOnly, ...rest } = facts;
  return audioOnly && type.startsWith('video/') ? { ...rest, kind: 'audio' } : rest;
}

/** Opens the blob read-only, probes it and closes it again. */
export function probeFile(file: StoredFile, deps: { pdfPages: PdfPageCounter }): Promise<MediaFacts> {
  return withSource(file, (src) => probeSource(src, file.mime, deps));
}

// ----------------------------------------------------------------------------------- files

interface StoredFile { path: string; mime: string; size: number }

/** Opens the blob read-only for one job and closes it again. */
async function withSource<T>(file: StoredFile, job: (src: ByteSource) => Promise<T>): Promise<T> {
  const handle = await open(file.path, 'r');
  try {
    const size = file.size || (await handle.stat()).size;
    const src: ByteSource = {
      size,
      async read(offset, length) {
        const start = Math.max(0, Math.min(offset, size));
        const count = Math.max(0, Math.min(length, size - start));
        if (!count) return new Uint8Array(0);
        const buffer = Buffer.alloc(count);
        const { bytesRead } = await handle.read(buffer, 0, count, start);
        return buffer.subarray(0, bytesRead);
      },
    };
    return await job(src);
  } finally {
    await handle.close();
  }
}

/** In-memory ByteSource (tests and small buffers). */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(Math.max(0, offset), Math.max(0, offset) + Math.max(0, length)),
  };
}
