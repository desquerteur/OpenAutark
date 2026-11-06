// B-055 Q5: the tour player's pure rules (TourPlayer.tsx; tested in test/unit/ui/tour-player.test.ts):
// the time label, what a key does, a step back or forward, the time under a point of the scrubber, the
// scale that fits the fixed-size scene into its box and the next frame's time (a long gap – a hidden
// window, a busy PC – never jumps the tour ahead).
// Owns: these pure functions. Never: timers, DOM or the scene.

export const SCENE_ASPECT = 960 / 600;
/** One press of ← / → or the 5 s buttons. */
export const STEP_MS = 5000;
/** The longest step one animation frame advances the tour. */
export const MAX_FRAME_MS = 100;

export type KeyAction = 'toggle' | 'back' | 'forward' | 'start' | 'end';

/** "0:07". */
export function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What a key does in the player (Space only when no button has the focus – a button's own Space presses it). */
export function keyAction(key: string, onButton: boolean): KeyAction | null {
  if (key === ' ' || key === 'Spacebar') return onButton ? null : 'toggle';
  if (key === 'k' || key === 'K') return 'toggle';
  if (key === 'ArrowLeft') return 'back';
  if (key === 'ArrowRight') return 'forward';
  if (key === 'Home') return 'start';
  if (key === 'End') return 'end';
  return null;
}

export function clampTo(t: number, duration: number): number {
  return Math.min(duration, Math.max(0, Number.isFinite(t) ? t : 0));
}

/** The time after a key's step. */
export function stepTime(action: Exclude<KeyAction, 'toggle'>, t: number, duration: number): number {
  if (action === 'start') return 0;
  if (action === 'end') return duration;
  return clampTo(t + (action === 'back' ? -STEP_MS : STEP_MS), duration);
}

/** The time under `x` on a scrubber that starts at `left` and is `width` wide. */
export function timeAt(x: number, left: number, width: number, duration: number): number {
  if (!(width > 0)) return 0;
  return clampTo(((x - left) / width) * duration, duration);
}

/** The scale that fits the scene (960 × 600) into a box, never above `max`. */
export function fitScale(width: number, height: number, max = 1.6): number {
  if (!(width > 0) || !(height > 0)) return 0;
  return Math.min(max, width / 960, height / 600);
}

/** The time of the next frame: `elapsed` ms after the last, at most MAX_FRAME_MS, never past the end. */
export function nextTime(t: number, elapsed: number, duration: number): number {
  return clampTo(t + Math.min(MAX_FRAME_MS, Math.max(0, elapsed)), duration);
}
