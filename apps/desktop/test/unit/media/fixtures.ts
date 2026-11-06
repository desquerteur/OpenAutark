// Synthetic media files for the media library tests: minimal but structurally valid WAV,
// MP3 (CBR, Xing, VBRI), Ogg Opus, FLAC, MP4 (ISO BMFF), WebM/Matroska, PNG and JPEG bytes.
// Owns: byte builders only. Never: imported by production code.

const enc = new TextEncoder();
export const str = (value: string): Uint8Array => enc.encode(value);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export const u8 = (...values: number[]): Uint8Array => Uint8Array.from(values);
export const zeros = (n: number): Uint8Array => new Uint8Array(n);
export function u16le(v: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
export function u32le(v: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }
export function u16be(v: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b; }
export function u32be(v: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b; }
export function u64be(v: number): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); return b; }
export function i64le(v: number): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); return b; }
export function f64be(v: number): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; }

/** 8 kHz mono 16-bit PCM with a LIST chunk (odd size, padded) before `data`. */
export function wav(durationMs: number): Uint8Array {
  const byteRate = 16000;
  const data = zeros((byteRate * durationMs) / 1000);
  const fmt = concat(str('fmt '), u32le(16), u16le(1), u16le(1), u32le(8000), u32le(byteRate), u16le(2), u16le(16));
  const list = concat(str('LIST'), u32le(3), str('abc'), zeros(1));
  const body = concat(str('WAVE'), fmt, list, str('data'), u32le(data.length), data);
  return concat(str('RIFF'), u32le(body.length), body);
}

const MP3_HEADER = u8(0xff, 0xfb, 0x90, 0x00); // MPEG1 Layer III, 128 kbit/s, 44.1 kHz, stereo
const MP3_FRAME = 417;

function id3(bytes: number): Uint8Array {
  return concat(str('ID3'), u8(3, 0, 0, 0, 0, 0, bytes), zeros(bytes));
}

/** CBR: ID3v2 (100 bytes), `audioBytes` of consecutive frames, then a 128-byte ID3v1 tag. */
export function mp3Cbr(audioBytes: number): Uint8Array {
  const audio = zeros(audioBytes);
  for (let at = 0; at + 4 <= audioBytes; at += MP3_FRAME) audio.set(MP3_HEADER, at);
  return concat(id3(90), audio, str('TAG'), zeros(125));
}

/** VBR with a Xing header in the first frame announcing `frames` frames. */
export function mp3Xing(frames: number): Uint8Array {
  const first = zeros(MP3_FRAME);
  first.set(MP3_HEADER, 0);
  first.set(concat(str('Xing'), u32be(1), u32be(frames)), 4 + 32);
  const second = zeros(MP3_FRAME);
  second.set(MP3_HEADER, 0);
  return concat(first, second, zeros(2000));
}

/** VBR with a VBRI header (32 bytes after the frame header). */
export function mp3Vbri(frames: number): Uint8Array {
  const first = zeros(MP3_FRAME);
  first.set(MP3_HEADER, 0);
  first.set(concat(str('VBRI'), u16be(1), u16be(0), u16be(75), u32be(100000), u32be(frames)), 36);
  const second = zeros(MP3_FRAME);
  second.set(MP3_HEADER, 0);
  return concat(first, second);
}

function oggPage(granule: number, packet: Uint8Array, type = 0): Uint8Array {
  return concat(str('OggS'), u8(0, type), i64le(granule), u32le(1), u32le(0), u32le(0), u8(1, packet.length), packet);
}

/** Opus in Ogg: OpusHead (pre-skip 312), a data page, a last page at 48 kHz × seconds. */
export function oggOpus(durationMs: number): Uint8Array {
  const head = concat(str('OpusHead'), u8(1, 1), u16le(312), u32le(48000), u16le(0), u8(0));
  return concat(oggPage(0, head, 2), oggPage(4800, zeros(50)), oggPage((48000 * durationMs) / 1000 + 312, zeros(50), 4));
}

/** FLAC STREAMINFO with 44.1 kHz, stereo, 16 bit and `seconds` × 44100 samples. */
export function flac(seconds: number): Uint8Array {
  const rate = 44100;
  const total = rate * seconds;
  const info = zeros(34);
  info[10] = rate >> 12;
  info[11] = (rate >> 4) & 0xff;
  info[12] = ((rate & 0xf) << 4) | (1 << 1) | 0; // channels-1 = 1, bps-1 high bit 0
  info[13] = (0xf << 4) | Math.floor(total / 2 ** 32);
  new DataView(info.buffer).setUint32(14, total % 2 ** 32);
  return concat(str('fLaC'), u8(0x80, 0, 0, 34), info, zeros(100));
}

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32be(8 + body.length), str(type), body);
}

