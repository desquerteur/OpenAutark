// B-058 G5: how a 16 kHz take is cut before the local recognizer hears it. A recognizer punctuates and
// capitalises each piece on its own, so pieces must be whole sentences: a take of up to WHOLE_SECONDS goes
// whole (only the silence before the first and after the last word the VAD found is trimmed); a longer one
// is packed into chunks of at most ~WHOLE_SECONDS, cut at its longest pauses (a chunk too long is split at
// its widest gap, again and again). Each chunk keeps PAD_SECONDS of sound around its speech (the VAD clips
// word onsets – FastConformer dropped a leading "Hallo" without it) but never reaches into a neighbour's
// speech. Without Silero VAD a long take is cut at its quietest moments (quietCuts).
// Measured on the reference PC (29.10.2026): per-VAD-segment decoding cut a 41 s German paragraph into 9
// pieces ("…Zusammenfassung Wenn etwas dringendes dabei ist. bekomme ich…"); packed it is 4, and
// FastConformer's WER fell from 2.2 to 0 % (the 16.8 s "Hallo." + run-on take: 8.8 → 2.9 %, now whole).
// Owns: the packing rule and the quiet cuts. Never: loads models, runs the VAD or decodes (engine.ts does).

import type { LocalSpeechKind } from '../../../shared/model/local-speech-models.ts';

export const RATE = 16_000;
/** Takes up to this long go to the recognizer whole; longer ones are packed into chunks of at most this long. */
export const WHOLE_SECONDS = 20;
/** Sound kept before and after the speech the VAD found (transducers; Canary: padFor). */
export const PAD_SECONDS = 0.3;

/**
 * The padding per model kind, measured on the reference PC (29.10.2026, 20 s chunks, WER de_16k / owner_16k):
 * FastConformer 0 s 1.1 / 11.8 %, 0.15 s 0 / 5.9 %, 0.3 s 0 / 2.9 %; Canary 0 s 2.2 / 5.9 %, 0.15 s 3.4 / 5.9 %,
 * 0.3 s 6.7 / 8.8 % (silence makes Canary misspell) – so Canary hears the VAD's speech without padding.
 */
export const padFor = (kind: LocalSpeechKind): number => (kind === 'canary' ? 0 : PAD_SECONDS);

/** A stretch of a take in samples: [start, end). */
export interface Span { start: number; end: number }

/** A piece the recognizer hears: its first sample in the take, and its samples. */
export interface Piece { start: number; samples: Float32Array }

/**
 * The chunks the recognizer hears, from the speech spans the VAD found in a take of `total` samples:
 * none without speech, one for a take whose speech spans at most `maxSeconds`, else chunks cut at the
 * longest pauses (see the header), each padded by PAD_SECONDS up to halfway to its neighbours.
 */
export function packSpeech(spans: readonly Span[], total: number, rate = RATE, maxSeconds = WHOLE_SECONDS, padSeconds = PAD_SECONDS): Span[] {
  const speech = spans.filter((span) => span.end > span.start).map((span) => ({ start: Math.max(0, span.start), end: Math.min(total, span.end) })).sort((a, b) => a.start - b.start);
  if (!speech.length) return [];
  const max = maxSeconds * rate;
  const chunks: Span[] = [];
  const split = (group: Span[]): void => {
    const start = group[0].start;
    const end = Math.max(...group.map((span) => span.end));
    if (group.length === 1 || end - start <= max) { chunks.push({ start, end }); return; }
    let at = 1;
    let widest = -Infinity;
    for (let i = 1; i < group.length; i++) {
      const gap = group[i].start - group[i - 1].end;
      if (gap > widest) { widest = gap; at = i; }
    }
    split(group.slice(0, at));
    split(group.slice(at));
  };
  split(speech);
  const pad = Math.round(padSeconds * rate);
  return chunks.map((chunk, index) => {
    const before = index > 0 ? Math.ceil((chunks[index - 1].end + chunk.start) / 2) : 0;
    const after = index < chunks.length - 1 ? Math.floor((chunk.end + chunks[index + 1].start) / 2) : total;
    return { start: Math.max(before, chunk.start - pad), end: Math.min(after, chunk.end + pad) };
  });
}

/** The pieces of `samples` for the chunks (views, no copies). */
export const piecesOf = (samples: Float32Array, chunks: readonly Span[]): Piece[] => chunks.map((chunk) => ({ start: chunk.start, samples: samples.subarray(chunk.start, chunk.end) }));

/** Cuts at the quietest 50 ms within the last 4 s of every WHOLE_SECONDS window (no VAD installed). */
export function quietCuts(samples: Float32Array, rate = RATE): Piece[] {
  const window = WHOLE_SECONDS * rate;
  if (samples.length <= window) return [{ start: 0, samples }];
  const frame = Math.round(rate * 0.05);
  const parts: Piece[] = [];
  let from = 0;
  while (samples.length - from > window) {
    let best = from + window;
    let quietest = Infinity;
    for (let at = from + window - 4 * rate; at + frame <= from + window; at += frame) {
      let energy = 0;
      for (let i = at; i < at + frame; i++) energy += samples[i] * samples[i];
      if (energy < quietest) { quietest = energy; best = at + Math.floor(frame / 2); }
    }
    parts.push({ start: from, samples: samples.subarray(from, best) });
    from = best;
  }
  parts.push({ start: from, samples: samples.subarray(from) });
  return parts;
}
