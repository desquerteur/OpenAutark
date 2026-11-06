// Minimal PNG reader/writer for downscaling screenshots without native image libraries
// (host captures on macOS/Linux, phone screencaps). Supports what screen captures produce:
// 8-bit RGB/RGBA, non-interlaced. Downscaling is an area average (box filter), which keeps
// small UI text legible better than nearest-neighbour.
// Owns: decode → downscale → encode. Never: other formats (callers fall back to the original).

import { deflateSync, inflateSync } from 'node:zlib';
import { fitWithin } from './geometry.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PIXELS = 40_000_000; // ~8K × 5K; larger images are refused (RAM)

export interface RawImage {
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Uint8Array; // row-major, `channels` bytes per pixel
}

export function isPng(data: Uint8Array): boolean {
  return data.length > 24 && SIGNATURE.every((byte, index) => data[index] === byte);
}

/** Width/height from the IHDR chunk without decoding (undefined when not a PNG). */
export function pngSize(data: Uint8Array): { width: number; height: number } | undefined {
  if (!isPng(data)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Decodes an 8-bit RGB/RGBA non-interlaced PNG; undefined for anything else. */
export function decodePng(data: Uint8Array): RawImage | undefined {
  if (!isPng(data)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 3;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= data.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) return undefined;
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const depth = data[offset + 16];
      const colour = data[offset + 17];
      const interlace = data[offset + 20];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) return undefined;
      channels = colour === 6 ? 4 : 3;
      if (!width || !height || width * height > MAX_PIXELS) return undefined;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !idat.length) return undefined;
  const stride = width * channels;
  let raw: Buffer;
  // Bounded: a corrupt or hostile stream cannot inflate beyond the size the header announces.
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: height * (stride + 1) + 1024 }); } catch { return undefined; }
  if (raw.length < height * (stride + 1)) return undefined;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const value = raw[src + i];
      const left = i >= channels ? pixels[dst + i - channels] : 0;
      const up = y > 0 ? pixels[prev + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[prev + i - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else if (filter !== 0) return undefined;
      pixels[dst + i] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Area-average downscale to exactly width × height; output is RGB (alpha composited on white). */
export function downscale(image: RawImage, width: number, height: number): RawImage {
  const out = new Uint8Array(width * height * 3);
  const sx = image.width / width;
  const sy = image.height / height;
  const ch = image.channels;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * sx)));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let index = (yy * image.width + x0) * ch;
        for (let xx = x0; xx < x1; xx++) {
          const alpha = ch === 4 ? image.pixels[index + 3] / 255 : 1;
          r += image.pixels[index] * alpha + 255 * (1 - alpha);
          g += image.pixels[index + 1] * alpha + 255 * (1 - alpha);
          b += image.pixels[index + 2] * alpha + 255 * (1 - alpha);
          n++;
          index += ch;
        }
      }
      const o = (y * width + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return { width, height, channels: 3, pixels: out };
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes RGB/RGBA pixels as PNG (filter "Sub" per row, zlib level 6). */
export function encodePng(image: RawImage): Uint8Array {
  const stride = image.width * image.channels;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) {
    const row = y * (stride + 1);
    raw[row] = 1; // Sub
    const src = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= image.channels ? image.pixels[src + i - image.channels] : 0;
      raw[row + 1 + i] = (image.pixels[src + i] - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = image.channels === 4 ? 6 : 2;
  return new Uint8Array(Buffer.concat([
    Buffer.from(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/**
 * Shrinks a PNG so its long edge is at most `maxEdge`. Returns the original bytes (scale 1)
 * when it is already small enough or not a supported PNG.
 */
export function shrinkPng(data: Uint8Array, maxEdge: number): { data: Uint8Array; width: number; height: number; scale: number; srcWidth: number; srcHeight: number } {
  const size = pngSize(data);
  if (!size) return { data, width: 0, height: 0, scale: 1, srcWidth: 0, srcHeight: 0 };
  const target = fitWithin(size.width, size.height, maxEdge);
  if (target.width === size.width && target.height === size.height) {
    return { data, width: size.width, height: size.height, scale: 1, srcWidth: size.width, srcHeight: size.height };
  }
  const image = decodePng(data);
  if (!image) return { data, width: size.width, height: size.height, scale: 1, srcWidth: size.width, srcHeight: size.height };
  const small = downscale(image, target.width, target.height);
  return { data: encodePng(small), width: small.width, height: small.height, scale: target.scale, srcWidth: size.width, srcHeight: size.height };
}
