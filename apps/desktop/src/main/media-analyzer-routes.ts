// MM4 + B-058 G6/G10: the routes of the media analyzer's private session (media-analyzer.ts runs the
// jobs): wf-file://media-analyzer/analyze.js (the page script) and, for the running job only,
// /job/<n>/ (the page with its CSP), spec (the job's task and its limits), video (the job's blob,
// streamed with ranges) and what the page sends back – samples and frame?at=<ms> for keyframes,
// pcm?at=<byte> for a sound job (media-audio.ts), image for an image job (media-image.ts) – then done
// or fail; everything the page sends is checked.
// Owns: the job record, these routes, their verbs and limits, the failure texts agents read.
// Never: serves a file other than the running job's blob, answers a job that is not running,
// trusts the page's numbers or bytes unchecked.

import { createReadStream } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { AUDIO_DECODE_LIMITS, IMAGE_LIMITS, KEYFRAME_LIMITS } from '../shared/api/host-bridge.ts';
import type { DecodedAudio, Keyframe, Keyframes, NormalizedImage } from '../shared/api/host-bridge.ts';
import { WorkforceError } from '../shared/errors.ts';
import { ANALYZER_CSP, ANALYZER_HTML, ANALYZER_SCRIPT } from './media-analyzer-page.ts';
import type { PageSpec } from './media-analyzer-page.ts';
import { audioResult, audioSpec, PCM_CHUNK_BYTES, pcmChunkOk, WHOLE_MS } from './media-audio.ts';
import type { AudioRequest, AudioSpec } from './media-audio.ts';
import { encodedImage, imageSpec } from './media-image.ts';
import type { ImageRequest, ImageSpec } from './media-image.ts';
import { checkFacts, jpegSize, pickKeyframes, sampleCount } from './media-keyframes.ts';
import type { KeyframeRequest, VideoFacts } from './media-keyframes.ts';
import { parseRange } from './protocols/rules.ts';

const HOST = 'media-analyzer';
export const ANALYZER_ORIGIN = `wf-file://${HOST}`;
const JOB_ROUTE = /^\/job\/(\d{1,9})\/(spec|video|samples|frame|pcm|image|done|fail)?$/;
/** Waits for a seek's picture (media-analyzer-page.ts header): ≤ 1.5 s for a presented frame, ≥ 80 ms per look without frame callbacks, 4 s of looking again per job. */
const PAGE_SPEC = { edge: KEYFRAME_LIMITS.edge, quality: 0.82, grid: 24, waitMs: 1500, lookMs: 80, budgetMs: 4000, deadlineMs: KEYFRAME_LIMITS.jobMs - 5000 };
const MAX_JSON_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 1536 * 1024;
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

/** What one job does, with its checked request. */
export type JobTask =
  | { kind: 'keyframes'; request: KeyframeRequest }
  | { kind: 'audio'; request: AudioRequest }
  | { kind: 'image'; request: ImageRequest };

export type JobResult = Keyframes | DecodedAudio | NormalizedImage;

const minutes = (ms: number) => Math.round(ms / 60_000);
const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** Why the page gave up (its stage), per task → what the agent reads. */
const FAILURES: Record<JobTask['kind'], Record<string, string>> = {
  keyframes: {
    decode: 'This video cannot be read here: the format or codec is not supported, or the file is damaged.',
    'no-video': 'This file has no picture, only sound. Use media.transcribe for what is said.',
    duration: 'The length of this video could not be read.',
    seek: 'This video could not be searched for frames; the file may be damaged.',
    encode: 'A frame of this video could not be encoded.',
  },
  audio: {
    decode: 'This recording cannot be read here: the format or codec is not supported, or the file is damaged.',
    'no-audio': 'This file has no sound that can be read here: no sound track, or a sound codec this app cannot decode.',
    'too-long': `This recording is over ${minutes(WHOLE_MS)} minutes in a format that is only read whole here (MP4, M4A, MOV); send it as MP3, OGG or WebM, or in shorter pieces.`,
    'too-far': `Only the first ${minutes(WHOLE_MS)} minutes of a recording can be decoded here; ask for a part that ends by then, or send the later part as a file of its own.`,
    'too-large': `This file is too large to read its sound here (over ${megabytes(AUDIO_DECODE_LIMITS.inputBytes)} MB); send a shorter piece or only its sound.`,
  },
  image: {
    decode: 'This image cannot be read here: the format is not supported (for example TIFF or HEIC) or the file is damaged.',
    'too-large': 'This image is too large to prepare here.',
    encode: 'This image could not be converted to JPEG or PNG.',
  },
};

