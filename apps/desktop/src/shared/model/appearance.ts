// The person's look and layout, kept in settings.json › appearance (Settings › Appearance; the AI edits the same file).
// AF-010: where a chat's tabs (its area – browser, notes, media, files … – chat/ChatArea.tsx) sit beside its messages:
// docked right (the default, like a side panel), left, at the bottom or the top, or floating as a window of its own over
// the chat, with its width, height and the floating window's box. Every value is checked here once (forgiving reads
// for the UI, the same limits for settings.json's comments and checks – runtime/settings/schema.ts, validate.ts).
// Owns: the shapes, defaults, limits and the pure geometry. Never: reads or writes files, touches the DOM.

/** Where a chat's tabs sit. */
export type DockPlace = 'right' | 'left' | 'bottom' | 'top' | 'float';
export const DOCK_PLACES: readonly DockPlace[] = ['right', 'left', 'bottom', 'top', 'float'];

/** settings.json › appearance.chatDock. */
export interface ChatDock {
  place: DockPlace;
  /** Docked right or left: its width in px. */
  width: number;
  /** Docked at the top or bottom: its height in px. */
  height: number;
  /** Floating: its box in px from the chat body's top-left corner. */
  floatX: number;
  floatY: number;
  floatWidth: number;
  floatHeight: number;
}

/** The ranges settings.json allows (the window clamps further to the room there is). */
export const DOCK_LIMITS = {
  width: [260, 1600],
  height: [140, 1200],
  floatX: [0, 6000],
  floatY: [0, 6000],
  floatWidth: [280, 2400],
  floatHeight: [200, 1600],
} as const satisfies Record<Exclude<keyof ChatDock, 'place'>, readonly [number, number]>;

export const DEFAULT_CHAT_DOCK: ChatDock = {
  place: 'right', width: 480, height: 320, floatX: 48, floatY: 48, floatWidth: 520, floatHeight: 420,
};

/** The room the chat keeps beside a docked area (its messages and composer stay usable). */
export const CHAT_MIN = { width: 340, height: 240 } as const;

/** settings.json › appearance. */
export interface AppearanceSettings {
  chatDock: ChatDock;
}

const clampInt = (value: unknown, [min, max]: readonly [number, number], fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;

/** A forgiving read of appearance.chatDock (anything unusable takes its default; numbers are clamped into range). */
export function chatDockOf(value: unknown): ChatDock {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const place = DOCK_PLACES.includes(raw.place as DockPlace) ? raw.place as DockPlace : DEFAULT_CHAT_DOCK.place;
  const out = { place } as ChatDock;
  for (const key of Object.keys(DOCK_LIMITS) as Array<keyof typeof DOCK_LIMITS>) out[key] = clampInt(raw[key], DOCK_LIMITS[key], DEFAULT_CHAT_DOCK[key]);
  return out;
}

/** The problem with a written appearance.chatDock (path and what is expected), or undefined when it is fine. */
export function chatDockProblem(value: unknown): { path: string; expected: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { path: 'chatDock', expected: 'an object' };
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (key !== 'place' && !(key in DOCK_LIMITS)) return { path: `chatDock.${key}`, expected: 'a known key' };
  if (!DOCK_PLACES.includes(raw.place as DockPlace)) return { path: 'chatDock.place', expected: DOCK_PLACES.join(' | ') };
  for (const [key, [min, max]] of Object.entries(DOCK_LIMITS)) {
    const item = raw[key];
    if (typeof item !== 'number' || !Number.isInteger(item) || item < min || item > max) return { path: `chatDock.${key}`, expected: `a whole number from ${min} to ${max}` };
  }
  return undefined;
}

export interface Size { width: number; height: number }
export interface Box { x: number; y: number; width: number; height: number }

/** A docked area's width (right/left) in a chat body `room` px wide: the chat keeps CHAT_MIN.width, the area at least 240 px. */
export function dockWidth(width: number, room: number): number {
  return Math.round(Math.max(240, Math.min(width, room - CHAT_MIN.width)));
}

/** A docked area's height (top/bottom) in a chat column `room` px high: the messages and composer keep CHAT_MIN.height. */
export function dockHeight(height: number, room: number): number {
  return Math.round(Math.max(140, Math.min(height, room - CHAT_MIN.height)));
}

/** The floating window inside `room` (the chat body): never larger than it, and its top 36 px always reachable. */
export function fitFloat(dock: Pick<ChatDock, 'floatX' | 'floatY' | 'floatWidth' | 'floatHeight'>, room: Size): Box {
  const width = Math.round(Math.max(Math.min(DOCK_LIMITS.floatWidth[0], room.width), Math.min(dock.floatWidth, room.width)));
  const height = Math.round(Math.max(Math.min(DOCK_LIMITS.floatHeight[0], room.height), Math.min(dock.floatHeight, room.height)));
  const x = Math.round(Math.max(0, Math.min(dock.floatX, room.width - width)));
  const y = Math.round(Math.max(0, Math.min(dock.floatY, room.height - height)));
  return { x, y, width, height };
}

/**
 * Where a dragged area lands when let go at `point` over the chat body `rect` (both in window px): within the outer
 * quarter (at most 120 px) of an edge, that edge; anywhere else a floating window. Outside the rect: nothing (null).
 */
export function dockPlaceAt(point: { x: number; y: number }, rect: Box): DockPlace | null {
  const dx = point.x - rect.x;
  const dy = point.y - rect.y;
  if (dx < 0 || dy < 0 || dx > rect.width || dy > rect.height) return null;
  const bandX = Math.min(120, rect.width / 4);
  const bandY = Math.min(120, rect.height / 4);
  const near = [
    { place: 'left' as const, gap: dx, band: bandX },
    { place: 'right' as const, gap: rect.width - dx, band: bandX },
    { place: 'top' as const, gap: dy, band: bandY },
    { place: 'bottom' as const, gap: rect.height - dy, band: bandY },
  ].filter((edge) => edge.gap <= edge.band).sort((a, b) => a.gap / a.band - b.gap / b.band);
  return near[0]?.place ?? 'float';
}

/** The box the chat's tabs would take at `place` in a chat body of `room` (the drop guide's preview; `float`: the floating box). */
export function previewBox(place: DockPlace, dock: Pick<ChatDock, 'width' | 'height'>, room: Size, float: Box): Box {
  if (place === 'right' || place === 'left') {
    const width = dockWidth(dock.width, room.width);
    return { x: place === 'right' ? room.width - width : 0, y: 0, width, height: room.height };
  }
  if (place === 'top' || place === 'bottom') {
    const height = dockHeight(dock.height, room.height);
    return { x: 0, y: place === 'bottom' ? room.height - height : 0, width: room.width, height };
  }
  return float;
}

/** The words for a place (menus, the drop guide). */
export const DOCK_LABELS: Readonly<Record<DockPlace, string>> = {
  right: 'Dock right', left: 'Dock left', bottom: 'Dock at the bottom', top: 'Dock at the top', float: 'Float as a window',
};
