// Video/audio container facts without external tools: ISO BMFF (MP4/M4A/MOV: mvhd or mehd
// duration, tkhd size, hdlr track types) and Matroska/WebM (Info Duration × TimecodeScale,
// Tracks PixelWidth/PixelHeight; browser MediaRecorder files have no Duration, so the last
// cluster in the tail gives it).
// Owns: these byte-level parsers over a ByteSource. Never: reads more than the box headers,
// the moov box (capped) and a bounded head/tail window, decodes media, or throws on
// malformed input (undefined fields instead).

import { ascii, viewOf, type ByteSource } from './probe-audio.ts';

export interface ContainerFacts {
  durationMs?: number;
  width?: number;
  height?: number;
  /** True when the container has audio tracks and no video track (e.g. a recorded voice note). */
  audioOnly?: boolean;
}

const MAX_MOOV = 8 * 1024 * 1024;
const MKV_HEAD = 256 * 1024;
const MKV_TAIL = 512 * 1024;

const ms = (value: number): number | undefined => (Number.isFinite(value) && value > 0 ? Math.round(value) : undefined);

// ------------------------------------------------------------------------------- ISO BMFF

interface Box { type: string; start: number; end: number }

/** Child boxes of bytes[start, end) (start/end of each child's payload). */
function* boxes(bytes: Uint8Array, start = 0, end = bytes.length): Generator<Box> {
  const view = viewOf(bytes);
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header) return;
    yield { type: ascii(bytes, offset + 4, offset + 8), start: offset + header, end: Math.min(offset + size, end) };
    offset += size;
  }
}

/** Walks top-level boxes by their headers until `moov`, then parses it in memory. */
export async function mp4Facts(src: ByteSource): Promise<ContainerFacts | undefined> {
  let offset = 0;
  for (let count = 0; count < 64 && offset + 8 <= src.size; count++) {
    const header = await src.read(offset, 16);
    if (header.length < 8) return undefined;
    const view = viewOf(header);
    let size = view.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) return undefined;
      size = Number(view.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) size = src.size - offset;
    if (size < headerSize) return undefined;
    if (ascii(header, 4, 8) === 'moov') return moovFacts(await src.read(offset + headerSize, Math.min(size - headerSize, MAX_MOOV)));
    offset += size;
  }
  return undefined;
}

function moovFacts(moov: Uint8Array): ContainerFacts {
  const view = viewOf(moov);
  const facts: ContainerFacts = {};
  let timescale = 0;
  let duration = 0;
  let fragmented = 0;
  let video = false;
  let audio = false;
  for (const box of boxes(moov)) {
    const v1 = moov[box.start] === 1;
    if (box.type === 'mvhd' && box.end - box.start >= (v1 ? 32 : 20)) {
      timescale = view.getUint32(box.start + (v1 ? 20 : 12));
      duration = v1 ? Number(view.getBigUint64(box.start + 24)) : view.getUint32(box.start + 16);
    } else if (box.type === 'mvex') {
      for (const inner of boxes(moov, box.start, box.end)) {
        if (inner.type !== 'mehd') continue;
        const long = moov[inner.start] === 1;
        if (inner.end - inner.start >= (long ? 12 : 8)) fragmented = long ? Number(view.getBigUint64(inner.start + 4)) : view.getUint32(inner.start + 4);
      }
    } else if (box.type === 'trak') {
      let handler = '';
      let size: { width: number; height: number } | undefined;
      for (const inner of boxes(moov, box.start, box.end)) {
        if (inner.type === 'tkhd') {
          const long = moov[inner.start] === 1;
          const at = inner.start + (long ? 88 : 76); // 16.16 fixed-point width, then height
          if (at + 8 <= inner.end) size = { width: view.getUint32(at) >>> 16, height: view.getUint32(at + 4) >>> 16 };
        } else if (inner.type === 'mdia') {
          for (const part of boxes(moov, inner.start, inner.end)) {
            if (part.type === 'hdlr' && part.start + 12 <= part.end) handler = ascii(moov, part.start + 8, part.start + 12);
          }
        }
      }
      if (handler === 'soun') audio = true;
      if (handler === 'vide' || (!handler && size && size.width > 0)) {
        video = true;
        if (size && size.width > 0 && size.height > 0 && facts.width === undefined) Object.assign(facts, size);
      }
    }
  }
  if (timescale) {
    const value = ms(((duration || fragmented) * 1000) / timescale);
    if (value !== undefined) facts.durationMs = value;
  }
  if (audio && !video) facts.audioOnly = true;
  return facts;
}

// ------------------------------------------------------------------------------- Matroska

const ID = {
  ebml: 0x1a45dfa3, segment: 0x18538067, info: 0x1549a966, timecodeScale: 0x2ad7b1, duration: 0x4489,
  tracks: 0x1654ae6b, trackEntry: 0xae, trackType: 0x83, video: 0xe0, pixelWidth: 0xb0, pixelHeight: 0xba,
  cluster: 0x1f43b675, timecode: 0xe7, simpleBlock: 0xa3, blockGroup: 0xa0, block: 0xa1,
} as const;

interface Element { id: number; dataStart: number; size: number; unknown: boolean }

