// B-055 Q5: the feedback tour's stage geometry. The scene (Scene.tsx) is drawn at one fixed size
// (960 × 600 scene units) and scaled to its box by the player, so every place the big cursor aims at
// is a constant here – the timeline (timeline.ts) plans its paths to these rects and the scene draws
// its elements at them, so the cursor always lands on what it clicks, whatever the window size.
// The scene is an example app (rail, sidebar, a chat) with the feedback cell where the real one sits:
// top right, right of the workspace cell, before the caption controls. The "screenshot" in the menu's
// thumbnail and in the paint-over editor is the same example app drawn smaller (shot coordinates =
// scene coordinates of the app without menu or cursor).
// Owns: sizes, rects, the shot mapping, the private lines, the pen and the cursor's targets.
// Never: timing (timeline.ts) or markup (Scene.tsx); nothing here reads the live app.

import type { Point } from '../../shared/model/pointer-motion.ts';

export interface Rect { x: number; y: number; w: number; h: number }

export const SCENE_W = 960;
export const SCENE_H = 600;
export const HEADER_H = 48;
export const RAIL_W = 52;
export const SIDEBAR_W = 210;
/** Where the main sheet starts (after the rail and the sidebar). */
export const SHEET_X = RAIL_W + SIDEBAR_W;
/** The caption controls (minimise, maximise, close) at the far right of the header row. */
export const CAPTION_W = 138;

/** The feedback cell: its own frame cell right before the caption controls. */
export const FEEDBACK_CELL: Rect = { x: SCENE_W - CAPTION_W - 12 - 32, y: 8, w: 32, h: 32 };
export const WORKSPACE_CELL: Rect = { x: FEEDBACK_CELL.x - 4 - 32, y: 8, w: 32, h: 32 };

/** The feedback menu under the cell, right-aligned with it (the live menu's build, ui/feedback: the field with
 *  the mic inside, the screenshot row – thumbnail | checkbox over one muted line –, the message slot and Send). */
export const MENU: Rect = { x: FEEDBACK_CELL.x + 32 - 340, y: HEADER_H + 4, w: 340, h: 240 };
/** The menu's parts, relative to MENU. */
export const MENU_PART = {
  text: { x: 12, y: 12, w: 316, h: 104 },
  mic: { x: 288, y: 76, w: 36, h: 36 },
  thumb: { x: 12, y: 128, w: 80, h: 52 },
  check: { x: 104, y: 130, w: 104, h: 20 },
  hint: { x: 104, y: 152, w: 224, h: 16 },
  status: { x: 12, y: 192, w: 240, h: 36 },
  send: { x: 264, y: 192, w: 64, h: 36 },
} as const satisfies Record<string, Rect>;

/** The slim waveform under the cell while it is held (a narrow pill, as the live one). */
export const WAVE: Rect = { x: FEEDBACK_CELL.x + 16 - 36, y: FEEDBACK_CELL.y + FEEDBACK_CELL.h + 6, w: 72, h: 30 };

/** The "Paint over" dialog over the whole scene: title row, the stage with the shot, the tool row (Pen | Box, Undo, Clear, Done). */
export const EDITOR: Rect = { x: 150, y: 45, w: 660, h: 510 };
/** The editor's parts, relative to EDITOR. */
export const EDITOR_PART = {
  close: { x: 610, y: 18, w: 28, h: 28 },
  stage: { x: 22, y: 60, w: 616, h: 380 },
  tools: { x: 22, y: 452, w: 108, h: 36 },
  pen: { x: 25, y: 456, w: 52, h: 28 },
  box: { x: 79, y: 456, w: 48, h: 28 },
  undo: { x: 138, y: 452, w: 64, h: 36 },
  clear: { x: 206, y: 452, w: 64, h: 36 },
  done: { x: 566, y: 452, w: 72, h: 36 },
} as const satisfies Record<string, Rect>;
/** Where the screenshot lies in the editor (fitted into the stage, centred) and how much smaller it is drawn. */
export const SHOT = { x: EDITOR.x + 26, y: EDITOR.y + 60, scale: 380 / SCENE_H } as const;
/** The menu's thumbnail scale (it covers its 80 × 52 box, left top). */
export const THUMB_SCALE = MENU_PART.thumb.h / SCENE_H;

/** The example chat's private lines in app (= shot) coordinates: the contact card's e-mail and phone. */
export const PRIVATE = {
  card: { x: 363, y: 186, w: 260, h: 73 },
  email: { x: 377, y: 213, w: 150, h: 19 },
  phone: { x: 377, y: 232, w: 104, h: 19 },
} as const satisfies Record<string, Rect>;
/** The pen's width in shot units (opaque, round ends). */
export const PEN = 24;
/** The painted stroke's corners in shot units: along the e-mail line, back along the phone line (one stroke). */
export const PAINT_WAYPOINTS: readonly Point[] = [
  { x: 371, y: 222 }, { x: 452, y: 223 }, { x: 532, y: 222 },
  { x: 488, y: 241 }, { x: 430, y: 242 }, { x: 371, y: 241 },
];

/** Where the cursor rests on the poster. */
export const CURSOR_START: Point = { x: 612, y: 440 };
/** The big cursor's height in scene units. */
export const CURSOR_SIZE = 52;

export const abs = (part: Rect, origin: Rect): Rect => ({ x: origin.x + part.x, y: origin.y + part.y, w: part.w, h: part.h });
export const center = (rect: Rect): Point => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
export const inside = (point: Point, rect: Rect, slack = 0): boolean =>
  point.x >= rect.x - slack && point.x <= rect.x + rect.w + slack && point.y >= rect.y - slack && point.y <= rect.y + rect.h + slack;

export const shotToScene = (point: Point): Point => ({ x: SHOT.x + point.x * SHOT.scale, y: SHOT.y + point.y * SHOT.scale });
export const sceneToShot = (point: Point): Point => ({ x: (point.x - SHOT.x) / SHOT.scale, y: (point.y - SHOT.y) / SHOT.scale });

export type TargetId = 'feedback' | 'workspace' | 'mic' | 'check' | 'thumb' | 'send' | 'pen' | 'done';

/** What the cursor's tip is over (its hover look in the scene), given what is open. */
export function targetAt(point: Point, open: { menu: boolean; editor: boolean }): TargetId | null {
  if (open.editor) {
    for (const id of ['done', 'pen'] as const) if (inside(point, abs(EDITOR_PART[id], EDITOR))) return id;
    return null;
  }
  if (inside(point, FEEDBACK_CELL)) return 'feedback';
  if (inside(point, WORKSPACE_CELL)) return 'workspace';
  if (!open.menu) return null;
  for (const id of ['mic', 'check', 'thumb', 'send'] as const) if (inside(point, abs(MENU_PART[id], MENU))) return id;
  return null;
}
