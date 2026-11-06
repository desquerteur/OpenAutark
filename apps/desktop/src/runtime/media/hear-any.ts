// B-058 G6: any stored recording or video as 16 kHz mono samples for local hearing (speech to text,
// audio tagging, loudness). WAV and raw PCM16 decode here in the runtime; every other format the app
// window's Chromium decodes (mp3, m4a/aac, ogg/opus, webm, flac, mp4, mov, mkv) goes to the host op
// `media.audio` (main's media analyzer) – there is no ffmpeg. hearable() is the one format/length gate
// tools and the voice path ask before they try: the decoded or probed length counts, never the
// container's bytes, and a file longer than AUDIO_DECODE_LIMITS.maxMs is heard in part.
// The same decode asked twice at once runs once (nothing is kept on disk). A WAV or PCM file over
// WHOLE_BYTES is read as its header and the span's frames only, piece by piece (review fix: an hour of
// 48 kHz stereo WAV was read whole – 0.7 GB, and as many again as floats, in the runtime).
// Owns: the format rule, the local decode with span cut and resampling and the host call.
// Never: loads models, stores files in the library, or decodes compressed audio itself.

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { RuntimeServices } from '../contracts.ts';
import { AUDIO_DECODE_LIMITS } from '../../shared/api/host-bridge.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { encodeWav, parseWav, pcm16Samples, resample } from '../../shared/voice/wav.ts';
import { localFormat } from '../voice/local/hear.ts';

/** What pcmOf needs: the blob store and the host (its media analyzer, when it has one). */
export type HearServices = Pick<RuntimeServices, 'files' | 'host'> & Partial<Pick<RuntimeServices, 'paths'>>;

/** A span of a file's sound as 16 kHz mono floats in [-1, 1]; durationMs is the whole file's length, partial = the sound goes on after the span. */
export interface HeardPcm { samples: Float32Array; sampleRate: 16_000; durationMs: number; startMs: number; partial: boolean }

export type Hearable = { ok: true; partial?: boolean; note?: string } | { ok: false; reason: string };

const RATE = AUDIO_DECODE_LIMITS.rate;
const PCM_RATE = /(?:^|;)\s*rate=(\d{4,6})/i;
/** A WAV/PCM file up to this is read whole; a larger one only as its header and the span's frames. */
export const WHOLE_BYTES = 32 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;
const PIECE_BYTES = 4 * 1024 * 1024;

/** Containers and codecs the app window's Chromium decodes (base MIME types); amr, wma, wmv and avi are not among them. */
const HOST_TYPES: ReadonlySet<string> = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/x-aac', 'audio/ogg', 'audio/opus', 'audio/webm',
  'audio/flac', 'audio/x-flac', 'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska', 'audio/x-matroska',
]);
const HOST_NAME = /\.(mp3|m4a|mp4|m4v|aac|ogg|oga|opus|webm|flac|mov|mkv|mka)$/i;

/** How a file can be heard: decoded here ('wav', 'pcm'), by the host's window ('host'), or not at all (undefined). */
export function hearFormat(mime: string, name = ''): 'wav' | 'pcm' | 'host' | undefined {
  const local = localFormat(mime, name);
  if (local) return local;
  const base = mime.split(';')[0].trim().toLowerCase();
  if (HOST_TYPES.has(base)) return 'host';
  return (!base || base === 'application/octet-stream') && HOST_NAME.test(name) ? 'host' : undefined;
}

/** True when the host decodes compressed recordings and videos (the desktop app; not a headless runtime). */
export function hostDecodes(s: Pick<RuntimeServices, 'host'>): boolean {
  return typeof s.host?.media?.audio === 'function';
}

/**
 * The one gate before hearing a file: its format (hearFormat; 'host' formats only when the host can
 * decode) and its decoded or probed length – a file longer than AUDIO_DECODE_LIMITS.maxMs is heard
 * in part (`partial`, with a note saying so); an unknown length is fine (the decode stops at the limit).
 */
