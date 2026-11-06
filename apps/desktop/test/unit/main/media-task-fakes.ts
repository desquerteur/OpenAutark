// Fakes for the sound and image jobs of the media analyzer (B-058 T2), used by media-analyzer-fakes.ts
// pageEnv: a fake media file (a JSON head line, then filler bytes – a byte prefix decodes to its share
// of the length, like an MP3 or a WebM), an <audio> element that reads its length through the job's
// video route (a recording has none until its end is sought), an OfflineAudioContext whose decode
// yields a sine per channel at 16 kHz, createImageBitmap with crop and resize, an SVG <img>, and the
// canvas parts the image page draws with (transparency and PNG size follow the drawn source).
// Owns: fixtures only. Never: imported by production code.

import type { PageAudio, PageAudioBuffer } from '../../../src/main/media-analyzer-audio.ts';
import type { PageBitmap, PageImage } from '../../../src/main/media-analyzer-image.ts';

/** A fake recording: its length, channels (sine `freq` Hz at `amp`, channel c scaled by 1/(c+1)), total bytes; flags for a MediaRecorder file, a video without sound and an unreadable file. */
export interface Sound { kind: 'sound'; durationMs: number; size: number; channels?: number; freq?: number; amp?: number; recording?: boolean; noAudio?: boolean; unreadable?: boolean }

/** A fake image: its size; `alpha` = has transparent pixels, `photo` = large as PNG, `broken` = cannot be decoded. */
export interface Picture { kind: 'image'; width: number; height: number; alpha?: boolean; photo?: boolean; broken?: boolean }

export function soundFile(sound: Sound): Uint8Array<ArrayBuffer> {
  const head = new TextEncoder().encode(`${JSON.stringify(sound)}\n`);
  const bytes = new Uint8Array(Math.max(sound.size, head.length));
  bytes.set(head);
  return bytes;
}

