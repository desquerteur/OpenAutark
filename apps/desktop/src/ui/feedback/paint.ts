// B-055 Q4 "Paint over": what covers private parts of a feedback screenshot and which image a
// report carries. Marks are opaque black – a round pen (about PEN_PX on screen, whatever the shot's
// size) and filled boxes – so nothing under them can be read; an outline could not hide anything.
// Every report image is one flattened JPEG (EXPORT_QUALITY, longest side ≤ EXPORT_MAX_SIDE): a
// painted shot is sent ONLY as its flattened image (never the raw shot beside it), an unpainted
// one as the original re-encoded the same way.
// Owns: the mark model, drawing marks on a 2D context and the image choice. Never: touches the DOM,
// decodes images or uploads (paint-image.ts, PaintEditor.tsx and FeedbackPanel.tsx do).

export type PaintTool = 'pen' | 'box';
export type Point = [number, number];
/** In the export image's pixels. A pen line keeps the width it was drawn with. */
export type PaintMark =
  | { tool: 'pen'; width: number; points: Point[] }
  | { tool: 'box'; from: Point; to: Point };

/** The pen's width on screen in CSS px (converted to image px when a line starts). */
export const PEN_PX = 22;
/** Opaque black: the marks hide what lies under them. */
export const PAINT_COLOR = '#000000';
export const EXPORT_MAX_SIDE = 1600;
export const EXPORT_QUALITY = 0.85;
export const EXPORT_MIME = 'image/jpeg';
export const REPORT_IMAGE_NAME = 'screenshot.jpg';

/** The part of CanvasRenderingContext2D the marks use (a fake records the calls in tests). */
export interface PaintContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
}

/** The pen's width in image px for a canvas `imageWidth` px wide shown `shownWidth` CSS px wide. */
export function penWidth(imageWidth: number, shownWidth: number): number {
  return Math.max(2, (PEN_PX * imageWidth) / Math.max(1, shownWidth));
}

/** The rectangle between two corners, whatever the drag direction. */
export function boxOf(from: Point, to: Point): { x: number; y: number; width: number; height: number } {
  return { x: Math.min(from[0], to[0]), y: Math.min(from[1], to[1]), width: Math.abs(to[0] - from[0]), height: Math.abs(to[1] - from[1]) };
}

/** Draws `marks` in order (the image must already be on the context). */
export function drawMarks(context: PaintContext, marks: readonly PaintMark[]): void {
  context.fillStyle = PAINT_COLOR;
  context.strokeStyle = PAINT_COLOR;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const mark of marks) {
    if (mark.tool === 'box') {
      const box = boxOf(mark.from, mark.to);
      context.fillRect(box.x, box.y, Math.max(1, box.width), Math.max(1, box.height));
      continue;
    }
    const [first, ...rest] = mark.points;
    if (!first) continue;
    context.beginPath();
    if (!rest.length) { // a single tap leaves a round dot
      context.arc(first[0], first[1], mark.width / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.lineWidth = mark.width;
    context.moveTo(first[0], first[1]);
    for (const [x, y] of rest) context.lineTo(x, y);
    context.stroke();
  }
}

export interface ShotDraft {
  /** The captured window (data URL), null while none. */
  shot: string | null;
  /** Marks painted over `shot`. */
  marks: readonly PaintMark[];
  /** The flattened painted image (JPEG data URL) – set together with the marks. */
  painted: string | null;
  /** The "Screenshot" checkbox. */
  withShot: boolean;
}

/**
 * What the report's one image is made of: nothing, the painted (flattened) image as it is, or the
 * original to re-encode. 'unready': marks without their flattened image – the raw shot is never
 * sent instead (the sender stops and says so).
 */
export type ReportImage = null | { kind: 'painted'; image: string } | { kind: 'original'; image: string } | { kind: 'unready' };

export function reportImage(draft: ShotDraft): ReportImage {
  if (!draft.withShot || !draft.shot) return null;
  if (draft.painted) return { kind: 'painted', image: draft.painted };
  return draft.marks.length ? { kind: 'unready' } : { kind: 'original', image: draft.shot };
}

/** Said when a painted shot is not flattened yet (reportImage 'unready'). */
export const PAINT_UNREADY = 'The painted screenshot is not ready yet. Try again.';
