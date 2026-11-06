// RPC contract part: files by their path on this PC, the pane's file tab (handlers runtime/rpc/handlers/files-path.ts).
// No folder limits; for the owner and the phone ('manage'). B-076: `device` names the linked CEO PC the file is on (a
// tab that came from there) – the call goes on to that PC. Merged into Methods by module augmentation.
// Owns: these method shapes. Never: behaviour.

/** What a path holds now. `same`: the file still has the stamp the caller named in `since`. */
export type PathState = 'text' | 'binary' | 'large' | 'missing' | 'folder' | 'same';

export interface PathRead {
  /** The absolute path, normalised. */
  path: string;
  state: PathState;
  size: number;
  /** Tells a later read whether the file changed (mtime + size; '' for a missing file or a folder). */
  stamp: string;
  /** The content, for `state: 'text'`. */
  text?: string;
}

export interface PathWritten { path: string; size: number; stamp: string }

export interface PathEntry { name: string; path: string; folder: boolean }

export interface PathList {
  path: string;
  /** The folder above; absent at a drive's or the system's root. */
  parent?: string;
  /** Folders first, then by name. */
  entries: PathEntry[];
  /** How many entries the folder has (more than `entries` when it is very long). */
  total: number;
  /** The folder does not exist. */
  missing?: true;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** What the file at `path` holds; with `since` only a change costs a read. */
    'files.readPath': { params: { path: string; since?: string; device?: string }; result: PathRead };
    /** Writes the text (folders are created). `base`: the stamp it was made on; a file changed since is a conflict. */
    'files.writePath': { params: { path: string; text: string; base?: string; device?: string }; result: PathWritten };
    'files.listPath': { params: { path: string; device?: string }; result: PathList };
  }
}

export {};
