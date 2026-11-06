// The public library's shapes (B-078 D13): sources of skills and notes written by others – a git repository cloned shallow
// into <data>/library/<id>, or an index-only list (name, description, URL) – and what publishing one of mine gives back.
// The library itself is the folder library/ of the public repository teydra/OpenAutark.
// Owns: the shapes. Never: logic (runtime/library/).

export type LibrarySourceKind = 'git' | 'index';

export interface LibrarySource {
  /** Folder and key name: lowercase letters, digits and hyphens. */
  id: string;
  kind: LibrarySourceKind;
  /** owner/name on GitHub (kind 'git'). */
  repo?: string;
  /** The subfolder of the repository that holds the entries ('' = all of it). */
  folder?: string;
  /** Where an index-only list lives (kind 'index'): a JSON list or a Markdown list of links. */
  url?: string;
  /** Shipped with the app (the rest were added on this PC). */
  builtin?: boolean;
}

export interface LibraryEntry {
  source: string;
  name: string;
  description: string;
  /** The entry's SKILL.md (or note) on this PC – a cloned source. */
  file?: string;
  /** Where it lives on the web – an index-only entry, or the cloned file's page. */
  url?: string;
  size?: number;
  sha256?: string;
  /** The description stands in from the text's heading and first sentence (nobody wrote one). */
  fallback?: true;
}

export interface LibrarySourceState {
  source: LibrarySource;
  /** When this PC last fetched it (absent: never). */
  syncedAt?: number;
  entries: number;
  problem?: string;
}

export type PublishKind = 'skill' | 'note';

export interface PublishInput {
  kind: PublishKind;
  name: string;
  /** The whole Markdown text (front matter included for a skill). */
  text: string;
  /** Public entries mine is derived from (front matter derived-from). */
  derivedFrom?: string[];
}

export type PublishResult =
  | { ok: true; url: string; branch: string; path: string }
  | { ok: false; reason: 'off' | 'secret' | 'internal' | 'no-gh' | 'signed-out' | 'failed' | 'no-check'; text: string };

/** The public repository whose library/ folder is the shared library. */
export const LIBRARY_REPO = 'teydra/OpenAutark';
export const LIBRARY_FOLDER = 'library';
