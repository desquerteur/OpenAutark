// B-058 G6: pure rules of decoding a stored recording's or video's sound in the media analyzer
// (media-analyzer.ts runs the job, media-analyzer-audio.ts is the page side): the checked request of
// the host op media.audio, the job's page spec (which bytes the page may read whole or in part), the
// checks of the PCM chunks and the end report the page posts back, and the result built from them.
// Bytes the page may read in part: formats whose start decodes on its own (MP3, ADTS AAC, Ogg, WebM/
// Matroska, FLAC, WAV) – a longer file is read only up to the span asked for. MP4/M4A/MOV keep their
// index anywhere, so they are read whole, and only up to WHOLE_MS. Decoding holds all the sound from the
// file's start, so no job decodes more than WHOLE_MS (a span of a stream format must end by then).
// Owns: these rules. Never: touches files, windows, timers or the network.

import { AUDIO_DECODE_LIMITS } from '../shared/api/host-bridge.ts';
import type { DecodedAudio } from '../shared/api/host-bridge.ts';
import { WorkforceError } from '../shared/errors.ts';
import { isBlobId } from './protocols/rules.ts';

export interface AudioRequest { fileId: string; mime?: string; startMs: number; maxMs: number }

/** What the page is told for a sound job (media-analyzer-audio.ts). */
export interface AudioSpec {
  task: 'audio';
  rate: number;
  startMs: number;
  maxMs: number;
  /** PCM bytes per post. */
  chunkBytes: number;
  /** The file's size and whether its start decodes on its own (a byte prefix may be read). */
  size: number;
  stream: boolean;
  /** Longest file read whole when it cannot be read in part; the most bytes read at all. */
  wholeMs: number;
  inputBytes: number;
  /** Extra length read past the span (a prefix's length is estimated from bytes); the wait for the file's length. */
  marginMs: number;
  metaMs: number;
}

/** 16 kHz PCM16 mono: bytes per millisecond. */
export const PCM_BYTES_PER_MS = (AUDIO_DECODE_LIMITS.rate * 2) / 1000;
/** One posted chunk of PCM: 1 MiB (about 33 s). */
export const PCM_CHUNK_BYTES = 1024 * 1024;
/** The most sound one job decodes from a file's start: MP4/M4A/MOV whole, other formats up to their span's end (about 0.7 GB of decoded stereo floats at 48 kHz). */
export const WHOLE_MS = 30 * 60_000;
const MARGIN_MS = 30_000;
const META_MS = 10_000;
const MAX_MS = 48 * 3_600_000;
const MEDIA_MIME = /^(?:audio|video)\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const STREAMS: ReadonlySet<string> = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/x-aac', 'audio/aacp', 'audio/ogg', 'audio/opus', 'video/ogg', 'audio/webm', 'video/webm',
  'audio/x-matroska', 'video/x-matroska', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave',
]);

const bad = (message: string) => new WorkforceError('bad_request', message);
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** The host op's arguments, checked: a blob id, a start ≥ 0 and a span (capped at AUDIO_DECODE_LIMITS.maxMs), an audio/video MIME type or none. */
export function audioRequest(args: { fileId?: unknown; mime?: unknown; startMs?: unknown; maxMs?: unknown }): AudioRequest {
  if (typeof args.fileId !== 'string' || !isBlobId(args.fileId)) throw bad('Invalid file id.');
  const start = args.startMs ?? 0;
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start > MAX_MS) throw bad('startMs must be milliseconds from 0.');
  const span = args.maxMs ?? AUDIO_DECODE_LIMITS.maxMs;
  if (typeof span !== 'number' || !Number.isFinite(span) || span < 1) throw bad('maxMs must be at least 1 millisecond.');
  const mime = typeof args.mime === 'string' ? args.mime.split(';')[0].trim().toLowerCase() : '';
  return { fileId: args.fileId, startMs: Math.floor(start), maxMs: Math.min(AUDIO_DECODE_LIMITS.maxMs, Math.floor(span)), ...(MEDIA_MIME.test(mime) ? { mime } : {}) };
}

/** True when a byte prefix of the file is a shorter file of the same sound (see the header). */
export function streamable(mime: string): boolean {
  return STREAMS.has(mime.split(';')[0].trim().toLowerCase());
}

export function audioSpec(request: AudioRequest, size: number, mime: string): AudioSpec {
  return {
    task: 'audio', rate: AUDIO_DECODE_LIMITS.rate, startMs: request.startMs, maxMs: request.maxMs, chunkBytes: PCM_CHUNK_BYTES,
    size, stream: streamable(mime), wholeMs: WHOLE_MS, inputBytes: AUDIO_DECODE_LIMITS.inputBytes, marginMs: MARGIN_MS, metaMs: META_MS,
  };
}

/** The most PCM bytes a job may receive: its span at 16 kHz. */
export function maxPcmBytes(request: AudioRequest): number {
  return request.maxMs * PCM_BYTES_PER_MS;
}

/** A posted chunk of `length` bytes after `received` bytes: whole samples, ≤ 1 MiB, within the span. */
export function pcmChunkOk(received: number, length: number, request: AudioRequest): boolean {
  return length > 0 && length % 2 === 0 && length <= PCM_CHUNK_BYTES && received + length <= maxPcmBytes(request);
}

/**
 * The page's end report ({durationMs, partial}) with the chunks received → the result, or null when the
 * report is malformed. The whole length is at least the decoded span's end; `partial` = the page says the
 * sound goes on, or the span ends before the whole length.
 */
export function audioResult(report: unknown, request: AudioRequest, chunks: readonly Uint8Array[], bytes: number): DecodedAudio | null {
  if (typeof report !== 'object' || report === null) return null;
  const { durationMs, partial } = report as Record<string, unknown>;
  if (!isInt(durationMs, 0, MAX_MS) || (partial !== undefined && typeof partial !== 'boolean')) return null;
  const end = request.startMs + bytes / PCM_BYTES_PER_MS;
  const whole = Math.max(durationMs, bytes ? Math.ceil(end) : 0);
  const pcm = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) { pcm.set(chunk, at); at += chunk.byteLength; }
  return { sampleRate: AUDIO_DECODE_LIMITS.rate, pcm, durationMs: whole, startMs: request.startMs, partial: partial === true || end + 100 < whole };
}
