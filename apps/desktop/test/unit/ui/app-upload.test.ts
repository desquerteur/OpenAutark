// Host side of wf.upload (X03, ui/blocks/app-upload.ts) with fake upload/register calls and Node
// Blobs: a to-do app's take is stored once and registered for its block, every refusal comes
// before a single byte is stored (not a to-do, not a Blob, too large, a type that is not allowed,
// the 11th file, 300 MB, a second upload while one is on its way), a register failure reaches the
// app as its text, refused files count against the block (three refusals, or the runtime's totals,
// and nothing more is stored), a registration the lost connection cut off is sent once more. Also
// the bridge side: wf_upload is an action, a Blob counts as '{}' for the 64 KiB JSON cap, the
// Activity list has words for it and the file's size; and app-tools.ts wires wf_upload to
// uploadBlob and blocks.file behind can() (rpc.call and the session are stubbed).
// Owns: these assertions only. Never: a runtime, the DOM or real files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_BRIDGE_LIMITS, APP_METHODS, APP_TOOLS } from '../../../src/shared/blocks/app-bridge.ts';
import type { ParamsOf, ResultOf, SessionInfo } from '../../../src/shared/api/methods.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { CallRing, activityLabel, logCall } from '../../../src/ui/blocks/app-calls.ts';
import { frameBytes, isAction, parseFrame } from '../../../src/ui/blocks/app-host.ts';
import { callHostTool } from '../../../src/ui/blocks/app-tools.ts';
import { REFUSED_TEXT, appUpload, resetAppUploads, type AppUploadDeps } from '../../../src/ui/blocks/app-upload.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';

const MB = 1024 * 1024;
const TODO_APP = { messageId: 'msg_app0000001', index: 2, todo: true };

/** A Blob that reports a size without holding the bytes (for the limits). */
class SizedBlob extends Blob {
  readonly fakeSize: number;
  constructor(size: number, type: string) { super(['x'], { type }); this.fakeSize = size; }
  override get size(): number { return this.fakeSize; }
}

/** Fake deps: every stored blob gets an id; register counts like the runtime does. */
function fakes(options: { register?: (params: ParamsOf<'blocks.file'>) => Promise<ResultOf<'blocks.file'>>; upload?: () => Promise<void> } = {}) {
  const uploads: Array<{ type: string; size: number; name: string }> = [];
  const registered: Array<ParamsOf<'blocks.file'>> = [];
  const refs = new Map<string, FileRef>();
  let bytes = 0;
  const deps: AppUploadDeps = {
    async upload(blob, name) {
      uploads.push({ type: blob.type, size: blob.size, name });
      await options.upload?.();
      const ref: FileRef = { id: String(uploads.length).padStart(64, '0'), name, mime: blob.type, size: blob.size, createdAt: 0 };
      refs.set(ref.id, ref);
      return ref;
    },
    async register(params) {
      registered.push(params);
      if (options.register) return options.register(params);
      const file = refs.get(params.fileId)!;
      bytes += file.size;
      return { file, count: registered.length, bytes };
    },
  };
  return { deps, uploads, registered };
}

const errorText = (result: Record<string, unknown>): string | undefined =>
  result.isError ? (result.content as Array<{ text: string }>)[0].text : undefined;

test('a to-do app\'s take.wav is stored once, registered for its block, and the app gets its file facts', async () => {
  resetAppUploads();
  const { deps, uploads, registered } = fakes();
  const take = new Blob([new Uint8Array(3_244)], { type: 'audio/wav' });
  const result = await appUpload(TODO_APP, { data: take, name: 'take.wav' }, deps);
  assert.equal(errorText(result), undefined);
  assert.deepEqual(uploads, [{ type: 'audio/wav', size: 3_244, name: 'take.wav' }]);
  assert.deepEqual(registered, [{ messageId: TODO_APP.messageId, blockIndex: 2, fileId: '1'.padStart(64, '0') }]);
  assert.deepEqual(result.structuredContent, { fileId: '1'.padStart(64, '0'), name: 'take.wav', mime: 'audio/wav', size: 3_244 });
});

