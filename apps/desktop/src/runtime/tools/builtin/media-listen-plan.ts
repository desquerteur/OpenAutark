// media.listen (MM10, B-058 G9): what one listen sends and what it may cost. A stored WAV/MP3 of at most
// AUDIO_INPUT_BYTES with no span asked goes out as it is (its own quality – a 16 kHz decode loses the
// highs of music); everything else (any format media/hear-any.ts hears, videos, longer files, an asked
// span) as the decoded 16 kHz mono WAV of one span of at most LISTEN_SPAN_MS. The estimate counts how long
// the bytes play (MPEG frames, WAV samples – header fields such as a Xing frame count or a WAV byte rate
// are the sender's to claim); a decoded span is never longer than the length the estimate counted. A span the host
// decodes ends within the recording's first 30 minutes (DECODE_END_MS: refused when it starts later, else clipped).
// Owns: the plan (original or span), the span rules, the "more" line and the price estimate. Never: reads more than one
// bounded file, decodes audio, or lowers an estimate below what is sent.

import { readFileSync, statSync } from 'node:fs';
import type { MediaInfo } from '../../../shared/model/media.ts';
import { parseMediaRef } from '../../../shared/text/media-ref.ts';
import { AUDIO_INPUT_BYTES, audioFormat, type AudioFormat } from '../../engines/http/base.ts';
import { hearFormat } from '../../media/hear-any.ts';
import { ascii, mp3Frame, viewOf } from '../../media/probe-audio.ts';
import { timeText } from '../../media/sounds.ts';
import type { ToolContext } from '../types.ts';

/** The longest span one listen hears (a 16 kHz mono WAV of it stays below AUDIO_INPUT_BYTES). */
export const LISTEN_SPAN_MS = 5 * 60_000;
/** A part the host decodes ends by then: its decoder holds all sound from the file's start (main/media-audio.ts WHOLE_MS); WAV/PCM are read here, any part. */
export const DECODE_END_MS = 30 * 60_000;
const TOO_FAR = 'Only the first 30 minutes of this recording can be decoded here: ask for a part that ends by 30:00 (end ≤ 1800), or send the later part as a file of its own.';
/** Upper ends of common list prices (over-, never under-estimated): audio per minute, plus question and answer. */
const USD_PER_MINUTE = 0.06;
const TEXT_USD = 0.01;
/** 32 kbit/s, the lowest common MP3 rate: the longest a recording of unknown length can play. */
const MIN_BYTES_PER_SECOND = 4_000;
/** A probed length may be off by a frame or two; the decoded span gets this much beyond it. */
const LENGTH_MARGIN_MS = 1_000;

/** What one listen to `seconds` of audio may cost on a pay-per-use account, in USD (whole cents, rounded up). */
export function listenUsd(seconds: number): number {
  const cents = Math.ceil(Math.round(((seconds / 60) * USD_PER_MINUTE + TEXT_USD) * 10_000) / 100);
  return Math.max(1, cents) / 100;
}

/** MPEG audio as a decoder syncs: frames of the first (confirmed) frame's kind, resyncing over anything else; ID3v2 skipped. */
function mp3Seconds(bytes: Uint8Array): number | undefined {
  const tagged = ascii(bytes, 0, 3) === 'ID3' && bytes.length >= 10;
  const start = tagged ? (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)) + 10 + (bytes[5] & 0x10 ? 10 : 0) : 0;
  let seconds = 0;
  let covered = 0;
  let kind = '';
  for (let at = start; at + 4 <= bytes.length;) {
    const frame = mp3Frame(bytes, at);
    const key = frame ? `${frame.mpeg1}/${frame.layer}/${frame.sampleRate}` : '';
    const fits = frame && (kind ? key === kind : at + frame.length + 4 > bytes.length || mp3Frame(bytes, at + frame.length));
    if (!frame || !fits) { at++; continue; }
    kind = key;
    seconds += frame.samples / frame.sampleRate;
    covered += frame.length;
    at += frame.length;
  }
  // Bytes the frames do not account for could still play somewhere: then the size decides.
  return covered > 0 && covered >= 0.9 * (bytes.length - start) ? seconds : undefined;
}

/** RIFF/WAVE PCM or float: every byte after the data chunk's header / (sample rate × channels × sample size). */
function wavSeconds(bytes: Uint8Array): number | undefined {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WAVE') return undefined;
  const data = viewOf(bytes);
  let rate = 0;
  for (let at = 12, chunks = 0; at + 8 <= bytes.length && chunks < 64; chunks++) {
    const id = ascii(bytes, at, at + 4);
    const size = data.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 24 <= bytes.length) {
      // format(2) channels(2) sample rate(4) byte rate(4, unused) block(2) bits(2); extensible: sub-format at 24
      const format = data.getUint16(at + 8, true) === 0xfffe && at + 34 <= bytes.length ? data.getUint16(at + 32, true) : data.getUint16(at + 8, true);
      const channels = data.getUint16(at + 10, true);
      const sampleRate = data.getUint32(at + 12, true);
      const bits = data.getUint16(at + 22, true);
      const pcm = (format === 1 || format === 3) && channels >= 1 && channels <= 8 && bits >= 8 && bits <= 64 && sampleRate >= 1_000 && sampleRate <= 384_000;
      rate = pcm ? sampleRate * channels * Math.ceil(bits / 8) : 0;
    }
    if (id === 'data') return rate ? (bytes.length - at - 8) / rate : undefined;
    at += 8 + size + (size & 1);
  }
  return undefined;
}

