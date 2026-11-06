// MM4: what the media analyzer's private session answers (src/main/media-analyzer.ts) – only the
// running job's routes and verbs, the page with its strict CSP, the blob with ranges, the page's
// samples and frames checked (once each, also when posted at the same time, picked moments only,
// real JPEGs within 768 px, size limits) – and the Electron window/session options (media-analyzer-window.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { ANALYZER_CSP, ANALYZER_SCRIPT } from '../../../src/main/media-analyzer-page.ts';
import { ANALYZER_PARTITION, electronAnalyzerWindows } from '../../../src/main/media-analyzer-window.ts';
import type { ElectronAnalyzerDeps } from '../../../src/main/media-analyzer-window.ts';
import { analyzerSetup, jpeg, settle } from './media-analyzer-fakes.ts';

const BYTES = Uint8Array.from({ length: 100 }, (_, i) => i);
const FACTS = { durationMs: 4800, width: 1280, height: 720, samples: Array.from({ length: 16 }, (_, i) => ({ atMs: 150 + i * 300, change: i === 8 ? 0.5 : 0.01, dark: false })) };
const json = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });
const image = (bytes: Uint8Array<ArrayBuffer>): RequestInit => ({ method: 'POST', body: bytes, headers: { 'Content-Type': 'image/jpeg' } });

/** A hung job (the page never runs) whose routes the test calls itself. */
async function hungJob(s: ReturnType<typeof analyzerSetup>, id: string, mime?: string) {
  s.setMode('hang');
  const loads = s.windows.reduce((sum, window) => sum + window.loads.length, 0);
  const job = s.analyzer.analyze({ fileId: id, frames: 2, ...(mime ? { mime } : {}) });
  job.catch(() => undefined);
  await settle(() => s.windows.reduce((sum, window) => sum + window.loads.length, 0) === loads + 1);
  const n = /job\/(\d+)\//.exec(s.windows.at(-1)!.loads.at(-1)!)![1];
  const at = (route: string, init?: RequestInit) => s.analyzer.serve(new Request(`wf-file://media-analyzer/job/${n}/${route}`, init));
  return { job, at };
}

const failsWith = (promise: Promise<unknown>, message: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && message.test(error.message));

test('the page, its script and its spec; everything else, other jobs and other verbs are refused', async () => {
  const s = analyzerSetup();
  try {
    const { job, at } = await hungJob(s, s.put(BYTES), 'video/mp4');
    const page = await at('');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), ANALYZER_CSP);
    assert.match(page.headers.get('content-type')!, /^text\/html/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /<script src="\/analyze\.js"><\/script>/);
    assert.equal(await (await s.analyzer.serve(new Request('wf-file://media-analyzer/analyze.js'))).text(), ANALYZER_SCRIPT);
    assert.doesNotThrow(() => new Function(ANALYZER_SCRIPT), 'the served script is the page\'s own self-contained source');
    for (const rule of ["default-src 'none'", "script-src 'self'", "media-src 'self'", "img-src 'self'", "connect-src 'self'", "form-action 'none'"]) assert.ok(ANALYZER_CSP.includes(rule), rule);
    assert.ok(!/unsafe|data:|blob:|https?:|\*/.test(ANALYZER_CSP), 'nothing but its own origin');
    assert.deepEqual(await (await at('spec')).json(), { task: 'keyframes', edge: 768, quality: 0.82, grid: 24, waitMs: 1500, lookMs: 80, budgetMs: 4000, deadlineMs: 25_000, samples: 16 });

    const refused = async (url: string, init?: RequestInit) => (await s.analyzer.serve(new Request(url, init))).status;
    assert.equal(await refused('wf-file://app/job/1/spec'), 404, 'another host');
    assert.equal(await refused('https://media-analyzer/job/1/spec'), 404, 'another scheme');
    assert.equal(await refused('wf-file://media-analyzer/job/1/../../etc'), 404);
    assert.equal(await refused('wf-file://media-analyzer/job/2/spec'), 410, 'not the running job');
    assert.equal(await refused('wf-file://media-analyzer/analyze.js', { method: 'POST' }), 405);
    assert.equal((await at('spec', json({}))).status, 405);
    assert.equal((await at('samples')).status, 405);
    assert.equal((await at('video', { method: 'DELETE' })).status, 405);
    assert.equal((await at(`frame?at=${FACTS.samples[0].atMs}`, image(jpeg(10, 10)))).status, 409, 'no frame before the samples');

    s.analyzer.dispose();
    await failsWith(job, /closing/);
    assert.equal((await at('spec')).status, 410, 'a settled job answers nothing');
  } finally { s.temp.cleanup(); }
});

