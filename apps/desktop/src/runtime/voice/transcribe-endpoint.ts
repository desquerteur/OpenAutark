// B-058: the transcription endpoint's side of voice/transcribe.ts (moved out of it for size, grown for long
// recordings) – what goes up and how. A stored take the endpoint takes as it is (audioExtension, ≤ MAX_AUDIO_BYTES)
// is uploaded unchanged: its own quality, the whole recording. Anything else media/hear-any.ts hears – a format the
// endpoint does not take (mov, mkv, raw PCM) or a file over 25 MB (a long WAV, a phone video) – goes up as the
// decoded 16 kHz mono WAV of its first AUDIO_DECODE_LIMITS.maxMs, in pieces of at most PIECE_MS (19.2 MB each), each
// cut at the quietest moment of its last seconds, one request per piece, the texts joined. A recording heard only in
// part says so (HeardPart; partialNote is the agent transcript's first line). The request: multipart file, model,
// response_format json, language (G8: `languages[]` for gpt-transcribe), the learned words as prompt; each request
// ≤ timeoutMs, redirects refused, the answer ≤ 1 MiB, the key redacted.
// Owns: these rules. Never: logs or returns the key or the provider's raw error body, or sends audio anywhere but
// the one endpoint.

import type { HeardSegment, HeardWord } from '../../shared/api/methods-app.ts';
import type { FileRef } from '../../shared/model/system.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { encodeWav } from '../../shared/voice/wav.ts';
import { hearFormat, hostDecodes, pcmOf, type HeardPcm, type HearServices } from '../media/hear-any.ts';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** The longest decoded piece one request uploads: 10 minutes of 16 kHz PCM16 are 19.2 MB, below MAX_AUDIO_BYTES. */
export const PIECE_MS = 10 * 60_000;
/** A piece ends at the quietest 50 ms of its last this-many ms (no word cut in half where a pause is near). */
const QUIET_MS = 10_000;
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_TEXT = 100_000;
/** G8: OpenAI's gpt-transcribe models take `languages[]` (developers.openai.com speech-to-text). */
export const LANGUAGES_FIELD = /^gpt-transcribe/i;
const TOO_LARGE = 'Recordings for transcription must be smaller than 25 MB.';
const NO_TEXT = 'The transcription returned no usable text.';

/** The part of a recording a decode heard when the recording goes on after it (ms heard from the start, the whole length). */
export interface HeardPart { heardMs: number; durationMs: number }

/** What one transcription returns: the text (a local model: also segments and word times); `partial`: only the start was heard. */
export interface Heard { text: string; segments?: HeardSegment[]; words?: HeardWord[]; partial?: HeardPart }

const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
};

/** Audio format of a stored file the endpoint takes as it is (mime first, then the file name), or undefined. */
export function audioExtension(mime: string, name: string): string | undefined {
  const base = mime.split(';')[0].trim().toLowerCase();
  if (EXTENSIONS[base]) return EXTENSIONS[base];
  const ext = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase();
  return ext && Object.values(EXTENSIONS).includes(ext) ? ext : undefined;
}

