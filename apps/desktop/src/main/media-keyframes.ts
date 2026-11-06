// MM4: pure rules of the media analyzer (media-analyzer.ts): the checked request of the host op
// media.analyze, how many small signatures the page samples, which sampled moments become
// keyframes (the opening shot, then the biggest scene changes, then even coverage of the time)
// and the checks of what the page sends back (its samples, the size of a JPEG frame).
// Owns: these rules. Never: touches files, windows, timers or the network.

import { KEYFRAME_LIMITS } from '../shared/api/host-bridge.ts';
import { WorkforceError } from '../shared/errors.ts';
import { isBlobId } from './protocols/rules.ts';

export interface KeyframeRequest { fileId: string; mime?: string; frames: number }

/** One sampled moment: how much it differs from the sample before (0–1) and whether it is nearly black. */
export interface Sample { atMs: number; change: number; dark: boolean }

/** What the page measured: the video's duration and size and its samples in time order. */
export interface VideoFacts { durationMs: number; width: number; height: number; samples: Sample[] }

export interface Pick { atMs: number; scene: boolean }

/** A mean grey difference of the small signatures below this is the same scene. */
export const SCENE_CHANGE = 0.08;
export const MAX_SAMPLES = 48;
const MAX_DURATION_MS = 48 * 3_600_000;
const MAX_SIDE = 16_384;
const VIDEO_MIME = /^video\/[a-z0-9][a-z0-9.+-]{0,63}$/;

/** The host op's arguments, checked: a blob id, 1–12 frames (default 6), a video MIME type or none. */
export function keyframeRequest(args: { fileId?: unknown; mime?: unknown; frames?: unknown }): KeyframeRequest {
  if (typeof args.fileId !== 'string' || !isBlobId(args.fileId)) throw new WorkforceError('bad_request', 'Invalid file id.');
  const frames = args.frames === undefined ? KEYFRAME_LIMITS.defaultFrames : args.frames;
  if (typeof frames !== 'number' || !Number.isSafeInteger(frames) || frames < 1 || frames > KEYFRAME_LIMITS.frames) {
    throw new WorkforceError('bad_request', `Ask for 1 to ${KEYFRAME_LIMITS.frames} frames.`);
  }
  const mime = typeof args.mime === 'string' ? args.mime.split(';')[0].trim().toLowerCase() : '';
  return { fileId: args.fileId, frames, ...(VIDEO_MIME.test(mime) ? { mime } : {}) };
}

/** Signatures the page samples for `frames` keyframes: four per frame, 16 to 48. */
export function sampleCount(frames: number): number {
  return Math.min(MAX_SAMPLES, Math.max(16, frames * 4));
}

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** The page's measurements, checked (numbers in range, times rising inside the video), or null. */
export function checkFacts(value: unknown, maxSamples: number): VideoFacts | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const { durationMs, width, height } = v;
  if (!isInt(durationMs, 1, MAX_DURATION_MS) || !isInt(width, 1, MAX_SIDE) || !isInt(height, 1, MAX_SIDE)) return null;
  if (!Array.isArray(v.samples) || v.samples.length < 1 || v.samples.length > maxSamples) return null;
  const samples: Sample[] = [];
  for (const item of v.samples as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { atMs, change, dark } = item as Record<string, unknown>;
    if (!isInt(atMs, 0, durationMs) || typeof change !== 'number' || !(change >= 0 && change <= 1) || typeof dark !== 'boolean') return null;
    if (samples.length && atMs <= samples[samples.length - 1].atMs) return null;
    samples.push({ atMs, change, dark });
  }
  return { durationMs, width, height, samples };
}

/**
 * The moments to keep, in time order: the opening shot (the first sample that is not nearly
 * black, within the first quarter), then the biggest scene changes at least half a step apart,
 * then even coverage – every evenly spaced target from the first to the last sample without a
 * frame within half a step gets the nearest moment – so one long shot still gets frames across
 * its whole time; anything still missing is the moment farthest from those chosen. Nearly black
 * moments are taken only when nothing else is left.
 */
export function pickKeyframes(samples: readonly Sample[], count: number): Pick[] {
  if (!samples.length || count < 1) return [];
  const first = samples[0];
  const span = samples[samples.length - 1].atMs - first.atMs;
  const step = count > 1 ? span / (count - 1) : span;
  const blackness = (sample: Sample) => (sample.dark ? span + 1 : 0);
  const isChange = (sample: Sample) => sample !== first && sample.change >= SCENE_CHANGE && !sample.dark;
  const opening = samples.slice(0, Math.max(1, Math.ceil(samples.length / 4))).find((sample) => !sample.dark) ?? first;
  const chosen = new Map<Sample, boolean>([[opening, false]]);
  const distance = (atMs: number) => Math.min(...[...chosen.keys()].map((other) => Math.abs(other.atMs - atMs)));
  /** The unchosen sample with the lowest score, or undefined when all are chosen. */
  const best = (score: (sample: Sample) => number): Sample | undefined => {
    let found: Sample | undefined;
    let lowest = Infinity;
    for (const sample of samples) {
      if (chosen.has(sample)) continue;
      const value = score(sample);
      if (value < lowest) { found = sample; lowest = value; }
    }
    return found;
  };

  const changes = samples.filter(isChange).sort((a, b) => b.change - a.change || a.atMs - b.atMs);
  for (const sample of changes) {
    if (chosen.size >= count) break;
    if (!chosen.has(sample) && distance(sample.atMs) >= step / 2) chosen.set(sample, true);
  }
  for (let k = 1; k < count && chosen.size < count; k++) {
    const target = first.atMs + k * step;
    if (distance(target) <= step / 2) continue;
    const near = best((sample) => Math.abs(sample.atMs - target) + blackness(sample));
    if (near) chosen.set(near, isChange(near));
  }
  while (chosen.size < count) {
    const far = best((sample) => blackness(sample) - distance(sample.atMs));
    if (!far) break;
    chosen.set(far, isChange(far));
  }
  return [...chosen].map(([sample, scene]) => ({ atMs: sample.atMs, scene })).sort((a, b) => a.atMs - b.atMs);
}

/** Width and height from a JPEG's frame header (SOF), or null when the bytes are not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) return null; // end or scan data before any frame header
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[at + 5] << 8) | bytes[at + 6];
      const width = (bytes[at + 7] << 8) | bytes[at + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + length;
  }
  return null;
}
