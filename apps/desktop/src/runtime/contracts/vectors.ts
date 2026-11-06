// services.vectors: the vector system as a member of RuntimeServices (merged by module augmentation, like the other
// late additions in this folder).
// Owns: the interface. Never: behaviour (runtime/vectors/service.ts).

import type { VectorEmbedResult, VectorSearchInput, VectorSearchResult, VectorText } from '../../shared/model/vectors.ts';

export interface VectorService {
  /** An embedding model can serve now. */
  available(): boolean;
  /** Embeds files or folders on purpose (absolute paths, "memory", "memory/…"); they stay stored. */
  embed(paths: string[], opts?: { budgetMs?: number; notYet?: boolean }): Promise<VectorEmbedResult>;
  /** Embeds only the query and compares it with what is already embedded under `in`. */
  search(input: VectorSearchInput): Promise<VectorSearchResult>;
  /** A memory file was written or changed ("memory/…", relative to the memory folder, or absolute): it is embedded soon. */
  onFileChanged(path: string): void;
  /** A memory file or folder is gone: its vectors go. */
  onFileRemoved(path: string): void;
  /** B-078: virtual entries (vectors/virtual.ts) – short texts whole, the caller gives a big entry's title + description; unchanged ones cost a lookup. */
  embedTexts?(items: readonly VectorText[], opts?: { budgetMs?: number }): Promise<{ embedded: number; unchanged: number; remaining: number; failed?: boolean }>;
  /** B-078: the virtual entries at or below `key` go ("catalog/…"). */
  forget?(key: string): void;
  /** B-078: the stored keys (as given) of the virtual entries below `key`. */
  virtualKeys?(key: string): string[];
  /** The app stops: no more background work; a running local model ends. */
  stop?(): void;
}

declare module '../contracts.ts' {
  interface RuntimeServices {
    vectors: VectorService;
  }
}
