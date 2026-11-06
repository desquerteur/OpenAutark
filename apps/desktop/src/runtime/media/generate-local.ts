// B-058 G12: speech without a key – the local voice (Supertonic 3 through RuntimeServices.stt: speak and
// pullLocal of voice/local/service.ts) when no speech model is connected or the chosen one cannot serve. The
// person's chosen local voice speaks when it is downloaded; else the recommended one (Supertonic 3, 129 MB) is
// downloaded on demand and chosen by that pull, waited for up to DOWNLOAD_MS (measured live 29.10.: download,
// unpack and load ~2 min; the download goes on when the call ends first: the next call joins it), then the
// speaking has its own deadline, which grows with the text (review fix: live 29.10. the voice spoke 4 s of audio in
// 3.2 s here, so a 4,096-character text needs ~4 min – a flat 120 s failed every text over ~1,800 characters).
// Long texts are spoken in lines of at most 2,000 characters, split at sentence ends, with a short pause between
// them, and stored as one PCM16 WAV.
// Language: the request's, else the text's own (a small stop-word guess), else the profile language
// (service.ts modelLanguage). Voice: a speaker number 0–9; any other voice name speaks with voice 0.
// Owns: these rules. Never: sends text anywhere, changes a setting itself (the pull chooses its model), or
// loads a second model while one is loading.

import type { RuntimeServices } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { encodeWav, pcm16Samples } from '../../shared/voice/wav.ts';
import type { Generated, GenerationRequest } from './providers/types.ts';

export type LocalVoiceServices = Pick<RuntimeServices, 'stt' | 'settings' | 'log'>;

/** The local voice fetched when none is downloaded (shared/model/local-speech-models.ts). */
export const LOCAL_TTS = 'supertonic-3-int8';
const LINE_CHARS = 2_000;
const PAUSE_S = 0.25;
/** How long a call waits for the voice's one-time download (it goes on afterwards; the next call joins it). */
export const DOWNLOAD_MS = 300_000;
/** The speaking deadline: at least 120 s, else ~90 ms per character (measured ~65 ms here, see the header), at most 7 min. */
export function localSpeakMs(chars: number): number {
  return Math.min(420_000, Math.max(120_000, Math.round(chars * 90)));
}

/** Whether the local voice can run on this PC at all (the engine loads; the model may still need its download). */
export function localVoiceReady(s: Pick<RuntimeServices, 'stt'>): boolean {
  try { return s.stt.localModels().engine.ready; } catch { return false; }
}

const STOP_WORDS: Record<string, readonly string[]> = {
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'sie', 'wir', 'ein', 'eine', 'mit', 'auf', 'für', 'auch', 'zu', 'den', 'dem', 'es', 'du'],
  en: ['the', 'and', 'is', 'not', 'you', 'we', 'with', 'for', 'this', 'that', 'are', 'to', 'of', 'it', 'in', 'a'],
  fr: ['le', 'la', 'les', 'et', 'est', 'pas', 'vous', 'nous', 'une', 'avec', 'pour', 'des', 'du', 'je', 'que', 'dans'],
  es: ['el', 'los', 'las', 'y', 'es', 'no', 'usted', 'nosotros', 'una', 'con', 'para', 'del', 'que', 'en', 'por', 'yo'],
  it: ['il', 'gli', 'e', 'è', 'non', 'noi', 'una', 'con', 'per', 'della', 'che', 'sono', 'questo', 'di', 'io'],
  nl: ['de', 'het', 'en', 'is', 'niet', 'wij', 'een', 'met', 'voor', 'van', 'dat', 'ik', 'zijn', 'ook'],
  pt: ['o', 'os', 'as', 'e', 'é', 'não', 'nós', 'uma', 'com', 'para', 'do', 'que', 'em', 'eu', 'você'],
};

/** The text's language by its common words (at least two hits and ahead of the next one), else undefined. */
export function guessLanguage(text: string): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  if (/ß/.test(text)) return 'de';
  const bonus = (lang: string) => (lang === 'de' && /[äöü]/i.test(text) ? 2 : 0);
  const scores = Object.entries(STOP_WORDS).map(([lang, list]) => [lang, words.filter((word) => list.includes(word)).length + bonus(lang)] as const).sort((a, b) => b[1] - a[1]);
  const [best, next] = scores;
  return best && best[1] >= 2 && best[1] > (next?.[1] ?? 0) ? best[0] : undefined;
}

