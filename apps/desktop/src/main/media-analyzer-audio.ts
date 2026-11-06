// B-058 G6: the page side of a sound job in the media analyzer window (media-analyzer-page.ts serves it
// with the keyframe page; media-audio.ts holds main's rules). The page learns the file's length from an
// <audio> element's metadata (a MediaRecorder file without one: by seeking to its end), reads the job's
// blob – whole, or for a long file whose start decodes on its own only the bytes up to the span asked
// for – decodes it in an OfflineAudioContext at 16 kHz (Chromium decodes every container and codec the
// app window plays, a video's sound track too; no ffmpeg), mixes it down to mono, posts the span as
// PCM16 in chunks of ≤ 1 MiB at their byte offsets and ends with the file's length. The decode holds all
// the sound from the file's start, so it never covers more than spec.wholeMs: a span ending later is refused.
// Owns: the page side of the sound job. Never: reaches anything but its own origin (the CSP and the
// session refuse it), plays the sound, keeps the file's bytes after the job. audioPage must stay
// self-contained: it is served as its own source.

import type { AudioSpec } from './media-audio.ts';

/** The parts of an <audio> element the page uses (for the file's length only). */
export interface PageAudio {
  muted: boolean;
  preload: string;
  src: string;
  currentTime: number;
  readonly duration: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  removeAttribute(name: string): void;
  load(): void;
}

/** The parts of a decoded AudioBuffer the page uses. */
export interface PageAudioBuffer { readonly length: number; readonly duration: number; readonly numberOfChannels: number; getChannelData(channel: number): Float32Array }

/** The browser objects the sound job uses (the window itself; tests pass fakes). */
export interface AudioPageEnv {
  document: { createElement(tag: 'audio'): PageAudio };
  fetch(input: string, init?: RequestInit): Promise<Response>;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  OfflineAudioContext: new (channels: number, length: number, rate: number) => { decodeAudioData(data: ArrayBuffer): Promise<PageAudioBuffer> };
}

/** The sound job, start to end; every failure is posted as its stage ('decode', 'no-audio', 'too-long', 'too-far', 'too-large', 'send'). */
export async function audioPage(env: AudioPageEnv, spec: AudioSpec): Promise<void> {
  const post = async (path: string, body: string | ArrayBuffer, type: string): Promise<void> => {
    const response = await env.fetch(path, { method: 'POST', body, headers: { 'Content-Type': type } });
    if (!response.ok) throw new Error('refused');
  };
  let stage = 'decode';
  try {
    // The file's length in ms from its metadata, NaN when the element cannot read it (within spec.metaMs).
    const element = env.document.createElement('audio');
    const lengthMs = await new Promise<number>((resolve) => {
      let settled = false;
      let timer: unknown = null;
      const listeners: Array<[string, () => void]> = [];
      const finish = (ms: number) => {
        if (settled) return;
        settled = true;
        env.clearTimeout(timer);
        for (const [type, listener] of listeners) element.removeEventListener(type, listener);
        element.removeAttribute('src');
        element.load();
        resolve(ms);
      };
      const known = () => (Number.isFinite(element.duration) && element.duration > 0 ? element.duration * 1000 : Number.NaN);
      listeners.push(
        ['loadedmetadata', () => {
          if (!Number.isNaN(known())) finish(known());
          else if (element.duration === Number.POSITIVE_INFINITY) element.currentTime = 1e101; // a recording: its end tells the length
          else finish(Number.NaN);
        }],
        ['durationchange', () => { if (!Number.isNaN(known())) finish(known()); }],
        ['seeked', () => finish(Number.isNaN(known()) ? element.currentTime * 1000 : known())],
        ['error', () => finish(Number.NaN)],
      );
      for (const [type, listener] of listeners) element.addEventListener(type, listener);
      timer = env.setTimeout(() => finish(Number.NaN), spec.metaMs);
      element.muted = true;
      element.preload = 'metadata';
      element.src = 'video';
    });

    // Which bytes: all of them, or for a long file whose start decodes on its own the start up to the span's end.
    // Decoding holds everything from the file's start in memory, so never more than spec.wholeMs of sound: a file
    // read whole must be that short, a prefix must end its span by then (review fix: a late span of a long file
    // decoded the whole file – hours of floats on an 8 GB PC).
    const wantMs = spec.startMs + spec.maxMs;
    if ((spec.stream ? Math.min(lengthMs, wantMs) : lengthMs) > spec.wholeMs) { // an unknown length (NaN) is read whole
      stage = spec.stream ? 'too-far' : 'too-long';
      throw new Error(stage);
    }
    let end = spec.size - 1;
    let prefix = false;
    if (spec.stream && lengthMs > wantMs + spec.marginMs) {
      end = Math.min(spec.size - 1, Math.ceil((spec.size * (wantMs * 1.1 + spec.marginMs)) / lengthMs) + 65_536);
      prefix = end < spec.size - 1;
    }
    if (end + 1 > spec.inputBytes) { stage = 'too-large'; throw new Error(stage); }
    const response = await env.fetch('video', prefix ? { headers: { Range: `bytes=0-${end}` } } : undefined);
    if (!response.ok) throw new Error(stage);
    const bytes = await response.arrayBuffer();

    // Decoded and resampled to the context's rate by the browser; a file it can play but not decode has no readable sound.
    let decoded: PageAudioBuffer;
    try {
      decoded = await new env.OfflineAudioContext(1, 1, spec.rate).decodeAudioData(bytes);
    } catch {
      stage = Number.isNaN(lengthMs) ? 'decode' : 'no-audio';
      throw new Error(stage);
    }
    if (!decoded.length) { stage = 'no-audio'; throw new Error(stage); }

    stage = 'send';
    const from = Math.min(decoded.length, Math.round((spec.startMs * spec.rate) / 1000));
    const to = Math.min(decoded.length, from + Math.round((spec.maxMs * spec.rate) / 1000));
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) channels.push(decoded.getChannelData(channel));
    const per = Math.floor(spec.chunkBytes / 2);
    for (let at = from; at < to; at += per) {
      const count = Math.min(per, to - at);
      const out = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        let sum = 0;
        for (const data of channels) sum += data[at + i];
        const value = sum / channels.length;
        out[i] = Math.round((value > 1 ? 1 : value < -1 ? -1 : value || 0) * 32767);
      }
      await post(`pcm?at=${(at - from) * 2}`, out.buffer, 'application/octet-stream');
    }
    const durationMs = Math.round(prefix ? Math.max(lengthMs, decoded.duration * 1000) : decoded.duration * 1000);
    await post('done', JSON.stringify({ durationMs, partial: prefix || to < decoded.length }), 'application/json');
  } catch {
    await post('fail', JSON.stringify({ reason: stage }), 'application/json').catch(() => undefined);
  }
}
