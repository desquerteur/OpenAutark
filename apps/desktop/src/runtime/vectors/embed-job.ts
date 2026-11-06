// One embedding job: the given files and folders (folders walked with the exclusions of places.ts), each file's whole
// text (Markdown, text, code, JSON, CSV; PDF through files/pdf.ts) cut into chunks and embedded batch by batch until the
// budget ends. A file that did not fit keeps its finished chunks and continues at the next call; an unchanged file costs
// one stat. A folder walked to its end also drops the files that no longer exist under it. A changed file's old vectors stay
// until its first new chunk exists, so a model that fails loses nothing. A memory file's frontmatter leaves only its title
// and description.
// Owns: that loop and its report. Never: searches, or runs without being asked (service.ts decides when).

import { open, readFile as readWhole, stat } from 'node:fs/promises';
import path from 'node:path';
import type { VectorEmbedResult } from '../../shared/model/vectors.ts';
import { extractPdfText } from '../files/pdf.ts';
import { parseFrontMatter } from '../skills/frontmatter.ts';
import { chunkText } from './chunk.ts';
import type { Embedder } from './embedders.ts';
import { MEMORY_PLACE, isGone, refusedFolder, walkFolder, type Places } from './places.ts';
import { toInt8, type ChunkRow, type VectorStore } from './store.ts';

/** Bigger files are not embedded (a log of this size is no knowledge; files.search reads it). */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_WALK_FILES = 50_000;
const MAX_LISTED = 60;
const SNIPPET_CHARS = 320;
/** How much longer than the budget one batch may take before the model counts as not ready (still downloading or loading). */
const MODEL_GRACE_MS = 15_000;
const NOT_READY = 'The embedding model is still loading or downloading – try again in a minute.';
/** A locked file: its vectors stay, the next look reads it again. */
const NOT_READABLE = 'not readable';
const REMOVED = 'removed meanwhile';
/** At most this share of a job's time goes to walking a folder. */
const WALK_SHARE = 1 / 3;

/** The text of a file, or why there is none. */
export type ReadFile = (file: string, size: number) => Promise<string | { skip: string }>;

export interface JobDeps {
  store: VectorStore;
  places: Places;
  embedder: Embedder;
  now: () => number;
  redact?: (text: string) => string;
  readFile?: ReadFile;
  /** A whole file embedded with another model counts as embedded (no pass of the memory tree pays for it again). */
  keepOtherModel?: boolean;
}

export const emptyResult = (): VectorEmbedResult & { failed?: boolean } => ({ embedded: 0, reembedded: 0, unchanged: 0, skipped: [] });

const readText: ReadFile = async (file, size) => {
  if (/\.pdf$/i.test(file)) {
    if (size > MAX_PDF_BYTES) return { skip: 'too large' };
    const text = await extractPdfText(await readWhole(file)).catch(() => undefined);
    return text?.trim() ? text : { skip: 'no readable text' };
  }
  if (size > MAX_TEXT_BYTES) return { skip: `too large (${Math.round(size / 1_048_576)} MB)` };
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return { skip: NOT_READABLE };
  try {
    const body = Buffer.alloc(size);
    const { bytesRead } = await handle.read(body, 0, size, 0);
    if (body.subarray(0, Math.min(bytesRead, 8192)).includes(0)) return { skip: 'binary' };
    return body.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
};

/** Runs one job; never throws for a file or the model (the report says what happened). */
export async function runEmbed(paths: string[], deadline: number, deps: JobDeps): Promise<VectorEmbedResult & { failed?: boolean }> {
  const result = emptyResult();
  const skip = (where: string, reason: string) => { if (result.skipped.length < MAX_LISTED) result.skipped.push({ path: where, reason }); };
  const files: string[] = [];
  let remaining = 0;
  for (const given of paths) {
    const place = deps.places.resolve(given);
    if (!place) { skip(given, 'give an absolute path or "memory/…"'); continue; }
    if (!place.absolute) { skip(given, 'a catalog entry embeds itself'); continue; }
    const info = await stat(place.absolute).catch(() => undefined);
    if (!info) {
      if (!(await isGone(place.absolute))) { skip(given, 'not reachable right now'); continue; }
      deps.store.removeUnder(place.key); // gone: what was embedded of it goes too
      if (place.path !== 'memory') skip(given, 'not found');
      continue;
    }
    if (info.isFile()) { files.push(place.absolute); continue; }
    if (!info.isDirectory()) { skip(given, 'neither a file nor a folder'); continue; }
    const memory = place.path === MEMORY_PLACE || place.path.startsWith(`${MEMORY_PLACE}/`);
    const refused = memory ? undefined : refusedFolder(place.absolute);
    if (refused) { skip(given, refused); continue; }
    const now = deps.now();
    const walked = await walkFolder(place.absolute, { deadline: now + (deadline - now) * WALK_SHARE, maxFiles: MAX_WALK_FILES, now: deps.now, memory });
    files.push(...walked.files);
    for (const entry of walked.skipped) skip(entry.path, entry.reason);
    const binary = walked.counts.get('binary');
    if (binary) skip(given, `${binary} binary files`);
    if (walked.cut) skip(given, 'folder too big to walk at once – name its subfolders'); // the same walk would stop at the same place
    if (!walked.cut) await dropMissing(place.key, walked.files, deps);
  }

  let stopReason: string | undefined;
  let left = 0; // files the budget or a failed model did not reach: one line for them all
  for (const file of files) {
    if (!stopReason && deps.now() > deadline) stopReason = 'budget used – call vector.embed again';
    if (stopReason) { left++; continue; }
    try {
      const outcome = await embedFile(file, deadline, deps);
      if (typeof outcome === 'object') {
        if ('skip' in outcome) skip(file, outcome.skip);
        else { remaining++; skip(file, `${outcome.done} of ${outcome.total} chunks done – call vector.embed again`); }
      } else result[outcome]++;
    } catch (error) {
      stopReason = (error as Error).message || 'The embedding model failed.';
      result.failed = true;
      remaining++;
      skip(file, stopReason);
    }
  }
  if (left && stopReason) skip(`${left} more files`, stopReason);
  remaining += left;
  if (remaining) result.remaining = remaining;
  return result;
}

/** Files that were embedded below a walked folder and are not there any more leave the store. */
async function dropMissing(key: string, found: string[], deps: JobDeps): Promise<void> {
  const present = new Set(found.map((file) => deps.places.resolve(file)?.key));
  for (const row of deps.store.filesUnder(key)) {
    if (present.has(row.key)) continue; // a file named on purpose below a skipped folder stays
    if (await isGone(deps.places.absoluteOf(row.path))) deps.store.remove(row.key);
  }
}

/** The model's answer, or an error when it takes too long (the work goes on; the next call finds it ready). */
function inTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(NOT_READY)), ms); });
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => { if (timer) clearTimeout(timer); });
}

