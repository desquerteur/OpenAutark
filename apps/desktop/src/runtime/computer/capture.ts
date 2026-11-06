// Screen images for computer use: from the Windows helper (GDI capture, downscaled JPEG, same
// physical coordinate space as UIA and SendInput – also on headless PCs) or from the host
// (Electron capture; PNGs are downscaled here without native image libraries).
// Owns: the Screenshot shape, both capture paths and the geometry they report.
// Never: decides when to capture (service.ts) or keeps images.

import type { Host } from '../host.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Rect, ShotGeometry } from './geometry.ts';
import type { HelperClient } from './helper.ts';
import { isPng, pngSize, shrinkPng } from './png.ts';

export interface Screenshot extends ShotGeometry {
  data: Uint8Array;
  mime: string;
  source: 'helper' | 'host';
  at: number;
  ocr?: Array<{ text: string; rect: [number, number, number, number] }>;
}

export interface HelperShotInput {
  display?: number;
  window?: number;
  region?: Rect;
  maxEdge: number;
  quality?: number;
  ocr?: boolean;
  signal?: AbortSignal;
}

/** Screenshot through the helper; `ocr` adds recognised text lines in screen coordinates. */
export async function helperShot(helper: HelperClient, input: HelperShotInput, at: number): Promise<Screenshot> {
  const target = { screen: input.display, hwnd: input.window, region: input.region };
  const quality = Math.min(95, Math.max(30, Math.round(input.quality ?? 70)));
  const result = await helper.call<{ data: string; mime?: string; width: number; height: number; x: number; y: number; srcWidth: number }>('screenshot', {
    ...target, maxEdge: input.maxEdge, quality, format: 'jpeg',
  }, { timeoutMs: 25_000, signal: input.signal });
  const shot: Screenshot = {
    data: new Uint8Array(Buffer.from(String(result.data ?? ''), 'base64')),
    mime: result.mime ?? 'image/jpeg',
    width: result.width,
    height: result.height,
    origin: { x: result.x ?? 0, y: result.y ?? 0 },
    scale: result.srcWidth && result.width ? result.srcWidth / result.width : 1,
    source: 'helper',
    at,
  };
  if (input.ocr) {
    const ocr = await helper.call<{ lines?: Array<{ text?: string; rect?: number[] }> }>('ocr', target, { timeoutMs: 40_000, signal: input.signal });
    shot.ocr = (ocr?.lines ?? [])
      .filter((line) => typeof line.text === 'string' && Array.isArray(line.rect) && line.rect.length === 4)
      .map((line) => ({ text: line.text!, rect: line.rect as [number, number, number, number] }));
  }
  return shot;
}

/**
 * Screenshot of a display through the host. PNG (default) is downscaled to `maxEdge` here;
 * 'jpeg' is passed through as the host encoded it (previews – cheap, full size).
 */
export async function hostShot(host: Host, display: number | undefined, maxEdge: number, at: number, format: 'png' | 'jpeg' = 'png'): Promise<Screenshot> {
  const capture = host.capture;
  if (!capture) throw new WorkforceError('unavailable', 'This PC has no screen to capture (headless runtime).');
  const raw = await capture.screenshot({ display: display ?? 0 }, format);
  const data = raw.data instanceof Uint8Array ? raw.data : new Uint8Array(raw.data);
  if (raw.mime === 'image/png' || isPng(data)) {
    const small = shrinkPng(data, maxEdge);
    const size = pngSize(small.data);
    return { data: small.data, mime: 'image/png', width: size?.width ?? raw.width, height: size?.height ?? raw.height, origin: { x: 0, y: 0 }, scale: small.scale, source: 'host', at };
  }
  return { data, mime: raw.mime, width: raw.width, height: raw.height, origin: { x: 0, y: 0 }, scale: 1, source: 'host', at };
}
