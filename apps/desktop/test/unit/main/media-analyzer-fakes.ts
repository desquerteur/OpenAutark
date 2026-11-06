// Fakes for the media analyzer tests (MM4): a fake browser for the real analyzer page (a <video>
// whose "file" is a JSON clip description fetched through the analyzer's own video route, canvases
// whose pixels are the clip's grey at the current time, JPEGs that carry that grey in a comment
// segment), a fake hidden window that runs the page (or hangs, crashes, fails to load), manual
// timers and a blob store in a temp dir. B-058 T2: the same fake browser runs sound and image jobs
// (media-task-fakes.ts: <audio>, OfflineAudioContext, createImageBitmap, an SVG <img>; the canvas
// here also draws bitmaps, reports their transparency and encodes PNGs).
// Owns: fixtures only. Never: imported by production code.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { audioPage } from '../../../src/main/media-analyzer-audio.ts';
import { imagePage } from '../../../src/main/media-analyzer-image.ts';
import { analyzerPage } from '../../../src/main/media-analyzer-page.ts';
import type { PageCanvas, PageEnv, PageVideo } from '../../../src/main/media-analyzer-page.ts';
import { MediaAnalyzer } from '../../../src/main/media-analyzer.ts';
import type { AnalyzerWindow, MediaAnalyzerDeps, Serve } from '../../../src/main/media-analyzer.ts';
import { blobPath } from '../../../src/main/protocols/rules.ts';
import { tempDir } from '../store/helpers.ts';
import { FakeAudio, FakeAudioContext, FakeImg, fakeCreateImageBitmap, pictureOf, png } from './media-task-fakes.ts';
import type { FakeBitmap, Picture } from './media-task-fakes.ts';

/** The page functions of the other tasks, as the served script passes them. */
export const TASKS = { audio: audioPage, image: imagePage } as const;

/**
 * A fake video file: its size, length, scenes as [fromMs, grey 0–255]; `recording` = no duration
 * until the end was read. Load model (MM4 fix): `lagMs` = after each seek the picture drawImage
 * reads stays the old one for that long (cycled per seek) and frame callbacks fire only when the
 * new picture is presented, with its media time; `frameCallbacks: false` = they never fire (a
 * window that presents nothing).
 */
export interface Clip { width: number; height: number; durationMs: number; scenes: Array<[number, number]>; recording?: boolean; lagMs?: number[]; frameCallbacks?: boolean }