test('types and names are normalized before storing: codecs dropped, the extension fixed, the path cut', async () => {
  resetAppUploads();
  const { deps, uploads } = fakes();
  await appUpload(TODO_APP, { data: new Blob(['x'], { type: 'audio/webm;codecs=opus' }) }, deps);
  await appUpload(TODO_APP, { data: new Blob(['notes'], { type: 'text/plain' }), name: '../../evil.bat' }, deps);
  await appUpload(TODO_APP, { data: new Blob(['RIFF']), name: 'take.wav' }, deps); // bytes without a type (wf.upload(bytes, name))
  assert.deepEqual(uploads.map((item) => [item.type, item.name]), [['audio/webm', 'file.webm'], ['text/plain', 'evil.txt'], ['audio/wav', 'take.wav']]);
});

test('every refusal comes before a single byte is stored', async () => {
  resetAppUploads();
  const { deps, uploads, registered } = fakes();
  const cases: Array<[Parameters<typeof appUpload>[0], Record<string, unknown>, string]> = [
    [{ ...TODO_APP, todo: false }, { data: new Blob(['x'], { type: 'audio/wav' }) }, 'This app is not a to-do.'],
    [TODO_APP, { data: 'UklGRg==' }, 'wf.upload needs a Blob or bytes.'],
    [TODO_APP, { data: new Uint8Array(4).buffer }, 'wf.upload needs a Blob or bytes.'],
    [TODO_APP, {}, 'wf.upload needs a Blob or bytes.'],
    [TODO_APP, { data: new Blob([], { type: 'audio/wav' }) }, 'The file is empty.'],
    [TODO_APP, { data: new SizedBlob(100 * MB + 1, 'video/mp4'), name: 'take.mp4' }, 'Files from a mini-app can be at most 100 MB.'],
    [TODO_APP, { data: new Blob(['<script>'], { type: 'text/html' }), name: 'page.html' }, 'Mini-apps can hand back audio, video, images, PDFs and text files.'],
    [TODO_APP, { data: new Blob(['<svg/>'], { type: 'image/svg+xml' }), name: 'logo.svg' }, 'Mini-apps can hand back audio, video, images, PDFs and text files.'],
    [TODO_APP, { data: new Blob(['x'], { type: 'application/octet-stream' }), name: 'take.wav' }, 'Mini-apps can hand back audio, video, images, PDFs and text files.'],
    [TODO_APP, { data: new Blob(['x']), name: 'take' }, 'Mini-apps can hand back audio, video, images, PDFs and text files.'],
  ];
  for (const [block, args, text] of cases) assert.equal(errorText(await appUpload(block, args, deps)), text, text);
  assert.equal(uploads.length, 0, 'nothing was stored');
  assert.equal(registered.length, 0);
});

test('the 11th file of a block and more than 300 MB are refused before storing; other blocks have their own count', async () => {
  resetAppUploads();
  const { deps, uploads } = fakes();
  for (let i = 0; i < 10; i++) assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob([`take ${i}`], { type: 'audio/wav' }) }, deps)), undefined);
  assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob(['take 11'], { type: 'audio/wav' }) }, deps)), 'This mini-app already stored 10 files.');
  assert.equal(uploads.length, 10);
  assert.equal(errorText(await appUpload({ ...TODO_APP, index: 3 }, { data: new Blob(['other'], { type: 'audio/wav' }) }, deps)), undefined);

  resetAppUploads();
  const big = fakes({ register: async (params) => ({ file: { id: params.fileId, name: 'a.mp4', mime: 'video/mp4', size: 90 * MB, createdAt: 0 }, count: 3, bytes: 270 * MB }) });
  assert.equal(errorText(await appUpload(TODO_APP, { data: new SizedBlob(90 * MB, 'video/mp4') }, big.deps)), undefined);
  assert.equal(errorText(await appUpload(TODO_APP, { data: new SizedBlob(31 * MB, 'video/mp4') }, big.deps)), 'This mini-app already stored 300 MB.');
  assert.equal(big.uploads.length, 1, 'the runtime\'s totals count');
});

test('one file at a time per block: a second upload while the first is stored is refused', async () => {
  resetAppUploads();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { deps, uploads } = fakes({ upload: () => gate });
  const first = appUpload(TODO_APP, { data: new Blob(['one'], { type: 'audio/wav' }) }, deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob(['two'], { type: 'audio/wav' }) }, deps)), 'Another file of this app is still being stored.');
  release();
  assert.equal(errorText(await first), undefined);
  assert.equal(uploads.length, 1);
  assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob(['three'], { type: 'audio/wav' }) }, deps)), undefined, 'free again afterwards');
});

