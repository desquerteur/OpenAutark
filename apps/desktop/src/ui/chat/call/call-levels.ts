// AF-015: the real levels of a call – the person's microphone and the agent's playback – for the call view's ring and
// wave (CallWave.tsx). The microphone level comes from the capture's own sample blocks (conversation-audio.ts,
// realtime-call.ts report each block's RMS); the playback level from an AnalyserNode in front of every audio output a
// call plays through (outputMeter: realtime answers, the PC's local voice); the system voice (speechSynthesis) gives no
// audio to measure, so each spoken word boundary it reports is a pulse (speechPulse). Every level rises at once and falls
// slowly (LevelMeter), and a history of the last bars with who was heard keeps the wave.
// The chosen audio output (CallOverlay.tsx's output menu) is applied to every output registered here.
// Owns: the meters, the microphone gate, the analyser registry and the wave history. Never: opens audio, decides phases or draws.

import { meterLevel } from '../../lib/pcm.ts';
import type { CallSpeaker } from './call-model.ts';

/** A level that rises at once and falls by `decayPerSecond` – a meter, not a jumping value. */
export class LevelMeter {
  private level = 0;
  private at = 0;
  private readonly decay: number;

  constructor(decayPerSecond = 2.4) { this.decay = decayPerSecond; }

  /** A new reading (0..1) at `now` (ms). */
  feed(level: number, now: number): void {
    const current = this.read(now);
    this.level = Math.max(current, Math.max(0, Math.min(1, level)));
    this.at = now;
  }

  /** The level at `now`, fallen since the last reading. */
  read(now: number): number {
    const fallen = this.level - (Math.max(0, now - this.at) / 1000) * this.decay;
    return fallen > 0 ? fallen : 0;
  }

  reset(): void { this.level = 0; this.at = 0; }
}

/** One bar of the wave: its height and who it was. */
export interface WaveBar { level: number; speaker: CallSpeaker }

/** The wave's last `size` bars (oldest first). */
export class WaveHistory {
  readonly size: number;
  private bars: WaveBar[] = [];
  version = 0;

  constructor(size = 40) { this.size = size; }

  push(bar: WaveBar): void {
    this.bars.push({ level: Math.max(0, Math.min(1, bar.level)), speaker: bar.speaker });
    if (this.bars.length > this.size) this.bars.splice(0, this.bars.length - this.size);
    this.version += 1;
  }

  list(): WaveBar[] { return [...this.bars]; }

  clear(): void { this.bars = []; this.version += 1; }
}

/** The microphone and the playback of this device's call. */
export const callLevels = { mic: new LevelMeter(), out: new LevelMeter(1.8), wave: new WaveHistory(40) };

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A microphone block's RMS (the capture reports every block, 0 while muted). */
export function reportMicLevel(rmsLevel: number): void {
  callLevels.mic.feed(meterLevel(rmsLevel), clock());
}

/** A microphone level already on the meter's scale (0..1: the mock engine). */
export function reportMicMeter(level: number): void {
  callLevels.mic.feed(level, clock());
}

/** A playback level (0..1, already on the meter's scale). */
export function reportOutputLevel(level: number): void {
  callLevels.out.feed(level, clock());
}

/** The system voice said a word: a pulse on the playback meter (it gives no audio to measure). */
export function speechPulse(): void {
  callLevels.out.feed(0.72, clock());
}

/** Both levels now. */
export function readLevels(now = clock()): { mic: number; out: number } {
  return { mic: callLevels.mic.read(now), out: callLevels.out.read(now) };
}

/**
 * The call's microphone gate: muted by the person (call-session.ts), or quiet while a call signal plays (call-tones.ts).
 * Every capture of a call asks it per block – a gated block counts as silence and is never taken for the person.
 */
export const micGate = { muted: false, quietUntil: 0 };

/** The call's microphone takes nothing right now (muted, or a call signal plays). */
export function micBlocked(now = Date.now()): boolean {
  return micGate.muted || now < micGate.quietUntil;
}

export function resetLevels(): void {
  callLevels.mic.reset();
  callLevels.out.reset();
  callLevels.wave.clear();
}

// ------------------------------------------------------------------ playback analysers

interface Metered { context: AudioContext; analyser: AnalyserNode; data: Float32Array<ArrayBuffer> }
const meters = new Map<AudioContext, Metered>();
let sinkId = '';

/** The node a call's audio connects to on `context`: an analyser in front of its destination (made once per context). */
export function outputMeter(context: AudioContext): AudioNode {
  const known = meters.get(context);
  if (known) return known.analyser;
  try {
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(context.destination);
    meters.set(context, { context, analyser, data: new Float32Array(analyser.fftSize) });
    applySinkTo(context);
    return analyser;
  } catch {
    return context.destination; // a context that cannot measure still plays
  }
}

/** Reads every live analyser into the playback meter (the call view calls it once per frame); closed contexts go. */
export function pollOutputMeters(): void {
  let loudest = 0;
  for (const [context, meter] of meters) {
    if (context.state === 'closed') { meters.delete(context); continue; }
    meter.analyser.getFloatTimeDomainData(meter.data);
    let sum = 0;
    for (let index = 0; index < meter.data.length; index++) sum += meter.data[index] * meter.data[index];
    loudest = Math.max(loudest, Math.sqrt(sum / meter.data.length));
  }
  if (loudest > 0) reportOutputLevel(meterLevel(loudest));
}

/** The audio output chosen for calls ('' = the system default); applied to every metered output where the browser can. */
export function setCallSink(id: string): void {
  sinkId = id;
  for (const context of meters.keys()) applySinkTo(context);
}

export function callSink(): string { return sinkId; }

/** This browser can send an AudioContext to a chosen output (AudioContext.setSinkId). */
export function sinkSupported(): boolean {
  return typeof AudioContext !== 'undefined' && typeof (AudioContext.prototype as { setSinkId?: unknown }).setSinkId === 'function';
}

function applySinkTo(context: AudioContext): void {
  const set = (context as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
  if (typeof set !== 'function') return;
  void set.call(context, sinkId).catch(() => undefined); // a device that went away: the default keeps playing
}