/** A minimal JPEG: SOI, a comment segment, a baseline frame header of the size, EOI. */
export function jpeg(width: number, height: number, comment = ''): Uint8Array<ArrayBuffer> {
  const note = new TextEncoder().encode(comment);
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xfe, (note.length + 2) >> 8, (note.length + 2) & 0xff, ...note,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

/** The grey a fake frame was drawn with (its comment segment). */
export function greyOf(bytes: Uint8Array): number {
  return Number(/grey=(\d+)/.exec(new TextDecoder().decode(bytes))?.[1] ?? Number.NaN);
}

const later = (fn: () => void) => { setImmediate(fn); };

class FakeVideo implements PageVideo {
  muted = false;
  preload = '';
  duration = Number.NaN;
  seeking = false;
  videoWidth = 0;
  videoHeight = 0;
  released = false;
  private source = '';
  private time = 0;
  /** Media time of the presented picture (what drawImage reads); follows `time` at once without a lag model. */
  private shown = 0;
  private seeks = 0;
  private presentedSeq = 0;
  private waiting: Array<(now: number, meta: { mediaTime: number }) => void> = [];
  private clip: Clip | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly env: PageEnv;

  constructor(env: PageEnv) {
    this.env = env;
  }

  get src(): string { return this.source; }
  set src(value: string) {
    this.source = value;
    void this.env.fetch(value).then((response) => response.text()).then((text) => {
      const clip = JSON.parse(text) as Clip;
      this.clip = clip;
      this.videoWidth = clip.width;
      this.videoHeight = clip.height;
      this.duration = clip.recording ? Number.POSITIVE_INFINITY : clip.durationMs / 1000;
      this.emit('loadedmetadata');
    }).catch(() => this.emit('error'));
  }

  get currentTime(): number { return this.time; }
  set currentTime(value: number) {
    this.seeking = true;
    later(() => {
      const clip = this.clip!;
      if (!Number.isFinite(this.duration) && value > clip.durationMs / 1000) {
        this.duration = clip.durationMs / 1000;
        this.emit('durationchange');
      }
      this.time = Math.min(value, clip.durationMs / 1000);
      this.seeking = false;
      if (!clip.lagMs?.length) this.shown = this.time;
      this.emit('seeked');
      if (clip.lagMs?.length) {
        const at = this.time;
        const seq = ++this.seeks;
        setTimeout(() => this.present(at, seq), clip.lagMs[(seq - 1) % clip.lagMs.length]);
      }
    });
  }

  /** Load model: the picture at `at` is presented now; waiting frame callbacks learn its media time. */
  private present(at: number, seq: number): void {
    if (seq < this.presentedSeq) return; // a newer seek's picture is already there
    this.presentedSeq = seq;
    this.shown = at;
    if (this.clip?.frameCallbacks === false) return;
    const waiting = this.waiting;
    this.waiting = [];
    for (const callback of waiting) callback(Date.now(), { mediaTime: at });
  }

  /** The grey of the scene in the presented picture. */
  grey(): number {
    let grey = 0;
    for (const [fromMs, value] of this.clip?.scenes ?? []) if (fromMs <= this.shown * 1000) grey = value;
    return grey;
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener); }
  requestVideoFrameCallback(callback: (now: number, meta?: { mediaTime?: number }) => void): number {
    if (this.clip?.lagMs?.length) this.waiting.push(callback); // fires when the next picture is presented
    else later(() => callback(Date.now()));
    return 1;
  }
  removeAttribute(name: string): void { if (name === 'src') this.source = ''; }
  load(): void { this.released = this.source === ''; }
  private emit(type: string): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(); }
}

export class FakeCanvas implements PageCanvas {
  width = 300;
  height = 150;
  /** The image job's drawn source (a picture), else the video's grey. */
  drawn?: Picture;
  /** Each image drawn: the source and the numbers it was placed with. */
  readonly draws: Array<{ image: unknown; place: number[] }> = [];
  readonly encoded: Array<{ type: string; quality: number; size: number }> = [];
  private grey = 0;
  getContext() {
    return {
      imageSmoothingEnabled: false, imageSmoothingQuality: 'low', fillStyle: '#000000',
      fillRect: () => {},
      drawImage: (image: unknown, ...place: number[]) => {
        this.draws.push({ image, place });
        if (image instanceof FakeVideo) this.grey = image.grey();
        else this.drawn = pictureOf(image);
      },
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(this.drawn ? (this.drawn.alpha ? 0 : 255) : this.grey),
      }),
    };
  }
  toBlob(callback: (blob: Blob | null) => void, type = 'image/png', quality = 0.92): void {
    const bytes = type === 'image/png' ? png(this.width, this.height, this.drawn?.photo ? this.width * this.height * 4 : 100) : jpeg(this.width, this.height, `grey=${this.grey}`);
    this.encoded.push({ type, quality, size: bytes.length });
    later(() => callback(new Blob([bytes], { type })));
  }
}

export type FakePageEnv = PageEnv & { videos: FakeVideo[]; audios: FakeAudio[]; canvases: FakeCanvas[]; bitmaps: FakeBitmap[]; images: FakeImg[]; requests: Request[] };