/** A memory file as its meaning: the frontmatter leaves only its title and description, read with the memory tree's parser (ids and dates would fill the snippet); line numbers stay. */
function memoryText(text: string): string {
  const head = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0];
  if (!head) return text;
  const { data } = parseFrontMatter(text);
  const kept = [data.title, data.description].flatMap((value) => (typeof value === 'string' && value.trim() ? [value.replace(/\s+/g, ' ').trim()] : []));
  const lines = head.split('\n').map(() => '');
  kept.forEach((value, index) => { lines[index + 1] = value; });
  return lines.join('\n') + text.slice(head.length);
}

type FileOutcome = 'embedded' | 'reembedded' | 'unchanged' | { skip: string } | { done: number; total: number };

async function embedFile(file: string, deadline: number, deps: JobDeps): Promise<FileOutcome> {
  const { store, places, embedder } = deps;
  const place = places.resolve(file);
  if (!place) return { skip: 'not a place' };
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return { skip: 'not readable' };
  const mtime = Math.trunc(info.mtimeMs);
  const known = store.file(place.key);
  const read = known && known.mtime === mtime && known.size === info.size;
  if (read && deps.keepOtherModel && known.done >= known.chunks) return 'unchanged';
  const same = read && known.model === embedder.id;
  if (same && known.done >= known.chunks) return 'unchanged';

  const text = await (deps.readFile ?? readText)(file, info.size);
  if (typeof text !== 'string') { if (known && text.skip !== NOT_READABLE) store.remove(place.key); return text; }
  const chunks = chunkText(place.path.startsWith('memory/') ? memoryText(text) : text);
  if (!chunks.length) { if (known) store.remove(place.key); return { skip: 'empty' }; }

  const resume = same && known.chunks === chunks.length ? known.done : 0;
  let fileId = resume && known ? known.id : undefined; // a new start replaces the old vectors only once the first new ones exist
  const name = path.basename(file);
  const isPdf = /\.pdf$/i.test(file);
  const redact = deps.redact ?? ((value: string) => value);
  for (let at = resume; at < chunks.length; at += embedder.batch) {
    if (deps.now() > deadline) return { done: at, total: chunks.length };
    const part = chunks.slice(at, at + embedder.batch);
    const vectors = await inTime(embedder.embed(part.map((chunk) => {
      const body = `${name}\n${chunk.text}`;
      return embedder.remote ? redact(body) : body;
    }), 'document'), Math.max(0, deadline - deps.now()) + MODEL_GRACE_MS);
    const rows: ChunkRow[] = part.map((chunk, index) => ({
      chunk: at + index,
      ...(isPdf ? {} : { from: chunk.from, to: chunk.to }),
      snippet: redact(chunk.text.slice(0, SNIPPET_CHARS)),
      vector: toInt8(vectors[index]),
    }));
    fileId ??= store.begin(place.key, place.path, mtime, info.size, embedder.id, chunks.length);
    if (!store.put(fileId, rows, at + part.length)) return { skip: REMOVED };
  }
  if (await isGone(file)) { // removed while it was read or embedded (memory.forget): nothing of it stays
    store.remove(place.key);
    return { skip: REMOVED };
  }
  return known ? 'reembedded' : 'embedded';
}
