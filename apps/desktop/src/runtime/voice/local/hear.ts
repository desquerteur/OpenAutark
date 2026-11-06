// B-047 D14: a stored recording as the local recognizer reads it, and its answer in the shape of the
// endpoint path (voice/transcribe.ts Heard): WAV (any PCM or float encoding, any rate and channel count)
// or raw PCM16 LE ('audio/pcm', 'audio/L16;rate=…', 16 kHz without a rate) – compressed takes (webm, ogg,
// mp3, m4a) are not decoded here (media/hear-any.ts, through the host). Segments and words keep their times.
// Owns: the format rule, the decode call and the result shape. Never: loads models (engine.ts).

import { parseWav, pcm16Samples, type MonoAudio } from '../../../shared/voice/wav.ts';
import type { HeardSegment, HeardWord, LocalHeard } from './engine.ts';

const PCM_RATE = /(?:^|;)\s*rate=(\d{4,6})/i;

/** What a transcription returns from the local model (text, segments and word times). */
export interface LocalTranscript { text: string; segments?: HeardSegment[]; words?: HeardWord[] }

/** The recording kind the local recognizer reads, else undefined (a compressed format). */
export function localFormat(mime: string, name: string): 'wav' | 'pcm' | undefined {
  const base = mime.split(';')[0].trim().toLowerCase();
  if (['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(base)) return 'wav';
  if (base === 'audio/pcm' || base === 'audio/l16') return 'pcm';
  return !base || base === 'application/octet-stream' ? (/\.wav$/i.test(name) ? 'wav' : /\.pcm$/i.test(name) ? 'pcm' : undefined) : undefined;
}

/** The recording as mono floats; throws a plain Error for a broken or unsupported WAV. */
export function decodeRecording(bytes: Uint8Array, mime: string, name: string): MonoAudio {
  const format = localFormat(mime, name);
  if (format === 'wav') return parseWav(bytes);
  if (format === 'pcm') return { samples: pcm16Samples(bytes), sampleRate: Number(PCM_RATE.exec(mime)?.[1] ?? 16_000) };
  throw new Error('not a WAV or PCM recording');
}

/** The engine's answer as a transcription result (`dictation`: with its segments and word times). */
export function localTranscript(heard: LocalHeard, dictation: boolean): LocalTranscript {
  const text = heard.text.trim();
  if (!text) return { text: '' };
  const out: LocalTranscript = { text };
  if (!dictation) return out;
  if (heard.segments.length) out.segments = heard.segments;
  if (heard.words.length) out.words = heard.words;
  return out;
}