test('the video route streams the job\'s blob with ranges, HEAD and its type (sniffed without one)', async () => {
  const s = analyzerSetup();
  try {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...BYTES]);
    const { job, at } = await hungJob(s, s.put(webm));
    const full = await at('video');
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/webm');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-length'), String(webm.length));
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), webm);
    const part = await at('video', { headers: { range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 2-5/${webm.length}`);
    assert.deepEqual(new Uint8Array(await part.arrayBuffer()), webm.slice(2, 6));
    const head = await at('video', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    const beyond = await at('video', { headers: { range: 'bytes=999-' } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get('content-range'), `bytes */${webm.length}`);
    s.analyzer.dispose();
    await failsWith(job, /closing/);
  } finally { s.temp.cleanup(); }
});

test('samples once; frames only at picked moments, once each, real JPEGs within the edge', async () => {
  const s = analyzerSetup();
  try {
    const id = s.put(BYTES);
    const first = await hungJob(s, id, 'video/mp4');
    const picked = await (await first.at('samples', json(FACTS))).json() as { times: number[] };
    assert.deepEqual(picked.times, [150, 2550], 'the opening shot and the scene change');
    assert.equal((await first.at('samples', json(FACTS))).status, 409, 'samples are taken once');
    assert.equal((await first.at('frame?at=450', image(jpeg(768, 432)))).status, 409, 'not a picked moment');
    assert.equal((await first.at('frame?at=abc', image(jpeg(768, 432)))).status, 409);
    assert.equal((await first.at('frame?at=150', image(jpeg(768, 432)))).status, 204);
    assert.equal((await first.at('frame?at=150', image(jpeg(768, 432)))).status, 409, 'each moment once');
    assert.equal((await first.at('done', json({}))).status, 204);
    const result = await first.job;
    assert.deepEqual(result.frames.map((frame) => [frame.atMs, frame.scene, frame.width]), [[150, false, 768]], 'a done page returns what came');

    const big = await hungJob(s, id);
    await big.at('samples', json(FACTS));
    assert.equal((await big.at('frame?at=150', image(jpeg(1024, 576)))).status, 400);
    await failsWith(big.job, /could not be encoded/);

    const png = await hungJob(s, id);
    await png.at('samples', json(FACTS));
    assert.equal((await png.at('frame?at=150', image(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0])))).status, 400);
    await failsWith(png.job, /could not be encoded/);

    const huge = await hungJob(s, id);
    await huge.at('samples', json(FACTS));
    assert.equal((await huge.at('frame?at=150', image(new Uint8Array(2 * 1024 * 1024)))).status, 400, 'over 1.5 MB');
    await failsWith(huge.job, /could not be encoded/);

    const forged = await hungJob(s, id);
    assert.equal((await forged.at('samples', json({ ...FACTS, samples: [...FACTS.samples].reverse() }))).status, 400);
    await failsWith(forged.job, /could not be searched/);

    const empty = await hungJob(s, id);
    await empty.at('samples', json(FACTS));
    await empty.at('done', json({}));
    await failsWith(empty.job, /No frame could be taken/);

    const failed = await hungJob(s, id);
    assert.equal((await failed.at('fail', json({ reason: 'toString' }))).status, 204);
    await failsWith(failed.job, /format or codec is not supported/);
    const stage = await hungJob(s, id);
    await stage.at('fail', json({ reason: 'duration' }));
    await failsWith(stage.job, /length of this video could not be read/);
  } finally { s.temp.cleanup(); }
});

test('samples and frames posted at the same time pass once; a frame still arriving after done is dropped', async () => {
  const s = analyzerSetup();
  try {
    const { job, at } = await hungJob(s, s.put(BYTES), 'video/mp4');
    const sampled = await Promise.all(Array.from({ length: 5 }, () => at('samples', json(FACTS))));
    assert.deepEqual(sampled.map((response) => response.status).sort(), [200, 409, 409, 409, 409], 'samples are taken once');
    const posts = await Promise.all(Array.from({ length: 30 }, () => at('frame?at=2550', image(jpeg(768, 432)))));
    assert.deepEqual(posts.map((response) => response.status).sort(), [204, ...Array<number>(29).fill(409)], 'each moment once');

    let push!: ReadableStreamDefaultController<Uint8Array>;
    const slow = at('frame?at=150', { method: 'POST', body: new ReadableStream<Uint8Array>({ start: (controller) => { push = controller; } }), duplex: 'half' } as RequestInit);
    assert.equal((await at('frame?at=150', image(jpeg(768, 432)))).status, 409, 'the moment is taken while its body is read');
    assert.equal((await at('done', json({}))).status, 204);
    const result = await job;
    assert.deepEqual(result.frames.map((frame) => frame.atMs), [2550], 'one frame per moment, never more than picked');
    push.enqueue(jpeg(768, 432));
    push.close();
    assert.equal((await slow).status, 410, 'a frame arriving after done is dropped');
    assert.equal(result.frames.length, 1);
  } finally { s.temp.cleanup(); }
});

test('Electron: a hidden sandboxed offscreen window in a private session that reaches only the analyzer', async () => {
  const windows: Array<{ options: Record<string, unknown>; window: EventEmitter & { destroyed: boolean; loaded: string[] }; contents: EventEmitter & { muted: boolean; openHandler?: () => unknown } }> = [];
  class FakeWindow extends EventEmitter {
    destroyed = false;
    loaded: string[] = [];
    readonly webContents = Object.assign(new EventEmitter(), {
      muted: false,
      setAudioMuted(value: boolean) { this.muted = value; },
      setWindowOpenHandler(handler: () => unknown) { (this as { openHandler?: () => unknown }).openHandler = handler; },
    });
    constructor(options: Record<string, unknown>) {
      super();
      windows.push({ options, window: this, contents: this.webContents });
    }
    loadURL(url: string) { this.loaded.push(url); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const partitions: Array<[string, unknown]> = [];
  let protocolHandler: ((request: Request) => Promise<Response>) | undefined;
  let beforeRequest: ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) | undefined;
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const session = {
    setPermissionRequestHandler: (fn: (...args: unknown[]) => unknown) => { handlers.request = fn; },
    setPermissionCheckHandler: (fn: (...args: unknown[]) => unknown) => { handlers.check = fn; },
    setDevicePermissionHandler: (fn: (...args: unknown[]) => unknown) => { handlers.device = fn; },
    webRequest: { onBeforeRequest: (fn: typeof beforeRequest) => { beforeRequest = fn; } },
    protocol: { handle: (scheme: string, fn: typeof protocolHandler) => { assert.equal(scheme, 'wf-file'); protocolHandler = fn; } },
  };
  const open = electronAnalyzerWindows({
    BrowserWindow: FakeWindow, fromPartition: (partition: string, options: unknown) => { partitions.push([partition, options]); return session; },
  } as unknown as ElectronAnalyzerDeps);

  const served: string[] = [];
  const handle = open(async (request) => { served.push(request.url); return new Response('ok'); });
  const [{ options, window, contents }] = windows;
  assert.deepEqual(partitions, [[ANALYZER_PARTITION, { cache: false }]]);
  assert.ok(!ANALYZER_PARTITION.startsWith('persist:'), 'in memory only');
  assert.deepEqual([options.show, options.skipTaskbar, options.focusable, options.frame], [false, true, false, false]);
  const prefs = options.webPreferences as Record<string, unknown>;
  assert.equal(prefs.session, session);
  assert.deepEqual([prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration, prefs.offscreen, prefs.devTools, prefs.webviewTag, prefs.preload], [true, true, false, true, false, false, undefined]);
  assert.equal(contents.muted, true);
  assert.deepEqual(contents.openHandler?.(), { action: 'deny' });

  // Permissions and devices are refused; only the analyzer's origin is reachable.
  let granted: boolean | undefined;
  handlers.request(null, 'media', (value: boolean) => { granted = value; });
  assert.equal(granted, false);
  assert.equal(handlers.check(), false);
  assert.equal(handlers.device(), false);
  const cancel = (url: string) => { let out: boolean | undefined; beforeRequest!({ url }, (response) => { out = response.cancel; }); return out; };
  assert.equal(cancel('wf-file://media-analyzer/job/1/video'), false);
  for (const url of ['https://example.com/x.js', 'wf-file://' + 'ab'.repeat(32), 'app://app/index.html', 'wf-file://media-analyzer.evil/x']) assert.equal(cancel(url), true, url);
  await protocolHandler!(new Request('wf-file://media-analyzer/job/1/spec'));
  assert.deepEqual(served, ['wf-file://media-analyzer/job/1/spec']);

  // Navigation never moves the page; the renderer going away is reported once; destroy is final.
  const prevented: string[] = [];
  contents.emit('will-navigate', { preventDefault: () => prevented.push('navigate') });
  contents.emit('will-frame-navigate', { preventDefault: () => prevented.push('frame') });
  assert.deepEqual(prevented, ['navigate', 'frame']);
  await handle.load('wf-file://media-analyzer/job/1/');
  assert.deepEqual(window.loaded, ['wf-file://media-analyzer/job/1/']);
  let gone = 0;
  handle.onGone(() => { gone++; });
  contents.emit('render-process-gone');
  assert.equal(gone, 1);
  handle.destroy();
  assert.equal(window.destroyed, true);
  assert.equal(gone, 1, 'our own destroy is not reported as gone');

  // A second window shares the private session, set up once.
  open(async () => new Response(null, { status: 204 }));
  assert.equal(partitions.length, 1);
  assert.equal(windows.length, 2);
});
