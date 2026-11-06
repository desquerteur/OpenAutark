// B-047 D14 model downloads (src/runtime/voice/local/download.ts): SHA-256 checked, resumed with a Range
// request after a stop, started over when the server ignores the range, a damaged or oversized download
// leaves no part behind, too little disk is refused before anything is fetched, a plain-http hop is refused,
// a tar.bz2 is unpacked by the system tar and the manifest is written last (only then is it installed).
// Owns: these assertions only. Never: the network (a fake fetch serves the bytes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LocalSpeechModel } from '../../../src/shared/model/local-speech-models.ts';
import { installModel, systemTar, type DownloadFetch } from '../../../src/runtime/voice/local/download.ts';
import { isInstalled, modelDir, partFile, speechRoot } from '../../../src/runtime/voice/local/store.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { tempData } from './local-fixture.ts';

const BYTES = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'.repeat(1000));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fileModel(bytes: Uint8Array = BYTES, patch: Partial<LocalSpeechModel['download']> = {}): LocalSpeechModel {
  return {
    id: 'test-vad', purpose: 'vad', tier: 'tiny', kind: 'silero-vad', label: 'Test VAD', publisher: 'Test', languages: [], licence: 'MIT', licenceUrl: 'https://example.com',
    files: ['model.onnx'], sizeMb: 1, ramMb: 10, note: '',
    download: { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/model.onnx', sha256: sha(bytes), bytes: bytes.byteLength, format: 'file', file: 'model.onnx', ...patch },
  };
}

/** Serves `bytes` (honouring Range unless `ignoreRange`), in chunks; records the request headers. */
function server(bytes: Uint8Array, options: { ignoreRange?: boolean; url?: string; status?: number; stopAfter?: number } = {}) {
  const requests: Array<Record<string, string>> = [];
  const fetch: DownloadFetch = async (_url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    requests.push(headers);
    if (options.status) return new Response('no', { status: options.status });
    const from = !options.ignoreRange && headers.Range ? Number(/bytes=(\d+)-/.exec(headers.Range)![1]) : 0;
    const end = options.stopAfter && requests.length === 1 ? options.stopAfter : bytes.byteLength;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = from; at < end; at += 4096) controller.enqueue(bytes.subarray(at, Math.min(end, at + 4096)));
        controller.close();
      },
    });
    const response = new Response(body, { status: from ? 206 : 200 });
    if (options.url) Object.defineProperty(response, 'url', { value: options.url });
    return response;
  };
  return { fetch, requests };
}

test('a file download is hashed, checked and installed with its manifest; progress reaches the total', async () => {
  const data = tempData();
  try {
    const model = fileModel();
    const { fetch } = server(BYTES);
    const progress: Array<[string, number, number]> = [];
    await installModel(model, { dataDir: data.dir, fetch, freeDisk: async () => 10e9, progress: (state, done, total) => progress.push([state, done, total]) });
    assert.ok(isInstalled(data.dir, model));
    assert.deepEqual(readFileSync(path.join(modelDir(data.dir, model), 'model.onnx')), BYTES);
    assert.ok(!existsSync(partFile(data.dir, model)), 'the part became the model file');
    assert.deepEqual(progress.at(-1), ['unpacking', BYTES.byteLength, BYTES.byteLength]);
    assert.ok(progress.some(([state, done]) => state === 'downloading' && done === BYTES.byteLength));
    await installModel(model, { dataDir: data.dir, fetch: async () => { throw new Error('no second download'); } });
  } finally { data.done(); }
});

test('a stopped download resumes with a Range request and hashes the bytes it already had', async () => {
  const data = tempData();
  try {
    const model = fileModel();
    const first = server(BYTES, { stopAfter: 10_000 });
    await assert.rejects(installModel(model, { dataDir: data.dir, fetch: first.fetch, freeDisk: async () => undefined }), (error: unknown) => error instanceof WorkforceError && /continues where it stopped/.test(error.message));
    assert.equal(readFileSync(partFile(data.dir, model)).byteLength, 10_000, 'the part stays for the next try');
    const second = server(BYTES);
    await installModel(model, { dataDir: data.dir, fetch: second.fetch, freeDisk: async () => undefined });
    assert.equal(second.requests[0].Range, 'bytes=10000-');
    assert.ok(isInstalled(data.dir, model));
  } finally { data.done(); }
});

test('a server that ignores the range starts the download over (200 instead of 206)', async () => {
  const data = tempData();
  try {
    const model = fileModel();
    mkdirSync(speechRoot(data.dir), { recursive: true });
    writeFileSync(partFile(data.dir, model), BYTES.subarray(0, 5_000));
    const { fetch, requests } = server(BYTES, { ignoreRange: true });
    await installModel(model, { dataDir: data.dir, fetch, freeDisk: async () => undefined });
    assert.equal(requests[0].Range, 'bytes=5000-');
    assert.deepEqual(readFileSync(path.join(modelDir(data.dir, model), 'model.onnx')), BYTES);
  } finally { data.done(); }
});