test('a register failure reaches the app as its text and frees the block', async () => {
  resetAppUploads();
  let fail = true;
  const { deps, uploads } = fakes({
    register: async (params) => {
      if (fail) throw Object.assign(new Error('This to-do is already finished.'), { code: 'conflict' });
      return { file: { id: params.fileId, name: 'take.wav', mime: 'audio/wav', size: 4, createdAt: 0 }, count: 1, bytes: 4 };
    },
  });
  assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob(['take'], { type: 'audio/wav' }) }, deps)), 'This to-do is already finished.');
  fail = false;
  assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob(['take'], { type: 'audio/wav' }) }, deps)), undefined);
  assert.equal(uploads.length, 2);
  const silent = fakes({ register: async () => { throw {}; } });
  assert.equal(errorText(await appUpload({ ...TODO_APP, index: 9 }, { data: new Blob(['x'], { type: 'audio/wav' }) }, silent.deps)), 'The file could not be stored.');
});

const refusedBy = (code: string, details?: Record<string, unknown>) => async (): Promise<never> => {
  throw Object.assign(new Error(code === 'rate_limited' ? 'This mini-app already stored 10 files.' : 'Mini-apps can hand back audio, video, images, PDFs and text files.'), { code, data: { code, details } });
};

test('refused files count against the block: after three refusals nothing more is stored', async () => {
  resetAppUploads();
  const { deps, uploads, registered } = fakes({ register: refusedBy('bad_request') });
  for (let i = 0; i < 3; i++) assert.match(errorText(await appUpload(TODO_APP, { data: new Blob([`notes ${i}`], { type: 'text/plain' }) }, deps)) ?? '', /^Mini-apps can hand back/);
  for (let i = 0; i < 8; i++) assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob([`notes ${i}`], { type: 'text/plain' }) }, deps)), REFUSED_TEXT);
  assert.equal(uploads.length, 3, 'the 4th to 11th upload stores nothing');
  assert.equal(registered.length, 3);
  assert.equal(errorText(await appUpload({ ...TODO_APP, index: 3 }, { data: new Blob(['x'], { type: 'text/plain' }) }, deps))?.startsWith('Mini-apps'), true, 'another block has its own count');

  // A refused file's bytes count (no totals named): 150 MB stored, 100 MB refused, then 60 MB no longer fit.
  resetAppUploads();
  let calls = 0;
  const mixed = fakes({
    register: async (params) => {
      if (calls++ === 0) return { file: { id: params.fileId, name: 'a.mp4', mime: 'video/mp4', size: 150 * MB, createdAt: 0 }, count: 1, bytes: 150 * MB };
      return refusedBy('bad_request')();
    },
  });
  assert.equal(errorText(await appUpload(TODO_APP, { data: new SizedBlob(90 * MB, 'video/mp4') }, mixed.deps)), undefined);
  assert.ok(errorText(await appUpload(TODO_APP, { data: new SizedBlob(100 * MB, 'video/mp4') }, mixed.deps)));
  assert.equal(errorText(await appUpload(TODO_APP, { data: new SizedBlob(60 * MB, 'video/mp4') }, mixed.deps)), 'This mini-app already stored 300 MB.');
  assert.equal(mixed.uploads.length, 2);

  // The runtime's totals in a refusal count (a reload forgot this window's): the next file is refused before storing.
  resetAppUploads();
  const full = fakes({ register: refusedBy('rate_limited', { count: 10, bytes: 1_000 }) });
  assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob(['take'], { type: 'audio/wav' }) }, full.deps)), 'This mini-app already stored 10 files.');
  assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob(['take'], { type: 'audio/wav' }) }, full.deps)), 'This mini-app already stored 10 files.');
  assert.equal(full.uploads.length, 1);
});

test('a registration the lost connection cut off is sent once more; a second loss is a refusal', async () => {
  resetAppUploads();
  let lost = 1;
  const once = fakes({
    register: async (params) => {
      if (lost-- > 0) throw Object.assign(new Error('Connection to the runtime was lost.'), { code: 'unavailable' });
      return { file: { id: params.fileId, name: 'take.wav', mime: 'audio/wav', size: 4, createdAt: 0 }, count: 1, bytes: 4 };
    },
  });
  assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob(['take'], { type: 'audio/wav' }) }, once.deps)), undefined);
  assert.equal(once.uploads.length, 1, 'stored once');
  assert.deepEqual(once.registered.map((params) => params.fileId), [once.registered[0].fileId, once.registered[0].fileId], 'the same file registered again');

  resetAppUploads();
  const twice = fakes({ register: async () => { throw Object.assign(new Error('Connection to the runtime was lost.'), { code: 'unavailable' }); } });
  assert.equal(errorText(await appUpload(TODO_APP, { data: new Blob(['take'], { type: 'audio/wav' }) }, twice.deps)), 'Connection to the runtime was lost.');
  assert.equal(twice.registered.length, 2, 'only one retry');
});

