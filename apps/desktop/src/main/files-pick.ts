// The native "attach" picker: an open dialog, then every chosen file goes into the runtime blob
// store by path (files.uploadPath streams it – no bytes travel through the renderer or main).
// A folder is walked (sorted, bounded depth) and its files are uploaded one by one.
// pickFolder answers only a folder path (where a backup or chat export goes, the backup to restore: Settings › About) – nothing is
// uploaded.
// Owns: dialog options per kind and purpose, folder walking limits.
// Never: reads file contents, imports electron (the dialog and the upload call are injected).

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FolderPurpose, PickKind } from '../shared/api/desktop.ts';
import type { FileRef } from '../shared/model/system.ts';
import { WorkforceError } from '../shared/errors.ts';

/** Same limit the composer applies per message. */
export const PICK_LIMIT = 20;
const MAX_DEPTH = 12;

export interface DialogOptions {
  title?: string;
  buttonLabel?: string;
  properties: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory' | 'promptToCreate'>;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface PickDeps {
  showOpenDialog(options: DialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  /** RpcClient `files.uploadPath`. */
  upload(file: string): Promise<FileRef>;
}

const FILTERS: Partial<Record<PickKind, { name: string; extensions: string[] }>> = {
  images: { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'] },
  audio: { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'ogg', 'oga', 'opus', 'webm', 'flac', 'aac'] },
  video: { name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'] },
};

export function dialogOptions(kind: PickKind): DialogOptions {
  if (kind === 'folder') return { properties: ['openDirectory'] };
  const filter = FILTERS[kind];
  return { properties: ['openFile', 'multiSelections'], ...(filter ? { filters: [filter] } : {}) };
}

function tooMany(): never {
  throw new WorkforceError('bad_request', `Choose up to ${PICK_LIMIT} files or a smaller folder.`);
}

/** Files below `folder` (sorted, depth ≤ 12), stopping as soon as the limit is exceeded. */
export async function folderFiles(folder: string, limit = PICK_LIMIT): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new WorkforceError('bad_request', 'Choose a folder that is less deeply nested.');
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) {
        out.push(full);
        if (out.length > limit) tooMany();
      }
    }
  };
  await walk(folder, 0);
  return out;
}

/** Shows the dialog and uploads the choice; [] when cancelled. */
export async function pickAndUpload(kind: PickKind, deps: PickDeps): Promise<FileRef[]> {
  const result = await deps.showOpenDialog(dialogOptions(kind));
  if (result.canceled || !result.filePaths.length) return [];
  let files: string[];
  if (kind === 'folder') {
    files = await folderFiles(result.filePaths[0]);
    if (!files.length) throw new WorkforceError('bad_request', 'This folder has no files to attach.');
  } else {
    if (result.filePaths.length > PICK_LIMIT) tooMany();
    files = result.filePaths;
  }
  const refs: FileRef[] = [];
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size === 0) continue; // the store refuses empty files; skip them quietly
    refs.push(await deps.upload(file)); // one at a time: the runtime streams, RAM stays flat
  }
  return refs;
}

// ------------------------------------------------------------------ a folder path

const FOLDER_DIALOGS: Record<FolderPurpose, DialogOptions> = {
  // createDirectory: macOS "New Folder"; promptToCreate: Windows accepts a typed new folder name.
  backup: { title: 'Choose where to save the backup', buttonLabel: 'Back up here', properties: ['openDirectory', 'createDirectory', 'promptToCreate'] },
  restore: { title: 'Choose an Autark backup folder', buttonLabel: 'Choose backup', properties: ['openDirectory'] },
  chats: { title: 'Choose a folder for the chat folders', buttonLabel: 'Choose folder', properties: ['openDirectory', 'createDirectory', 'promptToCreate'] },
};

/** Renderer input → purpose (throws bad_request for anything else). */
export function folderPurpose(value: unknown): FolderPurpose {
  if (value === 'restore' || value === 'backup' || value === 'chats') return value;
  throw new WorkforceError('bad_request', 'Invalid folder purpose.');
}

export function folderDialogOptions(purpose: FolderPurpose): DialogOptions {
  const options = FOLDER_DIALOGS[purpose];
  return { ...options, properties: [...options.properties] };
}

/** Shows the folder dialog for `purpose` and answers the absolute path, or null when cancelled. */
export async function pickFolder(purpose: unknown, deps: Pick<PickDeps, 'showOpenDialog'>): Promise<string | null> {
  const result = await deps.showOpenDialog(folderDialogOptions(folderPurpose(purpose)));
  const chosen = result.canceled ? undefined : result.filePaths[0];
  if (!chosen) return null;
  if (!path.isAbsolute(chosen) || chosen.includes('\0')) throw new WorkforceError('bad_request', 'Choose a folder on this PC.');
  return chosen;
}
