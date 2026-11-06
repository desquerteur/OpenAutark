// Memory model (01.11.2026): memory is a folder tree of Markdown files under <data>/memory – company/, branches/<space>/,
// agents/<agent>/, references/<subject>/ and free topic subfolders, each folder optionally described by _folder.md; a file
// in a pinned/ subfolder is always in its readers' prompt (small, hard-capped).
// Owns: the shapes of one memory file and of the memory.* calls, and how much of a file's description is shown. Never: a
// list or index that goes into an agent's context (searching is vector.search with in: "memory/…").

export type MemoryKind = 'fact' | 'preference' | 'experience' | 'procedure' | 'plan' | 'observation' | 'note' | 'reference';

/** How much of a memory file's description a listing or hit line shows (the file keeps it whole). */
export const DESCRIPTION_SHOWN = 160;

/** One memory entry = one Markdown file (frontmatter + text). `path` is relative to <data>/memory, '/'-separated. */
export interface MemoryFile {
  path: string;
  title: string;
  /** Optional: one line on when the file helps (frontmatter `description:`). */
  description?: string;
  kind?: MemoryKind;
  tags?: string[];
  /** Last change (ms). */
  updated: number;
  /** Where it came from: a chat, run, file, URL or 'human'. */
  source?: string;
  text: string;
  /** World time the entry starts / stops being true (ms). */
  validFrom?: number;
  validTo?: number;
}

/** What memory.browse shows of one folder: its description (_folder.md), its subfolders and its files (titles, with a file's description when it has one). */
export interface MemoryFolder {
  path: string;
  description?: string;
  folders: Array<{ path: string; description?: string }>;
  files: Array<{ path: string; title: string; description?: string; kind?: MemoryKind; updated: number }>;
  /** More files than shown (browse is capped – search with vector.search). */
  more?: boolean;
}

export interface MemoryWriteInput {
  /** An existing file to update (relative to <data>/memory). */
  path?: string;
  /** The folder a new file goes to (relative); default company/ (the memory.write tool: the caller's own folder). */
  folder?: string;
  title: string;
  text: string;
  /** One line on when the file helps (optional); '' removes it. */
  description?: string;
  kind?: MemoryKind;
  tags?: string[];
  source?: string;
  validFrom?: number;
  validTo?: number;
}

export interface MemoryWriteResult {
  path: string;
  outcome: 'created' | 'updated' | 'unchanged';
}