test('a damaged download fails with a clear message and leaves no part; so does an oversized one', async () => {
  const data = tempData();
  try {
    const model = fileModel(BYTES, { sha256: 'f'.repeat(64) });
    await assert.rejects(installModel(model, { dataDir: data.dir, fetch: server(BYTES).fetch, freeDisk: async () => undefined }), /damaged \(its checksum does not match\)/);
    assert.ok(!existsSync(partFile(data.dir, model)));
    assert.ok(!isInstalled(data.dir, model));
    const small = fileModel(BYTES.subarray(0, 1_000));
    await assert.rejects(installModel(small, { dataDir: data.dir, fetch: server(BYTES).fetch, freeDisk: async () => undefined }), /larger than expected/);
    assert.ok(!existsSync(partFile(data.dir, small)));
  } finally { data.done(); }
});

test('too little disk is refused before any request; a plain-http hop and a server error are refused', async () => {
  const data = tempData();
  try {
    const model = fileModel();
    const { fetch, requests } = server(BYTES);
    await assert.rejects(installModel(model, { dataDir: data.dir, fetch, freeDisk: async () => 1_000 }), /Not enough disk space for Test VAD/);
    assert.equal(requests.length, 0);
    await assert.rejects(installModel(model, { dataDir: data.dir, fetch: server(BYTES, { url: 'http://mirror.example/model.onnx' }).fetch, freeDisk: async () => undefined }), /redirected away from HTTPS/);
    await assert.rejects(installModel(model, { dataDir: data.dir, fetch: server(BYTES, { status: 404 }).fetch, freeDisk: async () => undefined }), /answered 404/);
  } finally { data.done(); }
});

const hasTar = (() => { try { execFileSync(systemTar(), ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('a tar.bz2 is unpacked by the system tar, its files are checked, and the folder moves in place', { skip: !hasTar && 'no system tar' }, async () => {
  const data = tempData();
  try {
    const source = path.join(data.dir, 'src');
    mkdirSync(path.join(source, 'pack-1'), { recursive: true });
    writeFileSync(path.join(source, 'pack-1', 'a.onnx'), 'model a');
    writeFileSync(path.join(source, 'pack-1', 'tokens.txt'), 'tokens');
    const archive = path.join(data.dir, 'pack-1.tar.bz2');
    execFileSync(systemTar(), ['-cjf', archive, '-C', source, 'pack-1']);
    const bytes = readFileSync(archive);
    const model: LocalSpeechModel = { ...fileModel(bytes), id: 'test-pack', files: ['a.onnx', 'tokens.txt'], download: { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/pack-1.tar.bz2', sha256: sha(bytes), bytes: bytes.byteLength, format: 'tar.bz2', folder: 'pack-1' } };
    await installModel(model, { dataDir: data.dir, fetch: server(bytes).fetch, freeDisk: async () => undefined });
    assert.ok(isInstalled(data.dir, model));
    assert.equal(readFileSync(path.join(modelDir(data.dir, model), 'a.onnx'), 'utf8'), 'model a');
    const incomplete: LocalSpeechModel = { ...model, id: 'test-pack-2', files: ['a.onnx', 'missing.onnx'] };
    await assert.rejects(installModel(incomplete, { dataDir: data.dir, fetch: server(bytes).fetch, freeDisk: async () => undefined }), /missing missing\.onnx/);
    assert.ok(!isInstalled(data.dir, incomplete));
  } finally { data.done(); }
});

test('B-058: two installs of one model at once download it once (the voice pull, the sound model and the auto download share it)', async () => {
  const data = tempData();
  try {
    const model = fileModel();
    const { fetch, requests } = server(BYTES);
    const both = await Promise.all([installModel(model, { dataDir: data.dir, fetch, freeDisk: async () => undefined }), installModel(model, { dataDir: data.dir, fetch, freeDisk: async () => undefined })]);
    assert.equal(both.length, 2);
    assert.equal(requests.length, 1);
    assert.ok(isInstalled(data.dir, model));
    await installModel(model, { dataDir: data.dir, fetch, freeDisk: async () => undefined });
    assert.equal(requests.length, 1, 'installed: nothing fetched');
  } finally { data.done(); }
});

test('an unpack failure is a clear error and the next try starts from the kept part', async () => {
  const data = tempData();
  try {
    const model: LocalSpeechModel = { ...fileModel(), id: 'test-broken', download: { ...fileModel().download, format: 'tar.bz2', folder: 'x' } };
    await assert.rejects(installModel(model, { dataDir: data.dir, fetch: server(BYTES).fetch, freeDisk: async () => undefined, unpack: async () => { throw new Error('tar: unrecognized archive'); } }), /could not be unpacked on this PC/);
    assert.ok(!isInstalled(data.dir, model));
    assert.ok(existsSync(partFile(data.dir, model)), 'the verified part stays');
    const again = server(BYTES);
    await assert.rejects(installModel(model, { dataDir: data.dir, fetch: again.fetch, freeDisk: async () => undefined, unpack: async () => { throw new Error('still broken'); } }));
    assert.equal(again.requests.length, 0, 'a complete part is not fetched again');
  } finally { data.done(); }
});
