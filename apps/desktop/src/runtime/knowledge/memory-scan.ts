// Reading the newest items of memory folders: files read newest first until enough pass. The async form is for anything that walks
// a whole scope (the list, the word search: 100,000 files must not stop the app), the sync one for what is small by design (pinned/).
// Owns: that loop. Never: decides who may read what (acl.ts).

import type { KnowledgeItem } from '../../shared/model/knowledge.ts';
import { itemOfEntry, type MemoryTree } from './memory-tree.ts';

/** Files read at most for a word search or an empty query (the newest ones). */
export const SCAN_MAX = 5000;

export function scanFiles(tree: MemoryTree, folders: readonly string[], fits: (item: KnowledgeItem) => boolean, want: number): KnowledgeItem[] {
  const out: KnowledgeItem[] = [];
  const files = tree.files(folders);
  for (let index = 0; index < files.length && index < SCAN_MAX && out.length < want; index++) {
    const entry = tree.read(files[index].rel);
    const item = entry && itemOfEntry(entry);
    if (item && fits(item)) out.push(item);
  }
  return out;
}

export async function scanFilesAsync(tree: MemoryTree, folders: readonly string[], fits: (item: KnowledgeItem) => boolean, want: number): Promise<KnowledgeItem[]> {
  const out: KnowledgeItem[] = [];
  const files = await tree.filesAsync(folders);
  for (let index = 0; index < files.length && index < SCAN_MAX && out.length < want; index++) {
    const entry = await tree.readAsync(files[index].rel);
    const item = entry && itemOfEntry(entry);
    if (item && fits(item)) out.push(item);
  }
  return out;
}
