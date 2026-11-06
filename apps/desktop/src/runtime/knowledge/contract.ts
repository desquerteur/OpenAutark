// The memory calls of services.knowledge (merged by module augmentation, like the other late additions).
// Owns: the member declarations only. Never: behaviour (knowledge/service.ts).

import type { MemoryFile, MemoryFolder, MemoryWriteInput, MemoryWriteResult } from '../../shared/model/memory.ts';

declare module '../contracts/models.ts' {
  interface KnowledgeService {
    /** One folder of the tree (relative to <data>/memory, '' = its root): description, subfolders, newest files (titles, with a file's description when it has one). */
    memoryBrowse(folder?: string): MemoryFolder;
    /** One file; undefined when there is none. */
    memoryRead(path: string): MemoryFile | undefined;
    /** Creates or updates a file (same folder and title = that file); it is embedded by this (services.vectors). */
    memoryWrite(input: MemoryWriteInput & { by?: string }): MemoryWriteResult;
    /** Deletes a file with its vectors and old versions. */
    memoryForget(path: string): { removed: boolean };
  }
}
