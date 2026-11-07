// AF-015: who speaks in the call, from real levels (call-levels.ts): the ring around the agent's avatar grows with its
// playback (green) or, a little less, with the person's microphone (blue), the wave below scrolls one bar per frame step in the colour of who was heard (the agent, the person, or a
// quiet line). One requestAnimationFrame loop per open view reads the output meters, writes the CSS custom properties
// (--call-level, data-speaker) on the view's root and paints the wave – no re-render per frame. With
// prefers-reduced-motion the ring keeps its size (only its colour says who speaks) and the wave is a still meter that
// shows the current level, updated a few times a second.
// Owns: the frame loop and the drawing. Never: opens audio or decides the phase.

import { useEffect, useRef } from 'preact/hooks';
import { callLevels, pollOutputMeters, readLevels } from './call-levels.ts';
import { ringScale, speakerOf } from './call-model.ts';
import type { CallPhase, CallSpeaker } from './call-model.ts';

/** prefers-reduced-motion right now. */
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const BAR_MS = 70; // one bar per 70 ms
const STILL_MS = 250; // reduced motion: the meter's update rate

/**
 * Drives `root` (the view's element) with the levels: its --call-level / --call-ring and data-speaker, and the wave on
 * `canvas` when given. `phase` and `muted` are read through the refs so the loop never restarts.
 */
export function useCallLevels(root: { current: HTMLElement | null }, canvas: { current: HTMLCanvasElement | null }, phase: CallPhase, muted: boolean): void {
  const state = useRef({ phase, muted });
  state.current = { phase, muted };
  useEffect(() => {
    let frame = 0;
    let lastBar = 0;
    let lastSpeaker: CallSpeaker | undefined;
    const still = reducedMotion();
    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      pollOutputMeters();
      const levels = readLevels();
      const { phase: now, muted: off } = state.current;
      const speaker = speakerOf(levels, now, off);
      const level = speaker === 'agent' ? Math.max(levels.out, 0.25) : speaker === 'person' ? levels.mic : 0;
      if (time - lastBar < (still ? STILL_MS : BAR_MS)) return;
      lastBar = time;
      const element = root.current;
      if (element) {
        element.style.setProperty('--call-level', level.toFixed(3));
        element.style.setProperty('--call-ring', String(ringScale(speaker === 'agent' ? levels.out : speaker === 'person' ? levels.mic * 0.7 : 0, still)));
        if (speaker !== lastSpeaker) { element.dataset.speaker = speaker ?? 'none'; lastSpeaker = speaker; }
      }
      callLevels.wave.push({ level: speaker ? level : 0, speaker });
      if (canvas.current) paintWave(canvas.current, still);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);
}

/** The wave: bars oldest → newest (left → right), mirrored around the middle; reduced motion: one still meter. */
function paintWave(canvas: HTMLCanvasElement, still: boolean): void {
  const width = canvas.clientWidth || 240;
  const height = canvas.clientHeight || 40;
  const ratio = Math.max(1, Math.round(globalThis.devicePixelRatio || 1));
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) { canvas.width = width * ratio; canvas.height = height * ratio; }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const style = getComputedStyle(canvas);
  const colors: Record<string, string> = {
    agent: style.getPropertyValue('--call-agent').trim() || '#5ec28a',
    person: style.getPropertyValue('--call-person').trim() || '#8fb4ff',
    none: style.getPropertyValue('--call-quiet').trim() || '#ffffff40',
  };
  const bars = callLevels.wave.list();
  if (still) { // one meter of the newest level, no movement
    const newest = bars[bars.length - 1];
    const level = newest?.level ?? 0;
    context.fillStyle = colors.none;
    context.fillRect(0, height / 2 - 2, width, 4);
    context.fillStyle = colors[newest?.speaker ?? 'none'];
    context.fillRect(0, height / 2 - 2, Math.round(width * level), 4);
    return;
  }
  const pitch = width / callLevels.wave.size;
  const barWidth = Math.max(2, pitch * 0.55);
  const offset = callLevels.wave.size - bars.length;
  for (let index = 0; index < callLevels.wave.size; index++) {
    const bar = bars[index - offset];
    const level = bar?.level ?? 0;
    const tall = Math.max(3, level * (height - 4));
    context.fillStyle = colors[bar?.speaker ?? 'none'];
    const x = index * pitch + (pitch - barWidth) / 2;
    const y = (height - tall) / 2;
    context.beginPath();
    context.roundRect?.(x, y, barWidth, tall, barWidth / 2);
    if (!context.roundRect) context.rect(x, y, barWidth, tall);
    context.fill();
  }
}
