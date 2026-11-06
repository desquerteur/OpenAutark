// MM4: the page of the media analyzer window, served by media-analyzer.ts in its private session
// as wf-file://media-analyzer/job/<n>/ (HTML) and /analyze.js (this module's analyzerPage, run
// once). The page asks for the job's spec, loads the job's video (same origin, so the canvas
// stays readable), samples small grey signatures across its time, posts them, then draws each
// moment main picked at ≤ edge px and posts it as JPEG; at the end it lets go of the video.
// Seeking under load (fix 23.10.2026): 'seeked' does not mean the new picture is drawable – under
// CPU load the decoder presents it later, and drawing earlier repeats the moment before (the live
// check found 4 instead of 6 scenes while tests ran in parallel). A frame callback is registered
// before each seek; the page waits for the picture to be presented (at most spec.waitMs, and once
// more while the picture is still exactly the last one). After a seek whose picture came too late,
// a callback counts only when its media time is nearer the new position than the old one. A window that presents nothing (no callback on the first seek) waits
// spec.lookMs or twice the seek's own time instead, and when the picture is then exactly the last
// one, once more – within spec.budgetMs per job, so a still video cannot run into the job timeout.
// Review fix 23.10.2026: any frame callback proves the window presents frames (a first picture
// later than waitMs no longer switches the job to the compare path for good), and once the job
// has run spec.deadlineMs (below the host's job timeout) no seek waits any more: the job ends
// with the pictures there are instead of timing out.
// B-058 (T2): the spec names the job's task; sound jobs (media-analyzer-audio.ts) and image jobs
// (media-analyzer-image.ts) run their own page function, served in the same script. The CSP gains
// img-src 'self' (an SVG is drawn from an <img> of the job's own route; an image runs no script).
// Owns: the page side of the job protocol, the served script and the page's CSP. Never: reaches
// anything but its own origin (the CSP and the session refuse it), sees which file it reads, keeps
// the video open after the job. analyzerPage must stay self-contained: it is served as its own source.

import { audioPage } from './media-analyzer-audio.ts';
import { imagePage } from './media-analyzer-image.ts';

/** The parts of a <video> element the page uses. */
export interface PageVideo {
  muted: boolean;
  preload: string;
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly seeking: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?(callback: (now: number, meta?: { mediaTime?: number }) => void): number;
  removeAttribute(name: string): void;
  load(): void;
}

