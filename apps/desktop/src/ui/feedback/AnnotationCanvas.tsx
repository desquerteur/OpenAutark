// The feedback screenshot's paint canvas (B-055 Q4, reworked from the former outline annotation –
// an outline could not hide anything): the shot at its export size (paint.ts, ≤ 1600 px) and
// opaque black marks on top – Pen (round, about PEN_PX on screen) or Box (filled) –, drawn while
// the pointer moves and handed to the editor (PaintEditor.tsx) when it lifts. The canvas keeps the
// image's aspect ratio, so pointer positions map exactly onto image pixels.
// Owns: drawing one mark. Never: keeps the marks, flattens or uploads (PaintEditor and
// FeedbackPanel do).

import { useLayoutEffect, useRef } from 'preact/hooks';
import { boxOf, penWidth } from './paint.ts';
import type { PaintMark, PaintTool, Point } from './paint.ts';
import { exportSize, paintOnto } from './paint-image.ts';

const drawn = (mark: PaintMark): boolean => {
  if (mark.tool === 'pen') return true;
  const box = boxOf(mark.from, mark.to);
  return box.width > 0 && box.height > 0;
};

export function AnnotationCanvas(props: { image: HTMLImageElement; marks: readonly PaintMark[]; tool: PaintTool; onMark: (mark: PaintMark) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<PaintMark | null>(null);
  const size = exportSize(props.image);

  const redraw = (extra?: PaintMark | null) => {
    const element = canvas.current;
    if (element) paintOnto(element, props.image, extra ? [...props.marks, extra] : props.marks);
  };
  useLayoutEffect(() => { redraw(); }, [props.image, props.marks]);

  const point = (event: PointerEvent): Point => {
    const element = canvas.current!;
    const rect = element.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * element.width, ((event.clientY - rect.top) / rect.height) * element.height];
  };

  return (
    <canvas
      ref={canvas}
      class={`paint-canvas tool-${props.tool}`}
      width={size.width}
      height={size.height}
      aria-label="Screenshot – paint over anything private"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const element = event.currentTarget as HTMLCanvasElement;
        try { element.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
        const at = point(event);
        drawing.current = props.tool === 'pen'
          ? { tool: 'pen', width: penWidth(element.width, element.getBoundingClientRect().width), points: [at] }
          : { tool: 'box', from: at, to: at };
        redraw(drawing.current);
      }}
      onPointerMove={(event) => {
        const mark = drawing.current;
        if (!mark) return;
        if (mark.tool === 'pen') mark.points.push(point(event));
        else mark.to = point(event);
        redraw(mark);
      }}
      onPointerUp={() => {
        const mark = drawing.current;
        drawing.current = null;
        if (mark && drawn(mark)) props.onMark(mark);
        else redraw();
      }}
      onPointerCancel={() => { drawing.current = null; redraw(); }}
    />
  );
}