export function hearable(info: { mime: string; name?: string; durationMs?: number }, hostCanDecode: boolean): Hearable {
  const format = hearFormat(info.mime, info.name);
  if (!format) return { ok: false, reason: `This file type (${info.mime.split(';')[0].trim() || 'unknown'}) cannot be played here; send it as MP3, M4A, OGG, WAV, WebM, MP4 or MOV.` };
  if (format === 'host' && !hostCanDecode) return { ok: false, reason: 'Only WAV recordings can be heard here; this format needs the desktop app.' };
  if (info.durationMs !== undefined && info.durationMs <= 0) return { ok: false, reason: 'This file has no sound to hear.' };
  if (info.durationMs === undefined || info.durationMs <= AUDIO_DECODE_LIMITS.maxMs) return { ok: true };
  const limit = Math.round(AUDIO_DECODE_LIMITS.maxMs / 60_000);
  return { ok: true, partial: true, note: `only the first ${limit} minutes of this ${Math.round(info.durationMs / 60_000)}-minute recording are heard` };
}

/** The span [startMs, startMs + maxMs) of a file's sound (maxMs ≤ AUDIO_DECODE_LIMITS.maxMs) as 16 kHz mono floats. */
export async function pcmOf(s: HearServices, fileId: string, opts: { startMs?: number; maxMs?: number } = {}): Promise<HeardPcm> {
  const ref = s.files.get(fileId);
  if (!ref) throw new WorkforceError('not_found', 'That file is not stored here.');
  const startMs = Math.max(0, Math.floor(opts.startMs ?? 0));
  const maxMs = Math.min(AUDIO_DECODE_LIMITS.maxMs, Math.max(1, Math.floor(opts.maxMs ?? AUDIO_DECODE_LIMITS.maxMs)));
  const format = hearFormat(ref.mime, ref.name);
  if (format === 'wav' || format === 'pcm') {
    try {
      return await localPcm(s, fileId, ref, format, startMs, maxMs);
    } catch (error) {
      // A WAV encoding this parser does not read (mu-law, A-law …): the host's decoder may.
      if (!(error instanceof WorkforceError && error.code === 'bad_request' && format === 'wav' && hostDecodes(s))) throw error;
    }
  } else if (format !== 'host' || !hostDecodes(s)) {
    throw new WorkforceError('unavailable', format === 'host' ? 'Only WAV recordings can be heard here; this format needs the desktop app.' : `This file type (${ref.mime || 'unknown'}) cannot be heard.`);
  }
  return hostPcm(s, fileId, ref.mime, startMs, maxMs);
}

/** pcmOf's span as a 16 kHz mono PCM16 WAV file's bytes (for a transcription service or a listening model). */
export async function wavOf(s: HearServices, fileId: string, opts: { startMs?: number; maxMs?: number } = {}): Promise<Omit<HeardPcm, 'samples' | 'sampleRate'> & { wav: Uint8Array }> {
  const heard = await pcmOf(s, fileId, opts);
  return { wav: encodeWav(heard.samples, RATE), durationMs: heard.durationMs, startMs: heard.startMs, partial: heard.partial };
}

/** A span as mono floats at the file's own rate, with the whole file's frames and where the span ends. */
interface LocalSpan { samples: Float32Array; sampleRate: number; frames: number; to: number }

const pcmRate = (mime: string) => Number(PCM_RATE.exec(mime)?.[1] ?? RATE);

async function localPcm(s: HearServices, fileId: string, ref: { mime: string; size: number }, format: 'wav' | 'pcm', startMs: number, maxMs: number): Promise<HeardPcm> {
  const large = ref.size > WHOLE_BYTES && typeof s.files.path === 'function';
  const bytes = large ? undefined : await s.files.read(fileId);
  let span: LocalSpan;
  try {
    span = bytes ? spanIn(bytes, ref.mime, format, startMs, maxMs) : await spanOf(s.files.path(fileId), ref.mime, format, startMs, maxMs);
  } catch (error) {
    if (error instanceof WorkforceError) throw error;
    throw new WorkforceError('bad_request', `This recording cannot be read (${error instanceof Error ? error.message : 'broken file'}).`);
  }
  const durationMs = Math.round((span.frames / span.sampleRate) * 1000);
  return { samples: resample(span.samples, span.sampleRate, RATE), sampleRate: RATE, durationMs, startMs, partial: span.to < span.frames };
}

/** The span of a WAV or PCM file read whole. */
function spanIn(bytes: Uint8Array, mime: string, format: 'wav' | 'pcm', startMs: number, maxMs: number): LocalSpan {
  const mono = format === 'wav' ? parseWav(bytes) : { samples: pcm16Samples(bytes), sampleRate: pcmRate(mime) };
  const frames = mono.samples.length;
  const from = Math.min(frames, Math.round((startMs / 1000) * mono.sampleRate));
  const to = Math.min(frames, from + Math.round((maxMs / 1000) * mono.sampleRate));
  return { samples: mono.samples.subarray(from, to), sampleRate: mono.sampleRate, frames, to };
}