/** One analyzer job: its task, its blob and what the page sent so far. */
export interface Job {
  id: number;
  task: JobTask;
  file: string;
  size: number;
  mime: string;
  facts?: VideoFacts;
  /** Set when samples arrive, before their body is read: concurrent posts cannot both pass. */
  sampling: boolean;
  picks?: Map<number, boolean>; // atMs → chosen for a scene change
  /** Picked moments a frame was posted for, reserved before its body is read (each moment once). */
  taken: Set<number>;
  frames: Keyframe[];
  /** A sound job's PCM chunks in order, their bytes, and a chunk being read (posts at the same time cannot both pass). */
  pcm: Uint8Array[];
  pcmBytes: number;
  pcmBusy: boolean;
  /** An image job's one result, reserved before its body is read. */
  imageTaken: boolean;
  image?: NormalizedImage;
  streams: Set<ReadStream>;
  settled: boolean;
  done: Promise<JobResult>;
  finish(result: JobResult | WorkforceError): void;
}

export function newJob(id: number, task: JobTask, file: string, size: number, mime: string): Job {
  let settle: (result: JobResult | WorkforceError) => void = () => {};
  const done = new Promise<JobResult>((resolve, reject) => {
    settle = (result) => (result instanceof WorkforceError ? reject(result) : resolve(result));
  });
  const job: Job = {
    id, task, file, size, mime, sampling: false, taken: new Set(), frames: [], pcm: [], pcmBytes: 0, pcmBusy: false, imageTaken: false,
    streams: new Set(), settled: false, done,
    finish: (result) => {
      if (job.settled) return;
      job.settled = true;
      settle(result);
    },
  };
  return job;
}

const status = (code: number, extra: Record<string, string> = {}) => new Response(null, { status: code, headers: { ...HEADERS, ...extra } });
const body = (text: string, type: string, extra: Record<string, string> = {}) => new Response(text, { status: 200, headers: { ...HEADERS, 'Content-Type': type, ...extra } });
const json = (value: unknown) => body(JSON.stringify(value), 'application/json');
/** A page's failure: 'unavailable' for keyframes (MM4); for sound and image jobs 'bad_request' – the file itself, so a retry gets the same (busy, timeout and a crash keep their own codes). */
const failure = (job: Job, stage: string) =>
  new WorkforceError(job.task.kind === 'keyframes' ? 'unavailable' : 'bad_request', FAILURES[job.task.kind][stage] ?? FAILURES[job.task.kind].decode);

/** One request of the private session, answered for `job` (the running one, or null). */
export async function serveJob(request: Request, job: Job | null): Promise<Response> {
  let url: URL;
  try { url = new URL(request.url); } catch { return status(400); }
  if (url.protocol !== 'wf-file:' || url.host !== HOST) return status(404);
  const verb = request.method;
  if (url.pathname === '/analyze.js') return verb === 'GET' ? body(ANALYZER_SCRIPT, 'text/javascript; charset=utf-8') : status(405);
  const match = JOB_ROUTE.exec(url.pathname);
  if (!match) return status(404);
  if (!job || job.settled || job.id !== Number(match[1])) return status(410);
  const part = match[2] ?? '';
  const verbs = part === 'video' ? ['GET', 'HEAD'] : part === '' || part === 'spec' ? ['GET'] : ['POST'];
  if (!verbs.includes(verb)) return status(405);
  const task = job.task;
  switch (part) {
    case '': return body(ANALYZER_HTML, 'text/html; charset=utf-8', { 'Content-Security-Policy': ANALYZER_CSP });
    case 'spec': return json(specOf(job));
    case 'video': return video(job, request);
    case 'samples': return task.kind === 'keyframes' ? samples(job, request, task.request) : status(404);
    case 'frame': return task.kind === 'keyframes' ? frame(job, request, url.searchParams.get('at') ?? '') : status(404);
    case 'pcm': return task.kind === 'audio' ? pcm(job, request, task.request, url.searchParams.get('at') ?? '') : status(404);
    case 'image': return task.kind === 'image' ? image(job, request, task.request) : status(404);
    case 'done': return done(job, request);
    default: return failed(job, request);
  }
}

function specOf(job: Job): PageSpec | AudioSpec | ImageSpec {
  const task = job.task;
  if (task.kind === 'audio') return audioSpec(task.request, job.size, job.mime);
  if (task.kind === 'image') return imageSpec(task.request, job.mime);
  return { task: 'keyframes', ...PAGE_SPEC, samples: sampleCount(task.request.frames) };
}

