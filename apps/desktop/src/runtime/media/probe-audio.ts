// Audio duration from container headers, without external tools: WAV (data size / the sample
// format's bytes per second), MP3 (Xing/Info or VBRI frame count, else a CBR estimate from the
// first frame's bit rate), Ogg (last page granule; Opus 48 kHz minus pre-skip, Vorbis rate from
// its id header) and FLAC (STREAMINFO total samples).
// Owns: these byte-level parsers over a ByteSource. Never: reads more than a few small header
// reads, decodes compressed audio, or throws on malformed input (undefined instead).

/** Random access to a stored file (the probe opens the blob; tests pass byte arrays). */
export interface ByteSource {
  size: number;
  /** Up to `length` bytes at `offset` (fewer at the end of the file). */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  bytes.length >= end ? String.fromCharCode(...bytes.subarray(start, end)) : '';

export const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const ms = (value: number): number | undefined => (Number.isFinite(value) && value > 0 ? Math.round(value) : undefined);

// ------------------------------------------------------------------------------------ WAV

/** Where a RIFF/WAVE file's samples are and how they are stored (`format` 1 = PCM, 3 = float). */
export interface WavLayout { format: number; channels: number; sampleRate: number; byteRate: number; bits: number; dataOffset: number; dataBytes: number }

/** RIFF/WAVE: walks chunk headers (8 bytes each) until `data`, reading `fmt ` on the way. */
export async function wavLayout(src: ByteSource): Promise<WavLayout | undefined> {
  const head = await src.read(0, 12);
  if (ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 12) !== 'WAVE') return undefined;
  let offset = 12;
  let fmt: Omit<WavLayout, 'dataOffset' | 'dataBytes'> | undefined;
  for (let chunks = 0; chunks < 64 && offset + 8 <= src.size; chunks++) {
    const header = await src.read(offset, 48);
    if (header.length < 8) return undefined;
    const id = ascii(header, 0, 4);
    const view = viewOf(header);
    const size = view.getUint32(4, true);
    // fmt data: format(2) channels(2) sample rate(4) byte rate(4) block align(2) bits(2), then for
    // WAVE_FORMAT_EXTENSIBLE (0xfffe) cbSize(2) valid bits(2) mask(4) and the sub-format GUID.
    if (id === 'fmt ' && header.length >= 24) {
      const tag = view.getUint16(8, true);
      const format = tag === 0xfffe && size >= 40 && header.length >= 34 ? view.getUint16(32, true) : tag;
      fmt = { format, channels: view.getUint16(10, true), sampleRate: view.getUint32(12, true), byteRate: view.getUint32(16, true), bits: view.getUint16(22, true) };
    }
    if (id === 'data') {
      if (!fmt) return undefined;
      const available = src.size - (offset + 8);
      const dataBytes = size === 0 || size === 0xffffffff || size > available ? available : size; // streamed WAVs leave 0/-1
      return { ...fmt, dataOffset: offset + 8, dataBytes };
    }
    offset += 8 + size + (size & 1); // chunks are word aligned
  }
  return undefined;
}

/** Bytes per sample frame of PCM/float data; 0 for other codecs (their blocks hold many samples). */
function pcmFrame(layout: WavLayout): number {
  return (layout.format === 1 || layout.format === 3) && layout.channels && layout.bits ? layout.channels * Math.ceil(layout.bits / 8) : 0;
}

/**
 * Duration = data bytes / bytes per second. PCM/float: from the sample format (sample rate ×
 * channels × sample size), never the byte-rate field a sender could set to anything; other
 * codecs (ADPCM, …): the byte-rate field.
 */
export async function wavDuration(src: ByteSource): Promise<number | undefined> {
  const layout = await wavLayout(src);
  if (!layout) return undefined;
  const frame = pcmFrame(layout);
  const perSecond = frame ? layout.sampleRate * frame : layout.byteRate;
  return perSecond ? ms((layout.dataBytes * 1000) / perSecond) : undefined;
}

// ------------------------------------------------------------------------------------ MP3