export function pictureFile(picture: Picture): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify(picture)}\n`);
}

function headOf(bytes: Uint8Array): (Sound | Picture) | null {
  const end = bytes.indexOf(0x0a);
  try { return JSON.parse(new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end))) as Sound | Picture; } catch { return null; }
}

const later = (fn: () => void) => { setImmediate(fn); };

/** The mono value the page should post at sample `i` of a sound (the mean of its channels). */
export function monoAt(sound: Sound, i: number): number {
  const channels = sound.channels ?? 1;
  let sum = 0;
  for (let c = 0; c < channels; c++) sum += channelAt(sound, c, i);
  return sum / channels;
}

function channelAt(sound: Sound, channel: number, i: number): number {
  return ((sound.amp ?? 0.5) / (channel + 1)) * Math.sin((2 * Math.PI * (sound.freq ?? 440) * i) / 16_000);
}

export class FakeAudio implements PageAudio {
  muted = false;
  preload = '';
  duration = Number.NaN;
  released = false;
  private source = '';
  private time = 0;
  private sound: Sound | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly fetch: (input: string) => Promise<Response>;

  constructor(fetch: (input: string) => Promise<Response>) {
    this.fetch = fetch;
  }

  get src(): string { return this.source; }
  set src(value: string) {
    this.source = value;
    void this.fetch(value).then(async (response) => {
      const sound = headOf(new Uint8Array(await response.arrayBuffer()));
      if (!sound || sound.kind !== 'sound' || sound.unreadable) { this.emit('error'); return; }
      this.sound = sound;
      this.duration = sound.recording ? Number.POSITIVE_INFINITY : sound.durationMs / 1000;
      this.emit('loadedmetadata');
    }).catch(() => this.emit('error'));
  }

  get currentTime(): number { return this.time; }
  set currentTime(value: number) {
    later(() => {
      const sound = this.sound!;
      if (!Number.isFinite(this.duration)) { this.duration = sound.durationMs / 1000; this.emit('durationchange'); }
      this.time = Math.min(value, this.duration);
      this.emit('seeked');
    });
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener); }
  removeAttribute(name: string): void { if (name === 'src') this.source = ''; }
  load(): void { this.released = this.source === ''; }
  private emit(type: string): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(); }
}

/** OfflineAudioContext: decodes a fake sound (its share of the bytes given) at the context's rate. */
export class FakeAudioContext {
  static decoded: number[] = []; // bytes of every decode (tests: prefix reads)
  private readonly rate: number;
  constructor(_channels: number, _length: number, rate: number) {
    this.rate = rate;
  }
  async decodeAudioData(data: ArrayBuffer): Promise<PageAudioBuffer> {
    FakeAudioContext.decoded.push(data.byteLength);
    const sound = headOf(new Uint8Array(data));
    if (!sound || sound.kind !== 'sound' || sound.noAudio || sound.unreadable) throw new Error('EncodingError');
    const ms = sound.durationMs * Math.min(1, data.byteLength / sound.size);
    const length = Math.round((ms * this.rate) / 1000);
    const channels = Array.from({ length: sound.channels ?? 1 }, (_, c) => Float32Array.from({ length }, (_v, i) => channelAt(sound, c, i)));
    return { length, duration: length / this.rate, numberOfChannels: channels.length, getChannelData: (c: number) => channels[c] };
  }
}

export class FakeBitmap implements PageBitmap {
  closed = false;
  readonly width: number;
  readonly height: number;
  readonly picture: Picture;
  readonly crop?: number[];
  constructor(picture: Picture, width: number, height: number, crop?: number[]) {
    this.picture = picture;
    this.width = width;
    this.height = height;
    this.crop = crop;
  }
  close(): void { this.closed = true; }
}

/** createImageBitmap(blob) and createImageBitmap(bitmap, sx, sy, sw, sh, {resizeWidth, resizeHeight}); every bitmap is recorded. */
export function fakeCreateImageBitmap(made: FakeBitmap[]) {
  return async (image: unknown, ...crop: unknown[]): Promise<PageBitmap> => {
    let bitmap: FakeBitmap;
    if (image instanceof Blob) {
      const picture = headOf(new Uint8Array(await image.arrayBuffer()));
      if (!picture || picture.kind !== 'image' || picture.broken) throw new Error('InvalidStateError: The source image could not be decoded.');
      bitmap = new FakeBitmap(picture, picture.width, picture.height);
    } else {
      const source = image as FakeBitmap;
      const [sx, sy, sw, sh, options] = crop as [number, number, number, number, { resizeWidth: number; resizeHeight: number }];
      bitmap = new FakeBitmap(source.picture, options.resizeWidth, options.resizeHeight, [sx, sy, sw, sh]);
    }
    made.push(bitmap);
    return bitmap;
  };
}

/** An SVG <img>: its natural size from the fake file fetched through the job's route. */
export class FakeImg implements PageImage {
  src = '';
  naturalWidth = 0;
  naturalHeight = 0;
  picture: Picture | null = null;
  private readonly fetch: (input: string) => Promise<Response>;
  constructor(fetch: (input: string) => Promise<Response>) {
    this.fetch = fetch;
  }
  async decode(): Promise<void> {
    const picture = headOf(new Uint8Array(await (await this.fetch(this.src)).arrayBuffer()));
    if (!picture || picture.kind !== 'image' || picture.broken) throw new Error('EncodingError');
    this.picture = picture;
    this.naturalWidth = picture.width;
    this.naturalHeight = picture.height;
  }
}

/** A PNG of the size: signature, IHDR, then `extra` bytes. */
export function png(width: number, height: number, extra = 0): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(33 + extra);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

/** What the image page drew last on a canvas (its source's picture), for transparency and PNG size. */
export function pictureOf(image: unknown): Picture | undefined {
  if (image instanceof FakeBitmap) return image.picture;
  if (image instanceof FakeImg) return image.picture ?? undefined;
  return (image as { drawn?: Picture } | null)?.drawn;
}
