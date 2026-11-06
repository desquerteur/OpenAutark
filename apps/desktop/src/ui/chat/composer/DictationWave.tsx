// D13: the dictation's input level as a small scrolling waveform (the newest bar on the right),
// drawn on a canvas of fixed size in the composer's reserved slot (the action row's spacer, at its
// right edge next to the mic – absolutely placed, so nothing in the row moves when it appears).
// 'starting': a row of quiet dots that pulses (CSS) until the microphone is open; 'live': bars
// from lib/dictation.ts dictationLevels, repainted in requestAnimationFrame only while dictating
// and only when a new level arrived; 'idle': nothing.
// Owns: the drawing. Never: opens the microphone or computes levels (lib/dictation.ts does).

import { useEffect, useRef } from 'preact/hooks';
import { dictationLevels } from '../../lib/dictation.ts';

export type WaveState = 'idle' | 'starting' | 'live';

const WIDTH = 56;
const HEIGHT = 24;
const PITCH = 2; // px per bar (bar + gap)

function paint(canvas: HTMLCanvasElement, levels: number[] | null): void {
  const ratio = Math.max(1, Math.round(globalThis.devicePixelRatio || 1));
  if (canvas.width !== WIDTH * ratio) { canvas.width = WIDTH * ratio; canvas.height = HEIGHT * ratio; }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = getComputedStyle(canvas).color;
  const bars = Math.floor(WIDTH / PITCH);
  const shown = levels ? levels.slice(-bars) : [];
  for (let index = 0; index < bars; index++) {
    const level = levels ? (shown[index - (bars - shown.length)] ?? 0) : 0;
    const height = Math.max(levels ? 2 : 1.5, level * (HEIGHT - 2));
    context.fillRect(index * PITCH, (HEIGHT - height) / 2, PITCH * 0.6, height);
  }
}

export function DictationWave(props: { state: WaveState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { state } = props;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || state === 'idle') return;
    if (state === 'starting') { paint(canvas, null); return; }
    let seen = -1;
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (dictationLevels.version === seen) return;
      seen = dictationLevels.version;
      paint(canvas, dictationLevels.list());
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [state]);
  if (state === 'idle') return null;
  return <canvas ref={ref} class={`dictation-wave ${state}`} width={WIDTH} height={HEIGHT} aria-hidden="true" />;
}
