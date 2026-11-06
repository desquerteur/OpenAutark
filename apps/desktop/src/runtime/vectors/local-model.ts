// The small embedding model this PC runs itself, no account needed: paraphrase-multilingual-MiniLM-L12-v2 (50+
// languages, 384 numbers, Apache-2.0; Xenova's int8 ONNX export, 118 MB, plus its 17 MB tokenizer), fetched on first
// need by the local speech download (resumes, checks the SHA-256, checks the disk) and run in a worker thread that ends
// after IDLE_MS, which gives its memory back.
// Measured 01.11.2026 on the 8 GB reference PC (i3-1215U, busy, ONNX Runtime WebAssembly, 2 threads; Node and Electron's
// Node): load 2-3.5 s; a query 30-60 ms; a 1800-character chunk (~380 tokens) 415-600 ms; process 430-530 MB while
// loaded, 680-740 MB briefly at load, back to 90 MB when the worker ends. Chosen over multilingual-e5-small (same size
// and speed) on German and English retrieval: 12/12 top hits against 11/12, unrelated texts near 0 and hits at 0.4-0.75
// instead of everything within 0.65-0.90, and better hits on long chunks of real dictated German.
// The WebAssembly build is on purpose: the native onnxruntime-node crashed this process on load (segfault) and needs
// binaries Windows may block.
// Owns: the model's files, the runtime's location, the worker's life. Never: stores vectors or decides what is embedded.

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { LocalSpeechModel } from '../../shared/model/local-speech-models.ts';
import { installModel, type DownloadFetch } from '../voice/local/download.ts';
import { isInstalled, modelDir } from '../voice/local/store.ts';
import type { Embedder } from './embedders.ts';
import { WORKER_SOURCE } from './local-worker.ts';

export const LOCAL_EMBEDDING_ID = 'local:paraphrase-multilingual-minilm-l12-v2-int8';
/** Its name wherever a person or an agent reads what searches by meaning (Settings › Models, the live line). */
export const LOCAL_EMBEDDING_NAME = 'MiniLM-L12 multilingual';

const THREADS = 2;
const IDLE_MS = 2 * 60_000;
/** After this many failed downloads or loads this runtime stops offering the local model (the next option takes over). */
const MAX_FAILURES = 3;
const REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
const REPO = `https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/${REVISION}`;

const entry = (id: string, label: string, file: string, url: string, sha256: string, bytes: number): LocalSpeechModel => ({
  id, purpose: 'tagging', tier: 'tiny', kind: 'ced', label, publisher: 'sentence-transformers', languages: [],
  licence: 'Apache-2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0', files: [file],
  download: { url, sha256, bytes, format: 'file', file }, sizeMb: Math.ceil(bytes / 1_000_000), ramMb: 500, note: 'Embedding model of the vector system.',
});

const MODEL = entry('embedding-minilm-l12-int8', 'the embedding model', 'model_int8.onnx', `${REPO}/onnx/model_int8.onnx`,
  'd6ea442ff6a891daefed7c83b2f596fc5dc66bf697e4d006236f64f34bbcf4c8', 118_054_609);
const TOKENIZER = entry('embedding-minilm-l12-tokenizer', 'the embedding model\'s tokenizer', 'tokenizer.json', `${REPO}/tokenizer.json`,
  'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441', 17_082_913);

/** ONNX Runtime's Node entry and its wasm folder, outside the asar (a worker and its wasm need real files); undefined: not installed. */
export function runtimeFiles(resolve: (id: string) => string = createRequire(import.meta.url).resolve): { ortFile: string; wasmUrl: string } | undefined {
  try {
    const ortFile = resolve('onnxruntime-web').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return { ortFile, wasmUrl: pathToFileURL(path.dirname(ortFile) + path.sep).href };
  } catch { return undefined; }
}

interface Waiting { resolve: (vector: Float32Array) => void; reject: (error: Error) => void }

