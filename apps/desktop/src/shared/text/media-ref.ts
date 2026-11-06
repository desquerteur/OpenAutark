// Media references (23.10.2026): how a precise part of a stored file is written for people, agents
// and edit commands, and read back – a time code ("0:12.0", "1:02:03.4"), a span ("0:12.0–0:18.0")
// and a reference in the W3C Media Fragments form `media:<fileId>#t=12.000,18.000&xywh=percent:10,20,30,40`
// (seconds; region in percent of the picture). Edit flows ("use 0:12–0:18 of video X") resolve a
// person's words with parseSpan and hand tools exact numbers.
// Owns: these formats and their parsing. Never: imports outside src/shared or checks that a file
// or segment exists.

import type { MediaRegion } from '../model/media.ts';

const FILE_ID = /^[a-f0-9]{64}$/;
/** The longest span or position accepted anywhere (48 h, the media analyzer's limit). */
export const MAX_MEDIA_MS = 48 * 3_600_000;

/** "0:03.2", "12:00.0", "1:02:03.4" – tenths of a second. */
export function timecode(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const seconds = `${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
  const minutes = Math.floor(tenths / 600) % 60;
  const hours = Math.floor(tenths / 36_000);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** "0:12.0–0:18.0". */
export function spanText(startMs: number, endMs: number): string {
  return `${timecode(startMs)}–${timecode(endMs)}`;
}

/**
 * A position in ms from "12", "12.5", "12s", "0:12", "00:12.25", "1:02:03" or "1:02:03.5"; undefined
 * for anything else (negative, over MAX_MEDIA_MS, seconds or minutes ≥ 60 after a colon).
 */
export function parseTimecode(text: string): number | undefined {
  const value = text.trim().toLowerCase();
  const plain = /^(\d{1,6}(?:\.\d{1,3})?)\s*s?$/.exec(value);
  if (plain) return checked(Number(plain[1]) * 1000);
  const parts = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)$/.exec(value);
  if (!parts) return undefined;
  const [, hours, minutes, seconds] = parts;
  if (Number(seconds) >= 60 || (hours !== undefined && Number(minutes) >= 60)) return undefined;
  return checked(((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000);
}

function checked(ms: number): number | undefined {
  const rounded = Math.round(ms);
  return Number.isFinite(rounded) && rounded >= 0 && rounded <= MAX_MEDIA_MS ? rounded : undefined;
}

/** "0:12–0:18", "0:12 - 0:18", "12s to 18s", "0:12.5…0:18": start before end, else undefined. */
export function parseSpan(text: string): { startMs: number; endMs: number } | undefined {
  const match = /^\s*(\S+?)\s*(?:–|—|-|\.\.\.?|…|\bto\b|\bbis\b)\s*(\S+)\s*$/i.exec(text);
  if (!match) return undefined;
  const startMs = parseTimecode(match[1]);
  const endMs = parseTimecode(match[2]);
  return startMs !== undefined && endMs !== undefined && endMs > startMs ? { startMs, endMs } : undefined;
}

const percent = (fraction: number) => String(Math.round(fraction * 1000) / 10);
const seconds = (ms: number) => (ms / 1000).toFixed(3);

/** `media:<fileId>` with `#t=` (span, seconds) and/or `xywh=percent:` (region) when given. */
export function mediaRef(fileId: string, part: { startMs?: number; endMs?: number; region?: MediaRegion } = {}): string {
  const fragments: string[] = [];
  if (part.startMs !== undefined && part.endMs !== undefined) fragments.push(`t=${seconds(part.startMs)},${seconds(part.endMs)}`);
  const r = part.region;
  if (r) fragments.push(`xywh=percent:${[r.x, r.y, r.width, r.height].map(percent).join(',')}`);
  return `media:${fileId}${fragments.length ? `#${fragments.join('&')}` : ''}`;
}

/** A reference written by mediaRef (also with `t=12,18` or `xywh=percent:…` alone), or undefined. */
export function parseMediaRef(text: string): { fileId: string; startMs?: number; endMs?: number; region?: MediaRegion } | undefined {
  const match = /^media:([a-f0-9]{64})(?:#(.*))?$/.exec(text.trim());
  if (!match || !FILE_ID.test(match[1])) return undefined;
  const out: { fileId: string; startMs?: number; endMs?: number; region?: MediaRegion } = { fileId: match[1] };
  for (const fragment of (match[2] ?? '').split('&').filter(Boolean)) {
    const time = /^t=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(fragment);
    const box = /^xywh=percent:(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(fragment);
    if (time) {
      const startMs = checked(Number(time[1]) * 1000);
      const endMs = checked(Number(time[2]) * 1000);
      if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;
      Object.assign(out, { startMs, endMs });
    } else if (box) {
      const [x, y, width, height] = box.slice(1).map((value) => Number(value) / 100);
      if (!(width > 0 && height > 0 && x + width <= 1.0001 && y + height <= 1.0001)) return undefined;
      out.region = { x, y, width, height };
    } else {
      return undefined;
    }
  }
  return out;
}