const BITRATES: Record<string, number[]> = {
  'v1l1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'v1l2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'v1l3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'v2l1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'v2l2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Mp3Frame { mpeg1: boolean; layer: number; bitrate: number; sampleRate: number; mono: boolean; length: number; samples: number }

/** Parses a frame header at `at` (undefined when it is not a valid MPEG audio frame). */
export function mp3Frame(bytes: Uint8Array, at: number): Mp3Frame | undefined {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return undefined;
  const version = (bytes[at + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = 4 - ((bytes[at + 1] >> 1) & 3); // 1..3 (4 = reserved)
  const bitrateIndex = bytes[at + 2] >> 4;
  const rateIndex = (bytes[at + 2] >> 2) & 3;
  if (version === 1 || layer === 4 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  const mpeg1 = version === 3;
  const bitrate = BITRATES[`${mpeg1 ? 'v1' : 'v2'}l${mpeg1 ? layer : Math.min(layer, 2)}`][bitrateIndex];
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  const padding = (bytes[at + 2] >> 1) & 1;
  const samples = layer === 1 ? 384 : layer === 2 || mpeg1 ? 1152 : 576;
  const length = layer === 1 ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4 : Math.floor(((samples / 8) * bitrate * 1000) / sampleRate) + padding;
  return { mpeg1, layer, bitrate, sampleRate, mono: bytes[at + 3] >> 6 === 3, length, samples };
}

/** MPEG audio: skips ID3v2, finds the first frame (confirmed by the next one when readable). */
export async function mp3Duration(src: ByteSource): Promise<number | undefined> {
  const id3 = await src.read(0, 10);
  let start = 0;
  if (ascii(id3, 0, 3) === 'ID3' && id3.length === 10) {
    start = ((id3[6] & 0x7f) << 21 | (id3[7] & 0x7f) << 14 | (id3[8] & 0x7f) << 7 | (id3[9] & 0x7f)) + 10 + (id3[5] & 0x10 ? 10 : 0);
  }
  const window = await src.read(start, 16 * 1024);
  for (let at = 0; at + 4 <= window.length; at++) {
    const frame = mp3Frame(window, at);
    if (!frame) continue;
    const next = at + frame.length;
    if (next + 4 <= window.length && !mp3Frame(window, next)) continue; // false sync inside tag junk
    const frameStart = start + at;
    // Xing/Info sits after the side info; VBRI 32 bytes after the header.
    const side = frame.mpeg1 ? (frame.mono ? 17 : 32) : (frame.mono ? 9 : 17);
    const xing = at + 4 + side;
    const tag = ascii(window, xing, xing + 4);
    if ((tag === 'Xing' || tag === 'Info') && xing + 12 <= window.length) {
      const flags = viewOf(window).getUint32(xing + 4);
      if (flags & 1) return ms((viewOf(window).getUint32(xing + 8) * frame.samples * 1000) / frame.sampleRate);
    }
    if (ascii(window, at + 36, at + 40) === 'VBRI' && at + 54 <= window.length) {
      return ms((viewOf(window).getUint32(at + 50) * frame.samples * 1000) / frame.sampleRate);
    }
    const tail = src.size >= 128 ? await src.read(src.size - 128, 3) : new Uint8Array();
    const audioBytes = src.size - frameStart - (ascii(tail, 0, 3) === 'TAG' ? 128 : 0);
    return ms((audioBytes * 8) / frame.bitrate); // kbit/s → ms
  }
  return undefined;
}

// ------------------------------------------------------------------------------------ Ogg

/** Ogg Opus/Vorbis: granule position of the last page in the tail / the codec's sample rate. */
export async function oggDuration(src: ByteSource): Promise<number | undefined> {
  const head = await src.read(0, 4096);
  if (ascii(head, 0, 4) !== 'OggS' || head.length < 28) return undefined;
  const segments = head[26];
  const packet = 27 + segments; // first packet of the first page
  let rate = 0;
  let preSkip = 0;
  if (ascii(head, packet, packet + 8) === 'OpusHead' && packet + 12 <= head.length) {
    rate = 48000; // Opus granules always count 48 kHz samples
    preSkip = viewOf(head).getUint16(packet + 10, true);
  } else if (ascii(head, packet + 1, packet + 7) === 'vorbis' && packet + 16 <= head.length) {
    rate = viewOf(head).getUint32(packet + 12, true);
  }
  if (!rate) return undefined;
  const span = Math.min(src.size, 64 * 1024);
  const tail = await src.read(src.size - span, span);
  for (let at = tail.length - 14; at >= 0; at--) {
    if (tail[at] !== 0x4f || ascii(tail, at, at + 4) !== 'OggS') continue;
    const granule = Number(viewOf(tail).getBigInt64(at + 6, true));
    if (granule > 0) return ms(((granule - preSkip) * 1000) / rate);
  }
  return undefined;
}

// ----------------------------------------------------------------------------------- FLAC

/** FLAC: STREAMINFO (always the first metadata block) holds the sample rate and total samples. */
export async function flacDuration(src: ByteSource): Promise<number | undefined> {
  const head = await src.read(0, 26);
  if (ascii(head, 0, 4) !== 'fLaC' || head.length < 26 || (head[4] & 0x7f) !== 0) return undefined;
  const rate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
  const total = (head[21] & 0x0f) * 2 ** 32 + viewOf(head).getUint32(22);
  return rate ? ms((total * 1000) / rate) : undefined;
}