export interface LocalEmbedderDeps {
  dataDir: string;
  /** Default: not in an isolated test profile (no network download there, like the speech model). */
  enabled?: boolean;
  fetch?: DownloadFetch;
}

export class LocalEmbedder implements Embedder {
  readonly id = LOCAL_EMBEDDING_ID;
  readonly batch = 1;
  readonly remote = false;
  private readonly deps: LocalEmbedderDeps;
  private readonly files = runtimeFiles();
  private failures = 0;
  private installing?: Promise<void>;
  private worker?: Worker;
  private idle?: ReturnType<typeof setTimeout>;
  private seq = 0;
  private readonly waiting = new Map<number, Waiting>();

  constructor(deps: LocalEmbedderDeps) {
    this.deps = deps;
  }

  /** Can serve (downloaded, or able to download). */
  possible(): boolean {
    return (this.deps.enabled ?? !process.env.WORKFORCE_TEST_DATA) && Boolean(this.files) && this.failures < MAX_FAILURES;
  }

  /** It failed too often in this runtime: whatever serves now only stands in for it until the next start. */
  gaveUp(): boolean {
    return this.failures >= MAX_FAILURES;
  }

  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    await this.install();
    const out: Float32Array[] = [];
    for (const text of texts) out.push(await this.one(text, purpose));
    return out;
  }

  /** Ends the worker now (shutdown). */
  stop(): void {
    this.end(new Error('The embedding model was stopped.'));
  }

  private install(): Promise<void> {
    if (isInstalled(this.deps.dataDir, MODEL) && isInstalled(this.deps.dataDir, TOKENIZER)) return Promise.resolve();
    this.installing ??= (async () => {
      const options = { dataDir: this.deps.dataDir, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) };
      await installModel(TOKENIZER, options);
      await installModel(MODEL, options);
    })().catch((error: unknown) => { this.failures++; throw error; }).finally(() => { this.installing = undefined; });
    return this.installing;
  }

  private one(text: string, purpose: 'query' | 'document'): Promise<Float32Array> {
    const worker = this.running();
    const seq = ++this.seq;
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    worker.ref();
    return new Promise((resolve, reject) => {
      this.waiting.set(seq, { resolve, reject });
      worker.postMessage({ seq, text, purpose });
    });
  }

  private running(): Worker {
    if (this.worker) return this.worker;
    const files = this.files;
    if (!files) throw new Error('The local embedding runtime is not installed.');
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { ...files, threads: THREADS, modelFile: path.join(modelDir(this.deps.dataDir, MODEL), MODEL.files[0]), tokenizerFile: path.join(modelDir(this.deps.dataDir, TOKENIZER), TOKENIZER.files[0]) },
    });
    worker.on('message', (message: { seq?: number; vector?: Float32Array; error?: string; failed?: string }) => {
      if (message.failed) { this.failures++; this.end(new Error('The embedding model could not be loaded on this PC.', { cause: message.failed })); return; }
      if (message.seq === undefined) return;
      const waiter = this.waiting.get(message.seq);
      this.waiting.delete(message.seq);
      if (message.vector) waiter?.resolve(message.vector); else waiter?.reject(new Error(message.error ?? 'The embedding model failed.'));
      if (!this.waiting.size) this.rest(worker);
    });
    worker.on('error', (error) => { this.failures++; this.end(error instanceof Error ? error : new Error(String(error))); });
    worker.on('exit', () => { if (this.worker === worker) this.end(new Error('The embedding model stopped.')); });
    this.worker = worker;
    return worker;
  }

  /** Nothing open: the worker no longer keeps the process alive and ends after IDLE_MS. */
  private rest(worker: Worker): void {
    worker.unref();
    this.idle = setTimeout(() => this.end(new Error('idle')), IDLE_MS);
    (this.idle as { unref?: () => void }).unref?.();
  }

  private end(reason: Error): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    const worker = this.worker;
    this.worker = undefined;
    for (const waiter of this.waiting.values()) waiter.reject(reason);
    this.waiting.clear();
    void worker?.terminate();
  }
}
