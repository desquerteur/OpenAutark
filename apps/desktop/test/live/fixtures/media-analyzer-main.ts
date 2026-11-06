// LIVE fixture (MM4): the Electron main process of test/live/media-analyzer.test.ts, bundled by
// that test. Records a short video with MediaRecorder in a hidden window (six scenes of clearly
// different brightness – like the app's own screen recordings it has no duration in its header),
// stores it the way the blob store does, lets the real MediaAnalyzer (hidden sandboxed window,
// private session, the page served as wf-file://media-analyzer/…) take six keyframes, measures
// each frame's brightness, waits past the idle time and prints one RESULT line.
// Owns: the check's Electron side. Never: shows a window, uses the person's profile (userData is
// the test's temp folder), reaches the network.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, protocol, session } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';
import { MediaAnalyzer } from '../../../src/main/media-analyzer.ts';
import { electronAnalyzerWindows } from '../../../src/main/media-analyzer-window.ts';
import { PRIVILEGED_SCHEMES } from '../../../src/main/protocols/handlers.ts';
import { blobPath } from '../../../src/main/protocols/rules.ts';

const DIR = process.env.WF_LIVE_DIR ?? '';
const LEVELS = [40, 200, 90, 240, 140, 60]; // grey of each scene
const SCENE_MS = 800;
const IDLE_MS = 1500;

/** Runs in the generator page: records the scenes from a canvas, returns the WebM as base64. */
async function record(levels: number[], sceneMs: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  document.body.append(canvas);
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 1_500_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  const started = performance.now();
  const paint = (level: number) => {
    g.fillStyle = `rgb(${level},${level},${level})`;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = `rgb(${255 - level},${255 - level},${255 - level})`;
    g.fillRect(20 + (((performance.now() - started) / 4) % 560), 320, 20, 20); // keeps frames coming
  };
  paint(levels[0]);
  recorder.start(200);
  for (const level of levels) {
    const until = performance.now() + sceneMs;
    while (performance.now() < until) {
      paint(level);
      await new Promise((resolve) => setTimeout(resolve, 33));
    }
  }
  recorder.stop();
  await stopped;
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Runs in the generator page: the mean grey of each JPEG (base64). */
async function brightness(images: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const image of images) {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(image), (ch) => ch.charCodeAt(0))], { type: 'image/jpeg' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    g.drawImage(bitmap, 0, 0);
    const data = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let sum = 0;
    for (let p = 0; p < data.length; p += 4) sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    out.push(Math.round(sum / (data.length / 4)));
  }
  return out;
}

async function run(): Promise<Record<string, unknown>> {
  const generator = new BrowserWindow({
    show: false, width: 640, height: 360,
    webPreferences: { partition: 'wf-live-generator', offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await generator.loadURL('about:blank');
  const webm = Buffer.from(await generator.webContents.executeJavaScript(`(${record.toString()})(${JSON.stringify(LEVELS)}, ${SCENE_MS})`) as string, 'base64');
  const blobsDir = path.join(DIR, 'blobs');
  const fileId = createHash('sha256').update(webm).digest('hex');
  mkdirSync(path.dirname(blobPath(blobsDir, fileId)), { recursive: true });
  writeFileSync(blobPath(blobsDir, fileId), webm);

  const created: BrowserWindow[] = [];
  class Tracked extends BrowserWindow {
    constructor(options: BrowserWindowConstructorOptions) {
      super(options);
      created.push(this);
    }
  }
  const analyzer = new MediaAnalyzer({
    open: electronAnalyzerWindows({ BrowserWindow: Tracked, fromPartition: (partition, options) => session.fromPartition(partition, options) }),
    blobsDir, idleMs: IDLE_MS,
  });
  const started = Date.now();
  const result = await analyzer.analyze({ fileId, mime: 'video/webm', frames: 6 });
  const jobMs = Date.now() - started;
  const openAfterJob = analyzer.windowOpen && created.length === 1 && !created[0].isDestroyed();
  const levels = await generator.webContents.executeJavaScript(`(${brightness.toString()})(${JSON.stringify(result.frames.map((frame) => Buffer.from(frame.data).toString('base64')))})`) as number[];
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS + 1000)); // past the idle time
  const report = {
    bytes: webm.length, jobMs, levels: LEVELS, durationMs: result.durationMs, width: result.width, height: result.height,
    frames: result.frames.map((frame, i) => ({ atMs: frame.atMs, scene: frame.scene, width: frame.width, height: frame.height, bytes: frame.data.length, jpeg: frame.data[0] === 0xff && frame.data[1] === 0xd8, level: levels[i] })),
    openAfterJob, windowOpen: analyzer.windowOpen, analyzerWindows: created.length, destroyed: created.map((window) => window.isDestroyed()),
    windowsLeft: BrowserWindow.getAllWindows().filter((window) => window !== generator).length,
  };
  analyzer.dispose();
  generator.destroy();
  return report;
}

app.setPath('userData', path.join(DIR, 'profile'));
protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES);
app.on('window-all-closed', () => { /* the check decides when to quit */ });
app.whenReady().then(run).then(
  (report) => { process.stdout.write(`RESULT ${JSON.stringify(report)}\n`); app.exit(0); },
  (error: unknown) => { process.stdout.write(`RESULT ${JSON.stringify({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })}\n`); app.exit(1); },
);