/** Lines of at most `max` characters, split at sentence ends (else at spaces). */
export function speechLines(text: string, max = LINE_CHARS): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]*\s*/g) ?? [];
  const lines: string[] = [];
  let line = '';
  const push = (part: string) => { if (part.trim()) lines.push(part.trim()); };
  for (const sentence of sentences) {
    if ((line + sentence).length <= max) { line += sentence; continue; }
    push(line);
    line = '';
    let rest = sentence;
    while (rest.length > max) {
      const cut = rest.lastIndexOf(' ', max) > max / 2 ? rest.lastIndexOf(' ', max) : max;
      push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  push(line);
  return lines;
}

/** The chosen local voice when it is downloaded, else a downloaded one or the recommended one pulled (the pull chooses it). */
async function ensureVoice(s: LocalVoiceServices, until: Promise<never>, onStatus?: (note: string) => void): Promise<void> {
  const offers = s.stt.localModels().models.filter((offer) => offer.purpose === 'tts');
  let chosen: string | undefined;
  try { chosen = s.settings.get().voice?.localTts || undefined; } catch { chosen = undefined; }
  if (offers.some((offer) => offer.id === chosen && offer.installed)) return;
  const pick = offers.find((offer) => offer.installed) ?? offers.find((offer) => offer.recommended) ?? offers.find((offer) => offer.id === LOCAL_TTS);
  if (!pick) throw new WorkforceError('unavailable', 'No local voice is offered on this PC.');
  if (!pick.installed) onStatus?.(`downloading the local voice (${pick.label}, ${pick.downloadMb} MB)`);
  const pull = s.stt.pullLocal(pick.id);
  pull.catch(() => undefined);
  await Promise.race([pull, until]);
}

/**
 * The text spoken by the local voice as one WAV (see the header). `onStatus` hears "downloading the local
 * voice" before a download. Rejects with a clear WorkforceError (download still running at the deadline,
 * engine or memory failure, stop).
 */
export async function speakLocally(s: LocalVoiceServices, request: Pick<GenerationRequest, 'text' | 'prompt' | 'voice' | 'language'>, options: { signal?: AbortSignal; timeoutMs?: number; downloadMs?: number; onStatus?: (note: string) => void } = {}): Promise<Generated & { model: string; language?: string; voice: string }> {
  const text = (request.text ?? request.prompt).trim();
  if (!text) throw new WorkforceError('bad_request', 'Write the text to speak.');
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new WorkforceError('cancelled', 'Stopped.'));
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  /** Rejects with `message` after `ms`, or at a stop. */
  const within = (ms: number, message: string) => {
    const late = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new WorkforceError('timeout', message)), ms);
      (timer as { unref?: () => void }).unref?.();
      timers.push(timer);
    });
    const until = Promise.race([late, stopped]);
    until.catch(() => undefined);
    return until;
  };
  stopped.catch(() => undefined);
  try {
    // The one-time download has its own budget (live 29.10.: 129 MB, unpack and load took ~2 minutes here).
    await ensureVoice(s, within(options.downloadMs ?? DOWNLOAD_MS, 'The local voice is still downloading. Try again in a few minutes.'), options.onStatus);
    const until = within(options.timeoutMs ?? localSpeakMs(text.length), 'The local voice took too long. Try a shorter text.');
    // At the deadline or a stop the voice stops too: no further sentence is spoken once the caller gave up.
    const quit = new AbortController();
    until.catch(() => quit.abort());
    const language = request.language?.trim().toLowerCase() || guessLanguage(text);
    const voice = /^\d{1,2}$/.test(request.voice?.trim() ?? '') ? request.voice!.trim() : '0';
    const parts: Float32Array[] = [];
    let rate = 0;
    const lines = speechLines(text);
    for (const [index, line] of lines.entries()) {
      if (lines.length > 1) options.onStatus?.(`speaking part ${index + 1} of ${lines.length}`);
      const spoken = await Promise.race([s.stt.speak({ text: line, voice, language, signal: quit.signal }), until]);
      if (!spoken.audio) continue;
      if (rate && spoken.sampleRate !== rate) throw new WorkforceError('unavailable', 'The local voice changed while speaking. Try again.');
      rate = spoken.sampleRate;
      if (parts.length) parts.push(new Float32Array(Math.round(rate * PAUSE_S)));
      parts.push(pcm16Samples(Buffer.from(spoken.audio, 'base64')));
    }
    if (!rate) throw new WorkforceError('unavailable', 'The local voice returned no audio.');
    const samples = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { samples.set(part, at); at += part.length; }
    let model = LOCAL_TTS;
    try { model = s.settings.get().voice?.localTts || LOCAL_TTS; } catch { /* the default */ }
    return {
      bytes: encodeWav(samples, rate), mime: 'audio/wav', extension: 'wav', durationMs: Math.round((samples.length / rate) * 1000),
      model: `local:${model}`, voice, ...(language ? { language } : {}),
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}
