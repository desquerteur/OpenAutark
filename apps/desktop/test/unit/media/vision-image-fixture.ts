// Fixtures for the B-058 G10 tests (vision-image.test.ts, tools/media-view.test.ts): a real two-colour PNG and an SVG.
// Owns: fixtures only. Never: imported by production code.

import { encodePng } from '../../../src/runtime/computer/png.ts';

/** A real RGB PNG: the left half red, the right half blue. */
export function halves(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(x < width / 2 ? [255, 0, 0] : [0, 0, 255], (y * width + x) * 3);
  return encodePng({ width, height, channels: 3, pixels });
}

export const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>');