test('the bridge: wf_upload is an action, a 5 MB Blob stays far below the 64 KiB JSON cap, the Activity list words it', () => {
  const message = { jsonrpc: '2.0', id: 7, method: APP_METHODS.toolsCall, params: { name: APP_TOOLS.upload, arguments: { data: new Blob([new Uint8Array(5 * MB)], { type: 'audio/wav' }), name: 'take.wav' } } };
  assert.ok(frameBytes(message) < APP_BRIDGE_LIMITS.messageBytes, 'a Blob is a structured-clone handle: "{}" in JSON');
  const frame = parseFrame(message);
  assert.ok(frame);
  assert.equal(isAction(frame), true, 'it shares the 30 actions per minute');
  assert.ok((frame.params.arguments as { data: unknown }).data instanceof Blob, 'parsing keeps the Blob');
  assert.deepEqual(activityLabel({ method: APP_METHODS.toolsCall, tool: APP_TOOLS.upload }), { label: 'Stored a file for the agent', name: 'wf_upload' });
  const ring = new CallRing(5);
  assert.equal(logCall(ring, 'b_x', frame, frameBytes(message), 'pending').bytes, frameBytes(message) + 5 * MB, 'the Activity row shows the file\'s size');
  const state = { jsonrpc: '2.0', id: 8, method: APP_METHODS.toolsCall, params: { name: APP_TOOLS.stateSet, arguments: { state: { a: 1 } } } };
  assert.equal(logCall(ring, 'b_x', state, frameBytes(state), 'ok').bytes, frameBytes(state), 'other calls: the message size');
  assert.equal(ring.entries()[0].tool, 'wf_upload');
});

test('app-tools.ts: wf_upload needs files.uploadChunk and blocks.file; it stores with uploadBlob and registers with blocks.file', async (t) => {
  resetAppUploads();
  const real = rpc.call;
  const before = session.value;
  t.after(() => { (rpc as unknown as { call: unknown }).call = real; session.value = before; });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  (rpc as unknown as { call: unknown }).call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    const file: FileRef = { id: 'a'.repeat(64), name: 'take.wav', mime: 'audio/wav', size: 4, createdAt: 0 };
    if (method === 'files.uploadChunk') return { received: 4, ...(params.final ? { file } : {}) };
    if (method === 'blocks.file') return { file, count: 1, bytes: 4 };
    throw new Error(`unexpected ${method}`);
  };
  const device = (allowedMethods: string[]): SessionInfo => ({ kind: 'device', capabilities: ['todo'], secure: true, allowedMethods: allowedMethods as SessionInfo['allowedMethods'] });
  const take = { data: new Blob(['RIFF'], { type: 'audio/wav' }), name: 'take.wav' };

  session.value = device(['files.uploadChunk']);
  assert.equal(errorText(await callHostTool(TODO_APP, APP_TOOLS.upload, take)), 'This device cannot store files for mini-apps.');
  session.value = device(['blocks.file']);
  assert.equal(errorText(await callHostTool(TODO_APP, APP_TOOLS.upload, take)), 'This device cannot store files for mini-apps.');
  assert.equal(calls.length, 0, 'nothing was sent');

  session.value = device(['files.uploadChunk', 'blocks.file']);
  const result = await callHostTool(TODO_APP, APP_TOOLS.upload, take);
  assert.deepEqual(result.structuredContent, { fileId: 'a'.repeat(64), name: 'take.wav', mime: 'audio/wav', size: 4 });
  assert.deepEqual(calls.map((call) => call.method), ['files.uploadChunk', 'blocks.file']);
  assert.deepEqual([calls[0].params.name, calls[0].params.mime, calls[0].params.final], ['take.wav', 'audio/wav', true]);
  assert.deepEqual(calls[1].params, { messageId: TODO_APP.messageId, blockIndex: 2, fileId: 'a'.repeat(64) });
});
