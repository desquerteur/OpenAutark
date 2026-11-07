// AF-015: the call's start and end signals, made here with Web Audio (no sound file, nothing fetched): a soft rising
// chime when a call starts (played inside the tap – a phone allows audio only then) and a falling one when it ends.
// The microphone ignores what it hears while a tone plays (call-levels.ts micGate), so a tone is never taken for the
// person.
// Owns: the tone plans and their playback. Never: decides when a call starts or ends.

import { micGate, outputMeter } from './call-levels.ts';

/** One note of a tone: frequency (Hz), start and length (s) from the tone's start. */
export interface ToneNote { freq: number; at: number; length: number }

/** Loudness of the tones (gain 0..1): clearly heard, never loud. */
export const TONE_GAIN = 0.14;

/** The notes of each signal: start = rising C–E–G, end = falling E–A (shorter). */
export function tonePlan(kind: 'start' | 'end'): ToneNote[] {
  return kind === 'start'
    ? [{ freq: 523.25, at: 0, length: 0.16 }, { freq: 659.25, at: 0.14, length: 0.16 }, { freq: 783.99, at: 0.28, length: 0.32 }]
    : [{ freq: 659.25, at: 0, length: 0.18 }, { freq: 440, at: 0.16, length: 0.34 }];
}

/** How long a plan sounds (s). */
export function toneLength(notes: readonly ToneNote[]): number {
  return notes.reduce((end, note) => Math.max(end, note.at + note.length), 0);
}

let context: AudioContext | null = null;

/** Plays a signal; silent where the page cannot play audio. */
export function playTone(kind: 'start' | 'end'): void {
  const notes = tonePlan(kind);
  try {
    context ??= new AudioContext();
    void context.resume().catch(() => undefined);
    const out = outputMeter(context);
    const start = context.currentTime + 0.02;
    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.freq;
      const from = start + note.at;
      gain.gain.setValueAtTime(0, from);
      gain.gain.linearRampToValueAtTime(TONE_GAIN, from + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, from + note.length);
      oscillator.connect(gain);
      gain.connect(out);
      oscillator.start(from);
      oscillator.stop(from + note.length + 0.02);
    }
    micGate.quietUntil = Date.now() + Math.round(toneLength(notes) * 1000) + 250; // the tone and its tail are never the person
  } catch { /* no audio output here: the call goes on without its signal */ }
}
