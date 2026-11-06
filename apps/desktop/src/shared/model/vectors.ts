// The vector system's shapes (01.11.2026, owner: "ein System, mit dem generell alle mit Vektoren suchen können, für
// alles"): vector.embed deliberately embeds files or folders and they stay stored; vector.search works like grep over
// what is already embedded under the given places. "memory" as a place is <data>/memory; "catalog" holds the virtual
// entries of the knowledge catalog (B-078, no files).
// Owns: the shapes both tools and services.vectors return. Never: logic.

/** One found chunk. `path` is absolute (for a place below "memory": relative to it, starting with "memory/"). */
export interface VectorHit {
  path: string;
  /** The chunk's number within its file, from 0. */
  chunk: number;
  /** First and last line of the chunk, from 1 (a PDF has none). */
  lines?: [number, number];
  snippet: string;
  /** Cosine similarity, -1 to 1 (higher = closer); for a hit reached in hops, the product of the similarities on its path. */
  score: number;
  /** B-078: a hit reached through another one (multi-hop search) names it here. */
  via?: string;
}

export interface VectorSearchResult {
  hits: VectorHit[];
  searched: { places: string[]; embeddedFiles: number };
  /** Said plainly when there is something to know: nothing embedded there, no embedder, a place that failed. */
  note?: string;
}

export interface VectorEmbedResult {
  /** Files embedded for the first time. */
  embedded: number;
  /** Files embedded before that had changed (or came from another embedding model). */
  reembedded: number;
  /** Files already embedded and unchanged. */
  unchanged: number;
  /** What was left out and why (exclusions, unreadable, binary) – the budget's rest too, so a model can call again. */
  skipped: Array<{ path: string; reason: string }>;
  /** Files the call's budget did not reach (also listed in `skipped`, capped); call vector.embed again for them. */
  remaining?: number;
}

export interface VectorSearchInput {
  query: string;
  /** Files or folders, or "memory" / "memory/<folder>" – a filter over what is embedded, never embedded by this. */
  in: string[];
  k?: number;
  /** B-078: 0–2 hops (vectors/hops.ts): the best hits' own vectors search again; a path scores the product of its similarities. Default 0. */
  hops?: number;
}

/** B-078: one virtual entry (no file): key "catalog/<origin>/<id>" and the text that stands for it. */
export interface VectorText {
  key: string;
  text: string;
}