/** A fake browser for the page at `url`: relative fetches go to the analyzer's routes (each request is recorded). */
export function pageEnv(serve: Serve, url: string): FakePageEnv {
  const videos: FakeVideo[] = [];
  const audios: FakeAudio[] = [];
  const canvases: FakeCanvas[] = [];
  const bitmaps: FakeBitmap[] = [];
  const images: FakeImg[] = [];
  const requests: Request[] = [];
  const fetch = (input: string, init?: RequestInit) => {
    const request = new Request(new URL(input, url), init);
    requests.push(request.clone());
    return serve(request);
  };
  const env: FakePageEnv = {
    videos, audios, canvases, bitmaps, images, requests,
    document: {
      createElement: ((tag: string) => {
        if (tag === 'video') { const video = new FakeVideo(env); videos.push(video); return video; }
        if (tag === 'audio') { const audio = new FakeAudio(fetch); audios.push(audio); return audio; }
        if (tag === 'img') { const image = new FakeImg(fetch); images.push(image); return image; }
        const canvas = new FakeCanvas();
        canvases.push(canvas);
        return canvas;
      }) as PageEnv['document']['createElement'],
      body: { append() {} },
    },
    fetch,
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  Object.assign(env, { OfflineAudioContext: FakeAudioContext, createImageBitmap: fakeCreateImageBitmap(bitmaps) });
  return env;
}

export type WindowMode = 'run' | 'hang' | 'crash' | 'refuse';

/** A fake hidden window: 'run' runs the real page in the fake browser. */
export class FakeWindow implements AnalyzerWindow {
  destroyed = false;
  readonly loads: string[] = [];
  readonly pages: FakePageEnv[] = [];
  private readonly gone = new Set<() => void>();
  private readonly serve: Serve;
  private readonly mode: () => WindowMode;

  constructor(serve: Serve, mode: () => WindowMode) {
    this.serve = serve;
    this.mode = mode;
  }

  async load(url: string): Promise<void> {
    this.loads.push(url);
    const mode = this.mode();
    if (mode === 'refuse') throw new Error('ERR_FAILED');
    if (mode === 'crash') later(() => this.crash());
    if (mode !== 'run') return;
    const env = pageEnv(this.serve, url);
    this.pages.push(env);
    void analyzerPage(env, TASKS);
  }

  onGone(listener: () => void): void { this.gone.add(listener); }
  crash(): void { for (const listener of [...this.gone]) listener(); }
  destroy(): void { this.destroyed = true; }
}

/** Manual timers: nothing fires until the test says so. */
export function manualTimers() {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  return {
    setTimer: (fn: () => void, ms: number) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    clearTimer: (handle: unknown) => { (handle as { live: boolean }).live = false; },
    /** Runs the live timers of `ms`; returns how many ran. */
    fire(ms: number): number {
      const due = timers.filter((timer) => timer.live && timer.ms === ms);
      for (const timer of due) { timer.live = false; timer.fn(); }
      return due.length;
    },
    live: (ms: number) => timers.filter((timer) => timer.live && timer.ms === ms).length,
  };
}

/** An analyzer on a temp blob store with fake windows and manual timers. */
export function analyzerSetup(options: Partial<MediaAnalyzerDeps> = {}) {
  const temp = tempDir('wf-analyzer-');
  const blobsDir = path.join(temp.dir, 'blobs');
  const timers = manualTimers();
  const windows: FakeWindow[] = [];
  let mode: WindowMode = 'run';
  const analyzer = new MediaAnalyzer({
    open: (serve) => { const window = new FakeWindow(serve, () => mode); windows.push(window); return window; },
    blobsDir, setTimer: timers.setTimer, clearTimer: timers.clearTimer, ...options,
  });
  /** Stores bytes (or a clip description) in the blob store; returns the blob id. */
  const put = (content: Clip | Uint8Array): string => {
    const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(JSON.stringify(content));
    const id = createHash('sha256').update(bytes).digest('hex');
    const file = blobPath(blobsDir, id);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return id;
  };
  return { analyzer, windows, timers, put, temp, setMode: (next: WindowMode) => { mode = next; } };
}

/** Lets queued callbacks, fetches and file reads run until `done` holds (or a few rounds without one). */
export async function settle(done?: () => boolean): Promise<void> {
  for (let i = 0; i < (done ? 5000 : 50); i++) {
    if (done?.()) return;
    await new Promise((resolve) => setTimeout(resolve, done ? 1 : 0));
  }
  if (done) throw new Error('settle: the condition never held');
}
