// LIVE (opt-in, MM4): the real media analyzer in Electron. Bundles fixtures/media-analyzer-main.ts
// (minified like the app's main bundle, so the page served from its own source is checked as
// shipped) into a temp folder and starts Electron with it and a temp profile: a MediaRecorder video
// of six scenes is recorded in a hidden window, the analyzer takes six keyframes in its hidden
// sandboxed window, and after the idle time that window is destroyed. No visible window, no mouse
// or keyboard input, no network, nothing outside the temp folder.
//   WORKFORCE_LIVE=1 node --test test/live/media-analyzer.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');

interface Report {
  error?: string; bytes: number; jobMs: number; levels: number[]; durationMs: number; width: number; height: number;
  frames: Array<{ atMs: number; scene: boolean; width: number; height: number; bytes: number; jpeg: boolean; level: number }>;
  openAfterJob: boolean; windowOpen: boolean; analyzerWindows: number; destroyed: boolean[]; windowsLeft: number;
}

test('media analyzer: six keyframes of a recorded video, then its hidden window is destroyed', { skip: process.env.WORKFORCE_LIVE === '1' ? false : 'starts Electron: set WORKFORCE_LIVE=1', timeout: 180_000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-media-analyzer-'));
  const main = path.join(dir, 'main.cjs');
  await build({
    entryPoints: [path.join(here, 'fixtures', 'media-analyzer-main.ts')], outfile: main, bundle: true, minify: true,
    platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'warning',
  });
  const env: NodeJS.ProcessEnv = { ...process.env, WF_LIVE_DIR: dir, ELECTRON_ENABLE_LOGGING: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [main], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no result (exit ${code}): ${stderr.slice(-2000)}`);
  const report = JSON.parse(line.slice('RESULT '.length)) as Report;
  assert.equal(report.error, undefined, report.error);
  assert.equal(code, 0);
  t.diagnostic(`recorded ${report.bytes} bytes, ${report.durationMs} ms, ${report.width}×${report.height}; six frames in ${report.jobMs} ms: ${report.frames.map((frame) => `${frame.atMs} ms${frame.scene ? '*' : ''} grey ${frame.level} (${frame.bytes} B)`).join(', ')}`);

  // Six real JPEG frames of the video, in time order, within the video and ≤ 768 px.
  assert.equal(report.frames.length, 6);
  assert.ok(report.durationMs > 3000 && report.durationMs < 10_000, `duration ${report.durationMs} ms (measured by seeking to the end of a recording)`);
  assert.deepEqual([report.width, report.height], [640, 360]);
  for (const [i, frame] of report.frames.entries()) {
    assert.ok(frame.jpeg && frame.bytes > 100, `frame ${i + 1} is a JPEG`);
    assert.deepEqual([frame.width, frame.height], [640, 360], 'small videos are not scaled');
    assert.ok(frame.atMs >= 0 && frame.atMs <= report.durationMs, `frame ${i + 1} at ${frame.atMs} ms lies inside the video`);
    if (i) assert.ok(frame.atMs > report.frames[i - 1].atMs, 'in time order');
  }
  // Each frame shows one of the scenes (its brightness), and the scene changes were found.
  const scene = (level: number) => report.levels.findIndex((value) => Math.abs(value - level) <= 12);
  assert.ok(report.frames.every((frame) => scene(frame.level) >= 0), `every frame shows a scene: ${report.frames.map((frame) => frame.level).join(', ')}`);
  assert.ok(new Set(report.frames.map((frame) => scene(frame.level))).size >= 5, 'the frames cover the scenes, not one shot six times');
  assert.ok(report.frames.filter((frame) => frame.scene).length >= 4, 'scene changes are marked');
  assert.ok(report.jobMs < 30_000, 'within the job time');

  // The window stayed for a following job, then went after the idle time.
  assert.equal(report.analyzerWindows, 1);
  assert.equal(report.openAfterJob, true);
  assert.equal(report.windowOpen, false);
  assert.deepEqual(report.destroyed, [true], 'the hidden window is destroyed');
  assert.equal(report.windowsLeft, 0, 'no other window is left');
});