const mvhd = (timescale: number, duration: number) => box('mvhd', zeros(4), zeros(8), u32be(timescale), u32be(duration), zeros(80));
const tkhd = (width: number, height: number) => box('tkhd', zeros(4), zeros(20), zeros(8), zeros(8), zeros(36), u32be(width * 65536), u32be(height * 65536));
const trak = (handler: string, width = 0, height = 0) => box('trak', tkhd(width, height), box('mdia', box('hdlr', zeros(8), str(handler), zeros(13))));

/** ftyp, a 64-bit sized mdat, then moov (mvhd + video/audio traks) at the end. */
export function mp4(options: { durationMs: number; video?: { width: number; height: number } }): Uint8Array {
  const tracks = options.video ? [trak('vide', options.video.width, options.video.height), trak('soun')] : [trak('soun')];
  const mdat = concat(u32be(1), str('mdat'), u64be(16 + 500), zeros(500));
  return concat(box('ftyp', str('isom'), zeros(4)), mdat, box('moov', mvhd(1000, options.durationMs), ...tracks));
}

// ----------------------------------------------------------------------------- Matroska

function vsize(n: number): Uint8Array {
  return n < 127 ? u8(0x80 | n) : u8(0x40 | (n >> 8), n & 0xff);
}
export function ebml(id: number[], ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(u8(...id), vsize(body.length), body);
}
const UNKNOWN = u8(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
const simpleBlock = (rel: number) => ebml([0xa3], u8(0x81), u16be(rel), u8(0x80), zeros(20));
const cluster = (timecode: number, rels: number[]) => concat(u8(0x1f, 0x43, 0xb6, 0x75), UNKNOWN, ebml([0xe7], u16be(timecode)), ...rels.map(simpleBlock));

/** WebM with Info Duration and a 1280×720 video track (as a muxer writes it). */
export function webmWithDuration(durationMs: number): Uint8Array {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], str('webm')));
  const info = ebml([0x15, 0x49, 0xa9, 0x66], ebml([0x2a, 0xd7, 0xb1], u8(0x0f, 0x42, 0x40)), ebml([0x44, 0x89], f64be(durationMs)));
  const video = ebml([0xe0], ebml([0xb0], u16be(1280)), ebml([0xba], u16be(720)));
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], ebml([0xae], ebml([0xd7], u8(1)), ebml([0x83], u8(1)), video));
  return concat(header, u8(0x18, 0x53, 0x80, 0x67), UNKNOWN, info, tracks, cluster(0, [0, 40]));
}

/** MediaRecorder-style audio WebM: no Duration, unknown sizes, the last cluster tells the length. */
export function webmRecording(clusters: Array<{ timecode: number; blocks: number[] }>): Uint8Array {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], str('webm')));
  const info = ebml([0x15, 0x49, 0xa9, 0x66], ebml([0x2a, 0xd7, 0xb1], u8(0x0f, 0x42, 0x40)));
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], ebml([0xae], ebml([0xd7], u8(1)), ebml([0x83], u8(2)), ebml([0xe1], ebml([0xb5], f64be(48000)))));
  return concat(header, u8(0x18, 0x53, 0x80, 0x67), UNKNOWN, info, tracks, ...clusters.map((c) => cluster(c.timecode, c.blocks)));
}

// ------------------------------------------------------------------------------- images

export function png(width: number, height: number): Uint8Array {
  return concat(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), u32be(13), str('IHDR'), u32be(width), u32be(height), u8(8, 6, 0, 0, 0), zeros(4));
}

/** JPEG whose SOF0 sits behind ~80 KB of APP segments (beyond the store's 64 KiB sniff). */
export function jpegLateSof(width: number, height: number): Uint8Array {
  const app = (n: number) => concat(u8(0xff, 0xe1), u16be(n + 2), zeros(n));
  const sof = concat(u8(0xff, 0xc0), u16be(17), u8(8), u16be(height), u16be(width), u8(3), zeros(9));
  return concat(u8(0xff, 0xd8), app(40000), app(40000), sof, u8(0xff, 0xd9));
}

/** Not a real PDF body – the tests inject the page counter. */
export const fakePdf = (): Uint8Array => concat(str('%PDF-1.7\n'), zeros(200), str('%%EOF'));

/** Minimal valid PDF with `pages` empty pages and real xref offsets (for pdf.js). */
export function realPdf(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'),
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return str(out);
}
