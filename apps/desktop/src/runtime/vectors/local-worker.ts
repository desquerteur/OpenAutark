// The worker thread that runs the local embedding model: ONNX Runtime's WebAssembly build (no native binary a policy
// could block or crash the runtime with – the native package segfaulted here on load), the tokenizer and the model.
// Runs one text at a time (batches gain nothing on the CPU and cost padding), so a query waits for one chunk at most.
// The source is an inline string so it works from the TS sources and inside the esbuild bundle alike; terminating the
// thread gives all its memory back.
// Owns: the thread's code – load, tokenize, run, mean-pool, normalize. Never: downloads, SQL, or decides what is embedded.

import { UnigramTokenizer } from './tokenizer.ts';

export const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const UnigramTokenizer = ${UnigramTokenizer.toString()};
const ort = require(workerData.ortFile);
ort.env.wasm.numThreads = workerData.threads;
ort.env.wasm.wasmPaths = workerData.wasmUrl;
const ready = (async () => {
  const session = await ort.InferenceSession.create(workerData.modelFile, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false,
  });
  const tokenizer = new UnigramTokenizer(JSON.parse(readFileSync(workerData.tokenizerFile, 'utf8')));
  return { tokenizer, session };
})();
async function vector(text) {
  const { tokenizer, session } = await ready;
  const ids = tokenizer.encode(text, 512);
  const size = ids.length;
  const shape = [1, size];
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), shape),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(size).fill(1n), shape),
  };
  if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(size), shape);
  const output = await session.run(feeds);
  const hidden = output[session.outputNames[0]];
  const dims = hidden.dims[2];
  const out = new Float32Array(dims);
  for (let token = 0; token < size; token++) for (let d = 0; d < dims; d++) out[d] += hidden.data[token * dims + d];
  let length = 0;
  for (let d = 0; d < dims; d++) length += out[d] * out[d];
  length = Math.sqrt(length) || 1;
  for (let d = 0; d < dims; d++) out[d] /= length;
  hidden.dispose?.();
  return out;
}
let queue = Promise.resolve();
parentPort.on('message', (message) => {
  queue = queue.then(async () => {
    try {
      const out = await vector(message.text);
      parentPort.postMessage({ seq: message.seq, vector: out }, [out.buffer]);
    } catch (error) {
      parentPort.postMessage({ seq: message.seq, error: String(error && error.message || error) });
    }
  });
});
ready.then(() => parentPort.postMessage({ loaded: true }), (error) => parentPort.postMessage({ failed: String(error && error.message || error) }));
`;
