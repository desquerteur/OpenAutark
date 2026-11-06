// Multi-hop search over what is embedded (B-078 D12, owner 06.11.2026: "75 % … aber 90 % zu dem anderen … Vernetzung,
// die nicht nur von eins zu eins"): the query finds its seeds; the stored vectors of the best BEAM seeds are the next
// queries; a path's score is the product of its similarities (A~B 0.75 × B~C 0.9 = 0.675 beats a direct 0.2). Best score
// per file, HOPS hops at most, no model call beyond the query's own embedding. A hop below HOP_FLOOR is dropped (MiniLM hits
// sit at 0.4–0.75: a loose chain of loose hits says nothing). One scan of the store per hop (the whole beam scored together),
// so a 2-hop search reads the chunks three times.
// Owns: the walk and the path score. Never: embeds, reads files or knows what an entry is.

export const SEEDS = 8;
export const BEAM = 5;
export const MAX_HOPS = 2;
export const HOP_FLOOR = 0.3;

export interface ChunkHit { fileId: number; chunk: number; score: number }
export interface HopHit extends ChunkHit {
  /** The hit this one was reached through (absent: found by the query itself). */
  via?: ChunkHit;
  hops: number;
}

export interface HopDeps {
  /** The best `k` chunks for each unit vector, among the allowed files – one scan of the store for all of them. */
  top(vectors: readonly Float32Array[], k: number): Promise<ChunkHit[][]>;
  /** A stored chunk's unit vector. */
  vectorOf(fileId: number, chunk: number): Float32Array | undefined;
}

/** The best `k` files for `query` within `hops` hops (0 = the plain search, one best chunk per file). */
export async function hopSearch(query: Float32Array, k: number, hops: number, deps: HopDeps): Promise<HopHit[]> {
  const best = new Map<number, HopHit>();
  const keep = (hit: HopHit): boolean => {
    const known = best.get(hit.fileId);
    if (known && known.score >= hit.score) return false;
    best.set(hit.fileId, hit);
    return true;
  };
  const seeds = (await deps.top([query], Math.max(k, SEEDS)))[0] ?? [];
  for (const seed of seeds) keep({ ...seed, hops: 0 });
  let frontier = uniqueBest(seeds.map((seed) => ({ ...seed, hops: 0 })));
  for (let hop = 1; hop <= Math.min(hops, MAX_HOPS); hop++) {
    const next: HopHit[] = [];
    const froms: HopHit[] = [];
    const vectors: Float32Array[] = [];
    for (const from of frontier.slice(0, BEAM)) {
      if (from.score <= 0) continue;
      const vector = deps.vectorOf(from.fileId, from.chunk);
      if (!vector) continue;
      froms.push(from);
      vectors.push(vector);
    }
    const lists = vectors.length ? await deps.top(vectors, SEEDS) : []; // one scan per hop for the whole beam
    for (const [index, from] of froms.entries()) {
      for (const found of lists[index] ?? []) {
        if (found.fileId === from.fileId || found.score <= 0) continue;
        const score = from.score * found.score;
        if (score < HOP_FLOOR) continue;
        const hit: HopHit = { ...found, score, via: { fileId: from.fileId, chunk: from.chunk, score: from.score }, hops: hop };
        if (keep(hit)) next.push(hit);
      }
    }
    if (!next.length) break;
    frontier = uniqueBest(next);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.fileId - b.fileId).slice(0, k);
}

/** One hit per file, best first. */
function uniqueBest(hits: readonly HopHit[]): HopHit[] {
  const byFile = new Map<number, HopHit>();
  for (const hit of hits) if ((byFile.get(hit.fileId)?.score ?? -Infinity) < hit.score) byFile.set(hit.fileId, hit);
  return [...byFile.values()].sort((a, b) => b.score - a.score);
}