/** EBML element header at `at`: id (marker kept) and size (marker removed; all ones = unknown). */
function element(bytes: Uint8Array, at: number): Element | undefined {
  const first = bytes[at];
  if (first === undefined || first === 0) return undefined;
  const idLength = Math.clz32(first) - 23; // 1..4 for valid ids (leading zeros of the byte + 1)
  if (idLength > 4 || at + idLength >= bytes.length) return undefined;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[at + i];
  const sizeAt = at + idLength;
  const lead = bytes[sizeAt];
  if (!lead) return undefined;
  const sizeLength = Math.clz32(lead) - 23;
  if (sizeLength > 8 || sizeAt + sizeLength > bytes.length) return undefined;
  let size = lead & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    size = size * 256 + bytes[sizeAt + i];
    if (bytes[sizeAt + i] !== 0xff) allOnes = false;
  }
  return { id, dataStart: sizeAt + sizeLength, size, unknown: allOnes };
}

function* elements(bytes: Uint8Array, start: number, end: number): Generator<Element> {
  let at = start;
  const limit = Math.min(end, bytes.length);
  while (at < limit) {
    const el = element(bytes, at);
    if (!el) return;
    yield el;
    if (el.unknown) return; // only a cluster may have unknown size; nothing after it is ours
    at = el.dataStart + el.size;
  }
}

function uint(bytes: Uint8Array, el: Element): number {
  let value = 0;
  for (let i = 0; i < el.size && i < 8 && el.dataStart + i < bytes.length; i++) value = value * 256 + bytes[el.dataStart + i];
  return value;
}

function float(bytes: Uint8Array, el: Element): number | undefined {
  if (el.dataStart + el.size > bytes.length) return undefined;
  const view = viewOf(bytes);
  return el.size === 4 ? view.getFloat32(el.dataStart) : el.size === 8 ? view.getFloat64(el.dataStart) : undefined;
}

export async function matroskaFacts(src: ByteSource): Promise<ContainerFacts | undefined> {
  const head = await src.read(0, MKV_HEAD);
  const header = element(head, 0);
  if (!header || header.id !== ID.ebml) return undefined;
  const segment = element(head, header.dataStart + header.size);
  if (!segment || segment.id !== ID.segment) return undefined;
  const facts: ContainerFacts = {};
  let scale = 1_000_000; // ns per timecode unit (default)
  let duration: number | undefined;
  let video = false;
  let audio = false;
  const segmentEnd = segment.unknown ? head.length : segment.dataStart + segment.size;
  for (const el of elements(head, segment.dataStart, segmentEnd)) {
    if (el.id === ID.cluster) break; // media data starts; metadata comes before it
    if (el.id === ID.info) {
      for (const part of elements(head, el.dataStart, el.dataStart + el.size)) {
        if (part.id === ID.timecodeScale) scale = uint(head, part) || scale;
        if (part.id === ID.duration) duration = float(head, part);
      }
    } else if (el.id === ID.tracks) {
      for (const entry of elements(head, el.dataStart, el.dataStart + el.size)) {
        if (entry.id !== ID.trackEntry) continue;
        for (const part of elements(head, entry.dataStart, entry.dataStart + entry.size)) {
          if (part.id === ID.trackType) { const type = uint(head, part); if (type === 1) video = true; if (type === 2) audio = true; }
          if (part.id !== ID.video) continue;
          for (const dim of elements(head, part.dataStart, part.dataStart + part.size)) {
            if (dim.id === ID.pixelWidth && facts.width === undefined) facts.width = uint(head, dim);
            if (dim.id === ID.pixelHeight && facts.height === undefined) facts.height = uint(head, dim);
          }
        }
      }
    }
  }
  if (!duration) duration = await lastClusterTime(src);
  const value = duration ? ms((duration * scale) / 1_000_000) : undefined;
  if (value !== undefined) facts.durationMs = value;
  if (audio && !video) facts.audioOnly = true;
  return facts;
}

/** Timecode of the last block in the file (in TimecodeScale units), from the tail window. */
async function lastClusterTime(src: ByteSource): Promise<number | undefined> {
  const span = Math.min(src.size, MKV_TAIL);
  const tail = await src.read(src.size - span, span);
  for (let at = tail.length - 4; at >= 0; at--) {
    if (tail[at] !== 0x1f || tail[at + 1] !== 0x43 || tail[at + 2] !== 0xb6 || tail[at + 3] !== 0x75) continue;
    const cluster = element(tail, at);
    if (!cluster || cluster.id !== ID.cluster) continue;
    let base: number | undefined;
    let latest = 0;
    for (const part of elements(tail, cluster.dataStart, cluster.unknown ? tail.length : cluster.dataStart + cluster.size)) {
      if (part.id === ID.cluster) break;
      if (base === undefined && part.id !== ID.timecode) break; // the 4 bytes were inside media data
      if (part.id === ID.timecode) base = uint(tail, part);
      else if (part.id === ID.simpleBlock) latest = Math.max(latest, blockTime(tail, part.dataStart));
      else if (part.id === ID.blockGroup) {
        for (const inner of elements(tail, part.dataStart, part.dataStart + part.size)) {
          if (inner.id === ID.block) latest = Math.max(latest, blockTime(tail, inner.dataStart));
        }
      }
    }
    if (base !== undefined) return base + latest;
  }
  return undefined;
}

/** Relative timecode of a (Simple)Block: track number vint, then int16. */
function blockTime(bytes: Uint8Array, at: number): number {
  const lead = bytes[at];
  if (!lead) return 0;
  const length = Math.clz32(lead) - 23;
  const offset = at + length;
  return offset + 2 <= bytes.length ? Math.max(0, viewOf(bytes).getInt16(offset)) : 0;
}
