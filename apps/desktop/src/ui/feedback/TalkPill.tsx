// B-055 Q4: while the feedback cell is held (talk), a slim pill right under it with a narrow live
// waveform – BARS bars of the dictation's input level (lib/dictation.ts dictationLevels), the newest
// on the right, like transcription apps; quiet pulsing dots until the microphone is open. Fixed in
// the viewport under the cell (portalled to <body>), so nothing in the page moves; repainted in
// requestAnimationFrame only while live and only when a new level arrived.
// Owns: the pill and its drawing. Never: opens the microphone or computes levels.

import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { dictationLevels } from '../lib/dictation.ts';

export const BARS = 12;
const PITCH = 4; // px per bar (bar + gap)
const BAR = 2;
const WIDTH = BARS * PITCH - (PITCH - BAR);
const HEIGHT = 18;

/** Bar heights (px) for the newest `BARS` levels, oldest first; idle bars keep a 2 px dot. */
export function barHeights(levels: readonly number[] | null, height = HEIGHT): number[] {
  const shown = levels ? levels.slice(-BARS) : [];
  return Array.from({ length: BARS }, (_, index) => {
    const level = shown[index - (BARS - shown.length)] ?? 0;
    return Math.max(2, Math.min(height, level * height));
  });
}

function paint(canvas: HTMLCanvasElement, levels: readonly number[] | null): void {
  const ratio = Math.max(1, Math.round(globalThis.devicePixelRatio || 1));
  if (canvas.width !== WIDTH * ratio) { canvas.width = WIDTH * ratio; canvas.height = HEIGHT * ratio; }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = getComputedStyle(canvas).color;
  barHeights(levels).forEach((bar, index) => {
    context.beginPath();
    context.roundRect(index * PITCH, (HEIGHT - bar) / 2, BAR, bar, BAR / 2);
    context.fill();
  });
}

export function TalkPill(props: { anchor: HTMLElement | null; live: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const { anchor, live } = props;

  useLayoutEffect(() => {
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const width = WIDTH + 24; // the pill's padding (feedback.css .feedback-talk)
    setPlace({ left: Math.max(8, Math.min(innerWidth - width - 8, box.left + box.width / 2 - width / 2)), top: box.bottom + 6 });
  }, [anchor]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (!live) { paint(element, null); return; }
    let seen = -1;
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (dictationLevels.version === seen) return;
      seen = dictationLevels.version;
      paint(element, dictationLevels.list());
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [live, place !== null]);

  return createPortal(
    <div class={`feedback-talk${live ? ' live' : ' starting'}`} role="status" aria-label={live ? 'Listening' : 'Starting dictation'}
      style={{ left: `${place?.left ?? -9999}px`, top: `${place?.top ?? -9999}px` }}>
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-hidden="true" />
    </div>,
    document.body,
  );
}