/**
 * How long WAV/MP3 bytes play, counted as a decoder would. Fields that only claim a length
 * (Xing/VBRI frame counts, the WAV byte rate and data size) are not used; undefined when the
 * bytes do not show it (another codec, frames that leave much of the file unexplained).
 */
export function playableSeconds(bytes: Uint8Array, format: AudioFormat): number | undefined {
  return format === 'mp3' ? mp3Seconds(bytes) : wavSeconds(bytes);
}

/** The playable length of a stored WAV/MP3 (one read of ≤ 10 MB); unmeasurable: the longest its size can play. */
function originalSeconds(ctx: ToolContext, info: MediaInfo, format: AudioFormat): number {
  try {
    const file = ctx.services.files.path(info.fileId);
    const seconds = statSync(file).size <= AUDIO_INPUT_BYTES ? playableSeconds(readFileSync(file), format) : undefined;
    if (seconds !== undefined) return seconds;
  } catch { /* unreadable: the size bound */ }
  return (info.size ?? AUDIO_INPUT_BYTES) / MIN_BYTES_PER_SECOND;
}

/** One listen: the stored bytes as they are, or the span [startMs, startMs + maxMs) decoded; `seconds` is what the estimate counts. */
export interface ListenPlan { original: boolean; startMs: number; maxMs: number; seconds: number }

/** The span the agent asked for: start/end in seconds, else a media: reference's time span, else from the start. */
function askedSpan(args: { fileId: string; start?: number; end?: number }): { startMs?: number; endMs?: number } {
  if (args.start !== undefined || args.end !== undefined) {
    return { startMs: args.start === undefined ? undefined : Math.round(args.start * 1000), endMs: args.end === undefined ? undefined : Math.round(args.end * 1000) };
  }
  const ref = parseMediaRef(args.fileId.trim().toLowerCase());
  return ref?.startMs !== undefined ? { startMs: ref.startMs, endMs: ref.endMs } : {};
}

/** What one listen sends, or why the asked span cannot be heard. A part the host decodes is clipped to end by DECODE_END_MS. */
export function listenPlan(ctx: ToolContext, info: MediaInfo, args: { fileId: string; start?: number; end?: number }): ListenPlan | { refused: string } {
  const asked = askedSpan(args);
  const format = audioFormat(info.mime, info.name);
  if (asked.startMs === undefined && asked.endMs === undefined && info.kind === 'audio' && format && (info.size ?? Infinity) <= AUDIO_INPUT_BYTES) {
    const seconds = originalSeconds(ctx, info, format);
    return { original: true, startMs: 0, maxMs: Math.round(seconds * 1000), seconds };
  }
  const startMs = Math.max(0, asked.startMs ?? 0);
  if (asked.endMs !== undefined && asked.endMs <= startMs) return { refused: 'The span ends before it starts: pass end after start (seconds).' };
  if (info.durationMs !== undefined && startMs >= info.durationMs) return { refused: `The recording is only ${timeText(info.durationMs)} long; start inside it.` };
  const byHost = hearFormat(info.mime, info.name) === 'host';
  if (byHost && startMs > DECODE_END_MS - 1_000) return { refused: TOO_FAR };
  let maxMs = Math.min(LISTEN_SPAN_MS, asked.endMs === undefined ? LISTEN_SPAN_MS : asked.endMs - startMs);
  if (info.durationMs !== undefined) maxMs = Math.min(maxMs, info.durationMs - startMs + LENGTH_MARGIN_MS);
  maxMs = Math.max(1_000, maxMs);
  if (byHost) maxMs = Math.min(maxMs, DECODE_END_MS - startMs);
  return { original: false, startMs, maxMs, seconds: maxMs / 1000 };
}

/** What a listen says about the rest of a recording whose heard part ended at `endMs`: the next call, or that later parts cannot be decoded here. */
export function moreAfter(info: Pick<MediaInfo, 'mime' | 'name'>, endMs: number): string {
  if (hearFormat(info.mime, info.name) === 'host' && endMs >= DECODE_END_MS - 1_000) return `The recording goes on after ${timeText(endMs)}, but later parts of it cannot be decoded here; send them as a file of their own.`;
  return `The recording goes on after ${timeText(endMs)}: call media.listen again with start ${Math.floor(endMs / 1000)} for the next part.`;
}
