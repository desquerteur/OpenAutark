// Window bounds persistence: <userData>/window-state.json {bounds, maximized, theme}.
// Owns: parsing (tolerant), clamping saved bounds onto the current displays (a monitor may be
// gone, the resolution may have changed) and the atomic write. `theme` is the last known
// appearance preference so the first frame has the right colors before the runtime answers.
// Never: touches Electron – window.ts passes display work areas in.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Rect { x: number; y: number; width: number; height: number }
export type ThemePreference = 'system' | 'light' | 'dark';

export interface WindowState {
  bounds?: Rect;
  maximized: boolean;
  theme?: ThemePreference;
}

export const MIN_WIDTH = 640;
export const MIN_HEIGHT = 480;
export const DEFAULT_WIDTH = 1180;
export const DEFAULT_HEIGHT = 800;
/** A saved window must keep at least this much of itself on a display, else it is re-centered. */
const MIN_VISIBLE = 120;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1_000_000;
}

function rect(value: unknown): Rect | undefined {
  const r = value as Partial<Rect> | null;
  if (!r || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height) || r.width <= 0 || r.height <= 0) return undefined;
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

/** Never throws: a corrupt file just means default bounds. */
export function parseWindowState(raw: unknown): WindowState {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const theme = value.theme === 'light' || value.theme === 'dark' || value.theme === 'system' ? value.theme : undefined;
  return { bounds: rect(value.bounds), maximized: value.maximized === true, ...(theme ? { theme } : {}) };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function fitSize(width: number, height: number, area: Rect): { width: number; height: number } {
  return {
    width: Math.min(Math.max(width, MIN_WIDTH), area.width),
    height: Math.min(Math.max(height, MIN_HEIGHT), area.height),
  };
}

function centered(area: Rect, width: number, height: number): Rect {
  const size = fitSize(width, height, area);
  return {
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + (area.height - size.height) / 2),
    ...size,
  };
}

/**
 * Places saved bounds on the display they overlap most (work areas, DIP). Too little visible →
 * centered on the primary display with the saved size; larger than the display → shrunk to it.
 */
export function clampBounds(saved: Rect | undefined, workAreas: readonly Rect[], primary: Rect): Rect {
  if (!saved) return centered(primary, DEFAULT_WIDTH, DEFAULT_HEIGHT);
  let best: Rect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const seen = overlap(saved, area);
    if (seen.width >= MIN_VISIBLE && seen.height >= Math.min(MIN_VISIBLE, saved.height) && seen.width * seen.height > bestArea) {
      best = area;
      bestArea = seen.width * seen.height;
    }
  }
  if (!best) return centered(primary, saved.width, saved.height);
  const size = fitSize(saved.width, saved.height, best);
  return {
    x: clamp(saved.x, best.x, best.x + best.width - size.width),
    y: clamp(saved.y, best.y, best.y + best.height - size.height),
    ...size,
  };
}

export async function loadWindowState(file: string): Promise<WindowState> {
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > 16_384) return parseWindowState(null);
    return parseWindowState(JSON.parse(text));
  } catch {
    return parseWindowState(null);
  }
}

const writes = new Map<string, Promise<void>>(); // one write per file at a time, in call order

/**
 * Atomic (temp + rename) and serialized per file, so a close-time save never races a debounced
 * one on the shared temp file. Failures are swallowed – bounds are a convenience, never critical.
 */
export function saveWindowState(file: string, state: WindowState): Promise<void> {
  const text = JSON.stringify(state);
  const next = (writes.get(file) ?? Promise.resolve()).then(async () => {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, file);
    } catch { /* disk full or read-only profile: keep running */ }
  });
  writes.set(file, next);
  void next.then(() => { if (writes.get(file) === next) writes.delete(file); });
  return next;
}
