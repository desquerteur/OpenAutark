// Virtual entries of the vector store (B-078 D12): a text with a key and no file of its own – a catalog entry
// (knowledge/catalog.ts: a skill, a home project's instruction file, a public library entry). The store row is the same
// as a file's: path = the key ("catalog/<origin>/<id>"), mtime = a number from the text's hash (an unchanged text costs
// one lookup), size = its length. The embedding rule lives here, one rule for all of them: a text up to CHUNK_CHARS is
// embedded whole; a bigger entry by its title and description only (owner 06.11.2026: "wenn der Text kurz genug ist, wird
// der einfach direkt embedded … bei Öffentlichen … nur Descriptions"). Memory files keep their chunking (embed-job.ts).
// Owns: that rule, the hash-as-mtime and the batch loop of virtual texts. Never: reads files or decides which entries exist.

import { createHash } from 'node:crypto';
import { CHUNK_CHARS } from './chunk.ts';
import type { Embedder } from './embedders.ts';
import { toInt8, type VectorStore } from './store.ts';

export const CATALOG_PLACE = 'catalog';
const SNIPPET_CHARS = 320;
/** How much longer than the budget one batch may take before the model counts as not ready. */
const MODEL_GRACE_MS = 15_000;

/** A stored path that is a virtual entry, not a file. */
export const isVirtual = (stored: string): boolean => stored === CATALOG_PLACE || stored.startsWith(`${CATALOG_PLACE}/`);

/** A 48-bit number from the text's sha256: what stands in the mtime column of a virtual row. */
export function textStamp(text: string): number {
  return Number.parseInt(createHash('sha256').update(text).digest('hex').slice(0, 12), 16);
}

/** What is embedded of an entry: the whole text when it is short, else its title and description. */
export function embedTextOf(entry: { title: string; description: string; body?: string }): string {
  const whole = `${entry.title}\n${entry.description}${entry.body ? `\n${entry.body}` : ''}`.trim();
  if (whole.length <= CHUNK_CHARS) return whole;
  return `${entry.title}\n${entry.description}`.slice(0, CHUNK_CHARS).trim();
}

export interface VirtualItem { key: string; text: string }
export interface VirtualResult { embedded: number; unchanged: number; remaining: number; failed?: boolean }

export interface VirtualDeps {
  store: VectorStore;
  embedder: Embedder;
  now: () => number;
  keyOf: (stored: string) => string;
  redact?: (text: string) => string;
}

function inTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The embedding model is still loading or downloading.')), ms); });
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Embeds the items that changed (or came from another model), batch by batch until the deadline; never throws. */
export async function runEmbedTexts(items: readonly VirtualItem[], deadline: number, deps: VirtualDeps): Promise<VirtualResult> {
  const result: VirtualResult = { embedded: 0, unchanged: 0, remaining: 0 };
  const known = new Map(deps.store.filesUnder(CATALOG_PLACE).map((row) => [row.key, row]));
  const due: Array<VirtualItem & { stamp: number; stored: string }> = [];
  for (const item of items) {
    if (!isVirtual(item.key) || !item.text.trim()) continue;
    const text = item.text.slice(0, CHUNK_CHARS);
    const stamp = textStamp(text);
    const row = known.get(deps.keyOf(item.key));
    if (row && row.mtime === stamp && row.model === deps.embedder.id && row.done >= row.chunks) { result.unchanged++; continue; }
    due.push({ key: item.key, text, stamp, stored: item.key });
  }
  const redact = deps.redact ?? ((value: string) => value);
  for (let at = 0; at < due.length; at += deps.embedder.batch) {
    if (deps.now() > deadline) { result.remaining = due.length - at; break; }
    const part = due.slice(at, at + deps.embedder.batch);
    let vectors: Float32Array[];
    try {
      vectors = await inTime(deps.embedder.embed(part.map((item) => (deps.embedder.remote ? redact(item.text) : item.text)), 'document'), Math.max(0, deadline - deps.now()) + MODEL_GRACE_MS);
    } catch {
      result.failed = true;
      result.remaining = due.length - at;
      break;
    }
    part.forEach((item, index) => {
      const id = deps.store.begin(deps.keyOf(item.key), item.stored, item.stamp, item.text.length, deps.embedder.id, 1);
      deps.store.put(id, [{ chunk: 0, snippet: redact(item.text.slice(0, SNIPPET_CHARS)), vector: toInt8(vectors[index]) }], 1);
    });
    result.embedded += part.length;
  }
  return result;
}