/** The parts of a 2D canvas the page uses. */
export interface PageCanvas {
  width: number;
  height: number;
  getContext(kind: '2d', options?: { willReadFrequently?: boolean }): {
    drawImage(image: PageVideo, x: number, y: number, width: number, height: number): void;
    getImageData(x: number, y: number, width: number, height: number): { data: ArrayLike<number> };
  } | null;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

/** The browser objects the page uses (the window itself; tests pass fakes). */
export interface PageEnv {
  document: { createElement(tag: 'video'): PageVideo; createElement(tag: 'canvas'): PageCanvas; body: { append(node: PageVideo): void } };
  fetch(input: string, init?: RequestInit): Promise<Response>;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * What `spec` answers: signatures to sample, longest frame edge, JPEG quality, signature grid, and
 * the waits for a seek's picture (see the header): the longest wait for a presented frame, the
 * shortest look without frame callbacks, the job's budget for looking again and the time after
 * which the job stops waiting at all.
 */
export interface PageSpec { task: 'keyframes'; samples: number; edge: number; quality: number; grid: number; waitMs: number; lookMs: number; budgetMs: number; deadlineMs: number }

/** B-058: the page functions of the other tasks (served with this one; tests pass them too). */
export interface PageTasks {
  audio?(env: unknown, spec: unknown): Promise<void>;
  image?(env: unknown, spec: unknown): Promise<void>;
}

/** The job, start to end; every failure is posted as its stage ('decode', 'no-video', 'duration', 'seek', 'encode'). */
export async function analyzerPage(env: PageEnv = globalThis as unknown as PageEnv, tasks: PageTasks = {}): Promise<void> {
  const post = async (path: string, body: string | ArrayBuffer, type: string): Promise<Response> => {
    const response = await env.fetch(path, { method: 'POST', body, headers: { 'Content-Type': type } });
    if (!response.ok) throw new Error('refused');
    return response;
  };
  let asked: PageSpec | { task: 'audio' | 'image' };
  try {
    asked = await (await env.fetch('spec')).json() as PageSpec | { task: 'audio' | 'image' };
  } catch {
    await post('fail', JSON.stringify({ reason: 'decode' }), 'application/json').catch(() => undefined);
    return;
  }
  if (asked.task !== 'keyframes') {
    const run = asked.task === 'audio' ? tasks.audio : asked.task === 'image' ? tasks.image : undefined;
    if (run) return run(env, asked);
    await post('fail', JSON.stringify({ reason: 'decode' }), 'application/json').catch(() => undefined);
    return;
  }
  const spec = asked;
  const video = env.document.createElement('video');
  /** Resolves on the first of the video's next `events`; a media error rejects. */
  const next = (...events: string[]): Promise<void> => new Promise((resolve, reject) => {
    const settle = (error?: Error) => {
      for (const event of events) video.removeEventListener(event, ok);
      video.removeEventListener('error', bad);
      if (error) reject(error);
      else resolve();
    };
    const ok = () => settle();
    const bad = () => settle(new Error('decode'));
    for (const event of events) video.addEventListener(event, ok);
    video.addEventListener('error', bad);
  });
  const sleep = (ms: number) => new Promise<void>((resolve) => { env.setTimeout(resolve, ms); });
  const release = () => { video.removeAttribute('src'); video.load(); };
  let stage = 'decode';
  try {
    const grid = spec.grid;
    const small = env.document.createElement('canvas');
    small.width = grid;
    small.height = grid;
    const sketch = small.getContext('2d', { willReadFrequently: true });
    /** The small grey signature of the picture the video shows now. */
    const signature = (): Float32Array => {
      if (!sketch) throw new Error(stage);
      sketch.drawImage(video, 0, 0, grid, grid);
      const pixels = sketch.getImageData(0, 0, grid, grid).data;
      const grey = new Float32Array(grid * grid);
      for (let p = 0; p < grey.length; p++) grey[p] = 0.299 * pixels[p * 4] + 0.587 * pixels[p * 4 + 1] + 0.114 * pixels[p * 4 + 2];
      return grey;
    };
    const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((value, i) => value === b[i]);
    /** Frame callbacks: unknown until the first seek, then whether this window presents frames at all. */
    let callbacks: boolean | undefined = typeof video.requestVideoFrameCallback === 'function' ? undefined : false;
    /** The last seek ended before its picture was presented: its late picture may still arrive. */
    let behind = false;
    let budget = spec.budgetMs;
    const begun = Date.now();
    /** Past the job's deadline: no more waiting for pictures. */
    const late = () => Date.now() - begun > spec.deadlineMs;
    let last: Float32Array | null = null;
    /** Seeks to `seconds` and returns the signature of the picture there (see the header). */
    const seek = async (seconds: number): Promise<Float32Array> => {
      const before = video.currentTime;
      let presented = false;
      let wake = () => {};
      const watch = () => {
        video.requestVideoFrameCallback?.((_now, meta) => {
          callbacks = true; // this window presents frames, also when the first one came late
          const at = meta?.mediaTime;
          if (behind && typeof at === 'number' && Math.abs(at - seconds) > Math.abs(at - before)) { behind = false; watch(); return; }
          presented = true;
          wake();
        });
      };
      if (callbacks !== false) watch();
      const started = Date.now();
      const done = next('seeked');
      video.currentTime = seconds;
      await done;
      const seekMs = Date.now() - started;
      const waitFor = (ms: number) => new Promise<void>((resolve) => {
        const timer = env.setTimeout(resolve, ms);
        wake = () => { env.clearTimeout(timer); resolve(); };
      });
      if (callbacks !== false && !presented && !late()) await waitFor(spec.waitMs);
      if (callbacks && !presented && last && budget > 0 && !late() && same(signature(), last)) {
        const again = Math.min(budget, spec.waitMs); // still the last picture: one more wait for the new one
        budget -= again;
        await waitFor(again);
      }
      let picture: Float32Array;
      if (presented) {
        callbacks = true;
        behind = false;
        picture = signature();
      } else if (callbacks || late()) {
        behind = true; // presented later than waitMs (heavy load) or past the deadline: take what is there now
        picture = signature();
      } else {
        callbacks = false; // no callback on the first seek: until one comes, this window counts as presenting none
        behind = true; // its picture may still come and must not count for the next seek
        const look = Math.min(1000, Math.max(spec.lookMs, seekMs * 2));
        await sleep(look);
        picture = signature();
        if (last && same(picture, last) && budget > 0 && !late()) {
          const again = Math.min(budget, look * 2);
          budget -= again;
          await sleep(again);
          picture = signature();
        }
      }
      last = picture;
      return picture;
    };

    video.muted = true;
    video.preload = 'auto';
    env.document.body.append(video);
    const loaded = next('loadedmetadata');
    video.src = 'video';
    await loaded;
    if (!video.videoWidth || !video.videoHeight) { stage = 'no-video'; throw new Error(stage); }
    let duration = video.duration;
    if (!Number.isFinite(duration)) {
      stage = 'duration'; // a MediaRecorder recording has no duration until its end was read
      const found = next('durationchange', 'seeked');
      video.currentTime = 1e101;
      await found;
      if (video.seeking) await next('seeked'); // the length is known; let that seek end before the next
      duration = Number.isFinite(video.duration) ? video.duration : video.currentTime;
      behind = true; // that seek's picture was not waited for
    }
    if (!(duration > 0)) { stage = 'duration'; throw new Error(stage); }

    stage = 'seek';
    if (!sketch) throw new Error(stage);
    const count = Math.max(1, Math.min(spec.samples, Math.floor(duration * 30)));
    const samples: Array<{ atMs: number; change: number; dark: boolean }> = [];
    let previous: Float32Array | null = null;
    for (let i = 0; i < count; i++) {
      const seconds = (duration * (i + 0.5)) / count;
      const grey = await seek(seconds);
      let sum = 0;
      let diff = 0;
      for (let p = 0; p < grey.length; p++) {
        sum += grey[p];
        if (previous) diff += Math.abs(grey[p] - previous[p]);
      }
      samples.push({ atMs: Math.round(seconds * 1000), change: previous ? Math.min(1, diff / (grey.length * 255)) : 1, dark: sum / grey.length < 16 });
      previous = grey;
    }
    const facts = { durationMs: Math.max(1, Math.round(duration * 1000)), width: video.videoWidth, height: video.videoHeight, samples };
    const picked = await (await post('samples', JSON.stringify(facts), 'application/json')).json() as { times: number[] };

    const scale = Math.min(1, spec.edge / Math.max(video.videoWidth, video.videoHeight));
    const canvas = env.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const paint = canvas.getContext('2d');
    if (!paint) throw new Error(stage);
    for (const atMs of picked.times) {
      stage = 'seek';
      await seek(atMs / 1000);
      paint.drawImage(video, 0, 0, canvas.width, canvas.height);
      stage = 'encode';
      const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', spec.quality));
      if (!jpeg) throw new Error(stage);
      await post(`frame?at=${atMs}`, await jpeg.arrayBuffer(), 'image/jpeg');
    }
    release();
    await post('done', '{}', 'application/json');
  } catch {
    release();
    await post('fail', JSON.stringify({ reason: stage }), 'application/json').catch(() => undefined);
  }
}

/** The served script: analyzerPage's own source, called once with the window and the other tasks' own sources. */
export const ANALYZER_SCRIPT = `(${analyzerPage.toString()})(globalThis, { audio: ${audioPage.toString()}, image: ${imagePage.toString()} });\n`;

export const ANALYZER_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Media analyzer</title></head><body><script src="/analyze.js"></script></body></html>';

/** Only this origin's script, media, images and fetches; no styles, frames, forms or anything else. */
export const ANALYZER_CSP = [
  "default-src 'none'", "script-src 'self'", "media-src 'self'", "img-src 'self'", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
