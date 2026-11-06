// Pure audio helpers for the microphone paths:
//   dictation        – microphone floats at any sample rate → 16 kHz mono PCM16 little-endian with a
//                      windowed-sinc low-pass (`lowPass`), so 8–24 kHz content does not fold into the
//                      speech band, and the take as a 16 kHz WAV (wavFile);
//   conversation     – a tiny level-based utterance detector (speech start / end of speech);
//   realtime voice   – the same encoder at 24 kHz (`targetRate`) and PCM16 back to floats for playback;
//   level meter      – block levels as 0..1 bars (meterLevel) in a fixed-size history (LevelHistory).
// Owns: resampling, sample encoding and the detector rules. Never: touches the DOM, the microphone or
// the bridge (lib/microphone.ts and the callers do), so tests run in Node.

export const PCM_RATE = 16_000;

/** Half the low-pass filter's length in output samples (taps on each side of a sample). */
const HALF_TAPS = 16;
const PHASES = 64;

/**
 * Turns microphone blocks into PCM16 LE bytes at 16 kHz – or `targetRate`. Without `lowPass`:
 * nearest-sample decimation (exact sample counts, the realtime call path); with it: a windowed-sinc
 * band-limited resampler (cutoff 0.45 × the target rate), delayed by HALF_TAPS output samples –
 * flush() gives the rest at the end.
 */
export class Pcm16Encoder {
  private readonly step: number;
  private phase = 0;
  private readonly filter: SincResampler | null;

  constructor(inputRate: number, targetRate: number = PCM_RATE, options: { lowPass?: boolean } = {}) {
    this.step = Math.max(1, inputRate / targetRate);
    this.filter = options.lowPass && this.step > 1 ? new SincResampler(this.step) : null;
  }

  /** Encodes one block; the fractional position carries over to the next block. */
  push(input: Float32Array): Uint8Array {
    if (this.filter) return encode16(this.filter.push(input));
    const picked: number[] = [];
    for (; this.phase < input.length; this.phase += this.step) picked.push(input[Math.floor(this.phase)] || 0);
    this.phase -= input.length;
    return encode16(picked);
  }

  /** The filter's delayed tail (zero padding); empty without `lowPass`. */
  flush(): Uint8Array {
    return this.filter ? encode16(this.filter.push(new Float32Array(Math.ceil(HALF_TAPS * this.step) + 1))) : new Uint8Array(0);
  }
}

function encode16(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index++) view.setInt16(index * 2, Math.round(Math.max(-1, Math.min(1, samples[index] || 0)) * 32767), true);
  return out;
}

/** Band-limited resampling by `step` (input samples per output sample), Blackman-windowed sinc, table of PHASES fractional phases. */
class SincResampler {
  private readonly step: number;
  private readonly width: number; // input samples on each side of an output position
  private readonly table: Float32Array[];
  private history = new Float32Array(0);
  private position: number; // the next output position, in input samples relative to history[0]

  constructor(step: number) {
    this.step = step;
    this.width = Math.ceil(HALF_TAPS * step);
    const cutoff = 0.45 / step; // cycles per input sample
    this.table = Array.from({ length: PHASES }, (_, phase) => {
      const fraction = phase / PHASES;
      const taps = new Float32Array(2 * this.width + 1);
      let sum = 0;
      for (let k = -this.width; k <= this.width; k++) {
        const x = k - fraction;
        const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
        const w = (x + this.width + 1) / (2 * this.width + 2); // 0..1 across the window
        const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
        taps[k + this.width] = sinc * blackman;
        sum += taps[k + this.width];
      }
      for (let i = 0; i < taps.length; i++) taps[i] /= sum; // unity gain at DC
      return taps;
    });
    this.position = this.width; // the first output sample is centred on input 0 (zeros before it)
    this.history = new Float32Array(this.width); // the zeros before input 0
  }

  push(input: Float32Array): number[] {
    const data = new Float32Array(this.history.length + input.length);
    data.set(this.history);
    data.set(input, this.history.length);
    const out: number[] = [];
    while (this.position + this.width + 1 < data.length) {
      let base = Math.floor(this.position);
      let phase = Math.round((this.position - base) * PHASES);
      if (phase === PHASES) { base += 1; phase = 0; }
      const taps = this.table[phase];
      let sum = 0;
      for (let k = 0; k < taps.length; k++) sum += data[base - this.width + k] * taps[k];
      out.push(sum);
      this.position += this.step;
    }
    const keep = Math.max(0, Math.floor(this.position) - this.width); // samples no output position needs any more
    this.history = data.slice(keep);
    this.position -= keep;
    return out;
  }
}

/** A 16 kHz mono PCM16 WAV file of the take's bytes (the runtime's speech model reads it without a codec). */
export function wavFile(chunks: readonly Uint8Array[], sampleRate: number = PCM_RATE): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(44 + size);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) out[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + size, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, size, true);
  let offset = 44;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** A block's RMS as a 0..1 bar height on a dB scale (−60 dB → 0, −10 dB and louder → 1). */
export function meterLevel(level: number): number {
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  return Math.max(0, Math.min(1, (db + 60) / 50));
}

/** The last `size` bar levels (oldest first) for the scrolling level meter; `version` moves on every push. */
export class LevelHistory {
  readonly size: number;
  private readonly values: Float32Array;
  private next = 0;
  version = 0;

  constructor(size = 48) {
    this.size = size;
    this.values = new Float32Array(size);
  }

  push(level: number): void {
    this.values[this.next] = Math.max(0, Math.min(1, level));
    this.next = (this.next + 1) % this.size;
    this.version += 1;
  }

  clear(): void {
    this.values.fill(0);
    this.next = 0;
    this.version += 1;
  }

  /** Oldest first. */
  list(): number[] {
    return Array.from({ length: this.size }, (_, index) => this.values[(this.next + index) % this.size]);
  }
}

/** PCM16 LE bytes → floats in [-1, 1] (an odd trailing byte is ignored). */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < out.length; index++) out[index] = view.getInt16(index * 2, true) / 32768;
  return out;
}

/** Root mean square of one block (0..1 for normal microphone input). */
export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export interface DetectorOptions {
  /** Level above which a block counts as speech. */
  threshold?: number;
  /** Silence after speech that ends the utterance. */
  silenceMs?: number;
  /** Hard cap of one utterance. */
  maxMs?: number;
}

/**
 * Speech start / end from block levels (the legacy rules: 0.018 RMS, 1.1 s silence, 120 s cap).
 * `feed` answers 'start' when speech begins, 'end' when the utterance is over, else null.
 */
export class UtteranceDetector {
  private readonly threshold: number;
  private readonly silenceMs: number;
  private readonly maxMs: number;
  private startedAt: number | null = null;
  private lastSound = 0;

  constructor(options: DetectorOptions = {}) {
    this.threshold = options.threshold ?? 0.018;
    this.silenceMs = options.silenceMs ?? 1100;
    this.maxMs = options.maxMs ?? 120_000;
  }

  get speaking(): boolean { return this.startedAt !== null; }

  feed(level: number, now: number): 'start' | 'end' | null {
    const loud = level > this.threshold;
    if (loud) this.lastSound = now;
    if (this.startedAt === null) {
      if (!loud) return null;
      this.startedAt = now;
      return 'start';
    }
    if (now - this.lastSound > this.silenceMs || now - this.startedAt >= this.maxMs) {
      this.startedAt = null;
      return 'end';
    }
    return null;
  }

  /** Forget a running utterance (e.g. while the reply is spoken). */
  reset(): void { this.startedAt = null; }
}