/** "en-US" → "en" (the endpoint expects ISO-639-1). */
export function languageCode(language: string | undefined): string | undefined {
  const match = /^([a-z]{2,3})(?:[-_]|$)/i.exec(language?.trim() ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

/** The heard part of a decode (hear-any.ts pcmOf) when the recording goes on after it, else undefined. */
export function partOf(pcm: Pick<HeardPcm, 'samples' | 'sampleRate' | 'durationMs' | 'partial'>): HeardPart | undefined {
  return pcm.partial ? { heardMs: Math.round((pcm.samples.length / pcm.sampleRate) * 1000), durationMs: pcm.durationMs } : undefined;
}

/** The first line of an agent transcript heard only in part (attachments and media.transcribe show it; never a silent cut). */
export function partialNote(part: HeardPart): string {
  const heard = Math.max(1, Math.round(part.heardMs / 60_000));
  const whole = Math.round(part.durationMs / 60_000);
  const span = heard === 1 ? 'first minute' : `first ${heard} minutes`;
  return `[Only the ${span} of this ${whole > heard ? `${whole}-minute ` : ''}recording ${heard === 1 ? 'is' : 'are'} transcribed.]`;
}

/** Where the pieces of `samples` end: at most `max` samples each, each cut at the quietest 50 ms of its last QUIET_MS. */
export function pieceEnds(samples: Float32Array, rate: number, max: number): number[] {
  const ends: number[] = [];
  const frame = Math.max(1, Math.round(rate * 0.05));
  const search = Math.min(Math.round((QUIET_MS / 1000) * rate), Math.floor(max / 4)); // ≤ a quarter: every piece moves on
  for (let from = 0; samples.length - from > max;) {
    let best = from + max;
    let quietest = Infinity;
    for (let at = from + max - search; at + frame <= from + max; at += frame) {
      let energy = 0;
      for (let i = at; i < at + frame; i++) energy += samples[i] * samples[i];
      if (energy < quietest) { quietest = energy; best = at + Math.floor(frame / 2); }
    }
    ends.push(best);
    from = best;
  }
  ends.push(samples.length);
  return ends;
}

/** One request's file. */
export interface UploadPiece { bytes: Uint8Array; mime: string; name: string }
/** What goes up: `count` pieces (made one at a time – a decoded piece is encoded when it is sent) and the heard part. */
export interface Upload { count: number; piece(index: number): UploadPiece; partial?: HeardPart }

/** How a stored take goes up: 'raw' as it is, 'decoded' as WAV pieces; throws the clear refusal when neither works. */
export function uploadWay(s: Pick<HearServices, 'host'>, ref: Pick<FileRef, 'mime' | 'name' | 'size'>): 'raw' | 'decoded' {
  if (!ref.size) throw new WorkforceError('bad_request', 'The recording is empty. Record again.');
  const extension = audioExtension(ref.mime, ref.name);
  if (extension && ref.size <= MAX_AUDIO_BYTES) return 'raw';
  const format = hearFormat(ref.mime, ref.name);
  if (format === 'wav' || format === 'pcm' || (format === 'host' && hostDecodes(s))) return 'decoded';
  if (!extension) throw new WorkforceError('bad_request', 'This recording format cannot be transcribed (use webm, ogg, m4a, mp3, wav or flac).');
  throw new WorkforceError('bad_request', TOO_LARGE);
}

/** The take as it goes up (see uploadWay): its bytes as they are, or the decoded first AUDIO_DECODE_LIMITS.maxMs in pieces of ≤ `pieceMs`. */
export async function uploadOf(s: HearServices, ref: Pick<FileRef, 'id' | 'mime' | 'name'>, way: 'raw' | 'decoded', pieceMs = PIECE_MS): Promise<Upload> {
  if (way === 'raw') {
    const bytes = await s.files.read(ref.id);
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new WorkforceError('bad_request', TOO_LARGE);
    const piece = { bytes, mime: ref.mime.split(';')[0] || 'application/octet-stream', name: `dictation.${audioExtension(ref.mime, ref.name)}` };
    return { count: 1, piece: () => piece };
  }
  let pcm: HeardPcm;
  try { pcm = await pcmOf(s, ref.id); } catch (error) {
    if (error instanceof WorkforceError) throw error;
    throw new WorkforceError('unavailable', 'This recording could not be decoded on this PC.');
  }
  const ends = pieceEnds(pcm.samples, pcm.sampleRate, Math.max(1, Math.round((pieceMs / 1000) * pcm.sampleRate)));
  const partial = partOf(pcm);
  return {
    count: ends.length,
    piece: (index) => ({
      bytes: encodeWav(pcm.samples.subarray(index ? ends[index - 1] : 0, ends[index]), pcm.sampleRate), mime: 'audio/wav',
      name: ends.length > 1 ? `dictation-${index + 1}.wav` : 'dictation.wav',
    }),
    ...(partial ? { partial } : {}),
  };
}

/** One transcription at the endpoint. `dictation`: no words heard is '' (SM9), not a failure. */
export interface EndpointCall {
  url: string; key?: string; model: string; language?: string; prompt?: string; dictation: boolean;
  fetch: FetchFn; timeoutMs: number;
}

/** The upload heard by the endpoint: one request per piece in turn, the texts joined; '' for a dictation without words (SM9). */
export async function endpointHeard(call: EndpointCall, upload: Upload): Promise<Heard> {
  const texts: string[] = [];
  for (let index = 0; index < upload.count; index++) {
    const text = await ask(call, upload.piece(index));
    if (text) texts.push(text);
  }
  const text = texts.join(' ');
  if (!text && !call.dictation) throw new WorkforceError('unavailable', NO_TEXT);
  return upload.partial ? { text, partial: upload.partial } : { text };
}

/** One request with its own timeout: the piece's text ('' when no words were heard). */
async function ask(call: EndpointCall, piece: UploadPiece): Promise<string> {
  const body = new FormData();
  body.set('file', new Blob([new Uint8Array(piece.bytes)], { type: piece.mime }), piece.name);
  body.set('model', call.model);
  body.set('response_format', 'json');
  if (call.language) body.set(LANGUAGES_FIELD.test(call.model) ? 'languages[]' : 'language', call.language);
  if (call.prompt) body.set('prompt', call.prompt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  try {
    const response = await post(call, body, controller.signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) throw new WorkforceError('unavailable', 'The transcription provider rejected the account. Reconnect it in Settings › Models.');
      if (response.status === 429) throw new WorkforceError('rate_limited', 'The transcription provider limit was reached. Try again later.');
      throw new WorkforceError('bad_request', 'The transcription service did not accept the audio. Check the speech-to-text model (routing.stt in settings.json).');
    }
    const result = await readJson(response) as { text?: unknown } | null;
    const textValue = result?.text;
    // No text string at all is a broken or misconfigured server, never silence (SM9).
    if (typeof textValue !== 'string') throw new WorkforceError('unavailable', 'The transcription provider returned an invalid answer.');
    if (!textValue.trim()) return '';
    if (textValue.length > MAX_TEXT || textValue.includes('\0')) throw new WorkforceError('unavailable', NO_TEXT);
    return call.key ? textValue.split(call.key).join('[redacted]').trim() : textValue.trim();
  } catch (error) {
    if (error instanceof WorkforceError) throw error;
    if (controller.signal.aborted) throw new WorkforceError('timeout', 'The transcription timed out. Try again when the connection is better.');
    throw new WorkforceError('unavailable', 'The transcription failed.');
  } finally {
    clearTimeout(timer);
  }
}

/** One POST to the transcription endpoint; network failures become user-safe errors. */
async function post(call: EndpointCall, body: FormData, signal: AbortSignal): Promise<Response> {
  try {
    return await call.fetch(call.url, { method: 'POST', headers: call.key ? { Authorization: `Bearer ${call.key}` } : {}, body, redirect: 'error', signal });
  } catch {
    if (signal.aborted) throw new WorkforceError('timeout', 'The transcription timed out. Try again when the connection is better.');
    throw new WorkforceError('unavailable', 'Could not reach the transcription service.');
  }
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new WorkforceError('unavailable', 'The transcription returned no answer.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) { await reader.cancel().catch(() => undefined); throw new WorkforceError('unavailable', 'The transcription answer is too large.'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new WorkforceError('unavailable', 'The transcription provider returned an invalid answer.'); }
}