/** The job's blob, streamed; `Range: bytes=a-b` answers 206 so the video can seek. */
function video(job: Job, request: Request): Response {
  const range = parseRange(request.headers.get('range'), job.size);
  if (range === 'invalid') return status(416, { 'Content-Range': `bytes */${job.size}` });
  const headers: Record<string, string> = { ...HEADERS, 'Content-Type': job.mime, 'Accept-Ranges': 'bytes' };
  const code = range ? 206 : 200;
  const { start, end } = range ?? { start: 0, end: job.size - 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${job.size}`;
  headers['Content-Length'] = String(job.size ? end - start + 1 : 0);
  if (request.method === 'HEAD' || job.size === 0) return new Response(null, { status: code, headers });
  const stream = createReadStream(job.file, { start, end });
  job.streams.add(stream);
  stream.once('close', () => job.streams.delete(stream));
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status: code, headers });
}

/** The page's signatures → the moments to draw (once per job, even when posted at the same time). */
async function samples(job: Job, request: Request, asked: KeyframeRequest): Promise<Response> {
  if (job.sampling) return status(409);
  job.sampling = true;
  const facts = checkFacts(parseJson(await readBody(request, MAX_JSON_BYTES)), sampleCount(asked.frames));
  if (job.settled) return status(410); // timed out or stopped while the body was read
  if (!facts) {
    job.finish(failure(job, 'seek'));
    return status(400);
  }
  const picks = pickKeyframes(facts.samples, asked.frames);
  job.facts = facts;
  job.picks = new Map(picks.map((pick) => [pick.atMs, pick.scene]));
  return json({ times: picks.map((pick) => pick.atMs) });
}

/** One JPEG at a picked moment: once each (even when posted at the same time), ≤ 1.5 MB, its frame header within the edge. */
async function frame(job: Job, request: Request, at: string): Promise<Response> {
  const atMs = /^\d{1,9}$/.test(at) ? Number(at) : -1;
  const scene = job.picks?.get(atMs);
  if (scene === undefined || job.taken.has(atMs)) return status(409);
  job.taken.add(atMs);
  const bytes = await readBody(request, MAX_FRAME_BYTES);
  if (job.settled) return status(410); // done, failed or timed out while the body was read
  const size = bytes ? jpegSize(bytes) : null;
  if (!bytes || !size || size.width > KEYFRAME_LIMITS.edge || size.height > KEYFRAME_LIMITS.edge) {
    job.finish(failure(job, 'encode'));
    return status(400);
  }
  job.frames.push({ atMs, scene, data: bytes, width: size.width, height: size.height, mime: 'image/jpeg' });
  return status(204);
}

/** One chunk of the decoded sound at byte offset `at`: in order, one at a time, whole samples, ≤ 1 MiB, within the span asked for. */
async function pcm(job: Job, request: Request, asked: AudioRequest, at: string): Promise<Response> {
  const offset = /^\d{1,10}$/.test(at) ? Number(at) : -1;
  if (job.pcmBusy || offset !== job.pcmBytes) return status(409);
  job.pcmBusy = true;
  let bytes: Uint8Array | null;
  try { bytes = await readBody(request, PCM_CHUNK_BYTES); } finally { job.pcmBusy = false; }
  if (job.settled) return status(410); // timed out or stopped while the body was read
  if (!bytes || !pcmChunkOk(job.pcmBytes, bytes.byteLength, asked)) {
    job.finish(failure(job, 'decode'));
    return status(400);
  }
  job.pcm.push(bytes);
  job.pcmBytes += bytes.byteLength;
  return status(204);
}

/** The image job's one result: a PNG or JPEG within the edge and IMAGE_LIMITS.maxBytes, once. */
async function image(job: Job, request: Request, asked: ImageRequest): Promise<Response> {
  if (job.imageTaken) return status(409);
  job.imageTaken = true;
  const bytes = await readBody(request, IMAGE_LIMITS.maxBytes);
  if (job.settled) return status(410);
  const facts = bytes ? encodedImage(bytes, asked.maxPx) : null;
  if (!bytes || !facts) {
    job.finish(failure(job, 'encode'));
    return status(400);
  }
  job.image = { data: bytes, ...facts };
  return status(204);
}

async function done(job: Job, request: Request): Promise<Response> {
  const task = job.task;
  if (task.kind === 'audio') {
    const report = parseJson(await readBody(request, 1024));
    if (job.settled) return status(410);
    const result = audioResult(report, task.request, job.pcm, job.pcmBytes);
    job.finish(!result ? failure(job, 'decode') : result.durationMs === 0 ? failure(job, 'no-audio') : result);
    return status(204);
  }
  if (task.kind === 'image') {
    job.finish(job.image ?? failure(job, 'encode'));
    return status(204);
  }
  const facts = job.facts;
  if (!facts || !job.frames.length) job.finish(new WorkforceError('unavailable', 'No frame could be taken from this video.'));
  else job.finish({ durationMs: facts.durationMs, width: facts.width, height: facts.height, frames: [...job.frames].sort((a, b) => a.atMs - b.atMs) });
  return status(204);
}

async function failed(job: Job, request: Request): Promise<Response> {
  const reason = (parseJson(await readBody(request, 1024)) as { reason?: unknown } | null)?.reason;
  const known = FAILURES[job.task.kind];
  job.finish(failure(job, typeof reason === 'string' && Object.hasOwn(known, reason) ? reason : 'decode'));
  return status(204);
}

/** The request body up to `max` bytes; null when it is larger (the rest is not read). */
async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

function parseJson(bytes: Uint8Array | null): unknown {
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}
