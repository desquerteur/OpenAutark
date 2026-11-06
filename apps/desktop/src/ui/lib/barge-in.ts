// Self barge-in on one device: while this device reads a reply aloud, is the person talking over it? Only
// asked when the microphone runs with the browser's echo cancellation (echoCancelled) – without it the
// device's own voice reaches the microphone and the echo guard ignores everything while it reads. Even with
// it some echo is left (speech synthesis may play outside the browser's audio path), so the detector learns
// the level the reading leaves on the microphone (its first WARM_MS, then the quiet blocks) and fires only
// for a voice clearly above it (RATIO × that level, at least MIN_LEVEL) held for HOLD_MS – a cough or a loud
// word of the reply does not cut it. The thresholds are a start that real devices still have to confirm.
// Owns: that decision on block levels (pure, Node-tested). Never: touches audio, timers or the speech output.

export interface BargeInOptions {
  /** A voice must be this many times the learned echo level. */
  ratio?: number;
  /** …and at least this RMS level. */
  minLevel?: number;
  /** …for this long without a quiet block. */
  holdMs?: number;
  /** The first part of every reading only teaches the echo level. */
  warmMs?: number;
}

export const BARGE_IN = { ratio: 3, minLevel: 0.06, holdMs: 350, warmMs: 600 } as const;
const LEARN = 0.1; // how fast the echo level follows quiet blocks

export class BargeInDetector {
  private readonly ratio: number;
  private readonly minLevel: number;
  private readonly holdMs: number;
  private readonly warmMs: number;
  private readingSince: number | null = null;
  private echo = 0;
  private loudSince: number | null = null;

  constructor(options: BargeInOptions = {}) {
    this.ratio = options.ratio ?? BARGE_IN.ratio;
    this.minLevel = options.minLevel ?? BARGE_IN.minLevel;
    this.holdMs = options.holdMs ?? BARGE_IN.holdMs;
    this.warmMs = options.warmMs ?? BARGE_IN.warmMs;
  }

  /** One block's level while the device reads aloud; true once the person clearly talks over it. */
  feed(level: number, now: number): boolean {
    if (!Number.isFinite(level) || level < 0) return false;
    if (this.readingSince === null) { this.readingSince = now; this.echo = level; this.loudSince = null; return false; }
    if (now - this.readingSince < this.warmMs) { this.echo = Math.max(this.echo, level); return false; }
    const floor = Math.max(this.minLevel, this.echo * this.ratio);
    if (level <= floor) {
      this.loudSince = null;
      this.echo += (level - this.echo) * LEARN;
      return false;
    }
    this.loudSince ??= now;
    if (now - this.loudSince < this.holdMs) return false;
    this.stop();
    return true;
  }

  /** The reading ended (or was cut): the next one learns its echo anew. */
  stop(): void {
    this.readingSince = null;
    this.loudSince = null;
    this.echo = 0;
  }
}

/** Does the microphone run with the browser's echo cancellation? (track settings; false when unknown) */
export function echoCancelled(stream: Pick<MediaStream, 'getAudioTracks'> | undefined): boolean {
  try {
    return Boolean(stream?.getAudioTracks?.().some((track) => track.getSettings?.().echoCancellation === true));
  } catch {
    return false;
  }
}