/** Where a WAV's frames start, their size and their count (from the chunks in `head`), or undefined. */
function wavLayout(head: Uint8Array, size: number): { at: number; frameBytes: number; frames: number } | undefined {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (at: number) => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (head.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let frameBytes = 0;
  for (let at = 12; at + 8 <= head.byteLength;) {
    const length = view.getUint32(at + 4, true);
    if (tag(at) === 'fmt ' && length >= 16 && at + 24 <= head.byteLength) {
      const bits = view.getUint16(at + 22, true);
      frameBytes = bits % 8 === 0 ? view.getUint16(at + 10, true) * (bits / 8) : 0;
    } else if (tag(at) === 'data') {
      return frameBytes > 0 ? { at: at + 8, frameBytes, frames: Math.floor(Math.max(0, Math.min(length, size - at - 8)) / frameBytes) } : undefined;
    }
    at += 8 + length + (length % 2);
  }
  return undefined;
}

/** The span of a large WAV or PCM file: its header, then only the span's frames, mixed down in pieces (each read as a WAV of its own). */
async function spanOf(file: string, mime: string, format: 'wav' | 'pcm', startMs: number, maxMs: number): Promise<LocalSpan> {
  let handle: FileHandle;
  try { handle = await open(file, 'r'); } catch { throw new WorkforceError('not_found', 'The stored recording is missing.'); }
  try {
    const { size } = await handle.stat();
    const head = new Uint8Array(Math.min(size, HEAD_BYTES));
    await readAt(handle, head, 0);
    const layout = format === 'pcm' ? { at: 0, frameBytes: 2, frames: Math.floor(size / 2) } : wavLayout(head, size);
    if (!layout) throw new Error('a WAV file whose sound does not start in its first 256 KB');
    const prefix = head.subarray(0, layout.at);
    const sampleRate = format === 'wav' ? parseWav(prefix).sampleRate : pcmRate(mime); // the header alone: its encoding is checked here
    const from = Math.min(layout.frames, Math.round((startMs / 1000) * sampleRate));
    const to = Math.min(layout.frames, from + Math.round((maxMs / 1000) * sampleRate));
    const samples = new Float32Array(to - from);
    const per = Math.max(1, Math.floor(PIECE_BYTES / layout.frameBytes));
    for (let frame = from; frame < to; frame += per) {
      const count = Math.min(per, to - frame);
      const piece = new Uint8Array(prefix.byteLength + count * layout.frameBytes);
      piece.set(prefix);
      await readAt(handle, piece.subarray(prefix.byteLength), layout.at + frame * layout.frameBytes);
      samples.set((format === 'wav' ? parseWav(piece).samples : pcm16Samples(piece)).subarray(0, count), frame - from);
    }
    return { samples, sampleRate, frames: layout.frames, to };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readAt(handle: FileHandle, into: Uint8Array, position: number): Promise<void> {
  for (let done = 0; done < into.byteLength;) {
    const { bytesRead } = await handle.read(into, done, into.byteLength - done, position + done);
    if (!bytesRead) throw new Error('the file ended early');
    done += bytesRead;
  }
}

const running = new Map<string, Promise<HeardPcm>>(); // fileId:startMs:maxMs → the decode in flight

/** The host's decode of the span. */
async function hostPcm(s: HearServices, fileId: string, mime: string, startMs: number, maxMs: number): Promise<HeardPcm> {
  const key = `${fileId}:${startMs}:${maxMs}`;
  const already = running.get(key);
  if (already) return already;
  const job = (async () => {
    const media = s.host.media;
    if (!media?.audio) throw new WorkforceError('unavailable', 'Only WAV recordings can be heard here; this format needs the desktop app.');
    const decoded = await media.audio.call(media, { fileId, mime, startMs, maxMs });
    return { samples: pcm16Samples(decoded.pcm), sampleRate: RATE, durationMs: decoded.durationMs, startMs: decoded.startMs, partial: decoded.partial } satisfies HeardPcm;
  })().finally(() => running.delete(key));
  running.set(key, job);
  return job;
}
