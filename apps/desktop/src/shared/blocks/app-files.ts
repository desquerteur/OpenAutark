// Files an agent's ```app todo=true mini-app hands back (X03, wf.upload): a recording, an image
// or a document. The frame posts the Blob itself as a structured-clone handle (the bridge's 64 KiB
// cap measures JSON only), the host checks it here, stores it in chunks and registers it for its
// block with blocks.file, and the runtime checks the stored file again with its sniffed type
// (runtime/tasks/app-files.ts). The to-do's answer then carries the files like a Record answer.
// Also the RPC shape of blocks.file, merged into Methods by module augmentation because
// api/methods.ts is at its size limit (it can move there unchanged).
// Owns: the allowed types and extensions, type and name normalizing, the limits and the refusal
// texts both sides show. Never: reads bytes, trusts a name over the type, or allows active or
// opaque content (svg, html, scripts, archives, octet-stream).

import type { FileRef } from '../model/system.ts';

export interface AppUploadLimits {
  /** Bytes of one file. */
  fileBytes: number;
  /** Bytes of all files of one block. */
  blockBytes: number;
  filesPerBlock: number;
}

export const APP_UPLOAD_LIMITS: Readonly<AppUploadLimits> = { fileBytes: 100 * 1024 * 1024, blockBytes: 300 * 1024 * 1024, filesPerBlock: 10 };

/** Allowed types → their extensions (the first is the default). */
export const APP_UPLOAD_TYPES: Readonly<Record<string, readonly string[]>> = {
  'audio/wav': ['wav'], 'audio/webm': ['webm', 'weba'], 'audio/ogg': ['ogg', 'oga', 'opus'], 'audio/mpeg': ['mp3'],
  'audio/mp4': ['m4a', 'mp4'], 'audio/aac': ['aac'], 'audio/flac': ['flac'],
  'video/webm': ['webm'], 'video/mp4': ['mp4', 'm4v'], 'video/quicktime': ['mov'],
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/gif': ['gif'], 'image/avif': ['avif'],
  'image/heic': ['heic', 'heif'],
  'application/pdf': ['pdf'], 'text/plain': ['txt'], 'text/markdown': ['md'], 'text/csv': ['csv'], 'text/vtt': ['vtt'],
  'application/x-subrip': ['srt'], 'application/json': ['json'],
};

const ALIASES: Readonly<Record<string, string>> = {
  'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4',
};

export const APP_TYPE_REFUSAL = 'Mini-apps can hand back audio, video, images, PDFs and text files.';
const MAX_NAME = 120;
const EXTENSION = /\.([A-Za-z][A-Za-z0-9]{0,7})$/;
// Control characters, characters Windows refuses in names, and bidi overrides (a name that reads backwards).
const UNSAFE = /[\u0000-\u001f\u007f<>:"|?*‎‏‪-‮⁦-⁩]/g;

const allowed = (mime: string): boolean => Object.hasOwn(APP_UPLOAD_TYPES, mime);
const extensionOf = (name: string): string | undefined => EXTENSION.exec(name)?.[1].toLowerCase();

/** The bare, lower-case type with its aliases resolved ('audio/webm;codecs=opus' → 'audio/webm'). */
function bareType(type: string): string {
  const bare = type.split(';')[0].trim().toLowerCase();
  return ALIASES[bare] ?? bare;
}

/** The type of an extension: one it is the default of, else the first that lists it. */
function typeOfExtension(ext: string): string | undefined {
  const entries = Object.entries(APP_UPLOAD_TYPES);
  return (entries.find(([, exts]) => exts[0] === ext) ?? entries.find(([, exts]) => exts.includes(ext)))?.[0];
}

/** Extensions a type may carry: its own and its audio/video twin's (the store sniffs every WebM as video/webm). */
function extensionsOf(mime: string): readonly string[] {
  const [kind, sub] = mime.split('/');
  const twin = kind === 'audio' ? `video/${sub}` : kind === 'video' ? `audio/${sub}` : '';
  return [...(APP_UPLOAD_TYPES[mime] ?? []), ...(twin && allowed(twin) ? APP_UPLOAD_TYPES[twin] : [])];
}

/** The allowed type of a Blob (from its type, or from the name's extension when it has none); undefined when not allowed. */
export function appUploadMime(type: string, name?: string): string | undefined {
  const bare = bareType(typeof type === 'string' ? type : '');
  if (bare) return allowed(bare) ? bare : undefined;
  const ext = extensionOf(typeof name === 'string' ? name : '');
  return ext ? typeOfExtension(ext) : undefined;
}

/**
 * A safe file name for `mime`: the base name only, unsafe characters replaced, no leading dots,
 * at most 120 characters, 'file' when nothing is left, and an extension of that type ('evil.bat'
 * as text/plain → 'evil.txt', 'take' as audio/webm → 'take.webm').
 */
export function appUploadName(name: unknown, mime: string): string {
  const exts = APP_UPLOAD_TYPES[mime] ?? [];
  const base = (typeof name === 'string' ? name : '').split(/[\\/]/).pop()!.replace(UNSAFE, '_').replace(/^[. ]+/, '').trim();
  const ext = extensionOf(base);
  const keep = ext !== undefined && exts.includes(ext) ? ext : exts[0];
  const stem = (ext === undefined ? base : base.slice(0, -ext.length - 1)).replace(/[. ]+$/, '');
  if (!keep) return (stem || 'file').slice(0, MAX_NAME);
  return `${(stem || 'file').slice(0, MAX_NAME - keep.length - 1).replace(/[. ]+$/, '') || 'file'}.${keep}`;
}

/** "100 MB", "300 MB" (KB below a megabyte, for small test limits). */
export function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Number(mb.toFixed(1))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Why a file cannot be handed back (empty, too large, a type or extension not allowed), or undefined. */
export function appFileRefusal(file: Pick<FileRef, 'name' | 'mime' | 'size'>, limits: AppUploadLimits = APP_UPLOAD_LIMITS): string | undefined {
  if (!(file.size > 0)) return 'The file is empty.';
  if (file.size > limits.fileBytes) return `Files from a mini-app can be at most ${sizeText(limits.fileBytes)}.`;
  const mime = bareType(String(file.mime ?? ''));
  const ext = extensionOf(String(file.name ?? ''));
  if (!allowed(mime) || !ext || !extensionsOf(mime).includes(ext)) return APP_TYPE_REFUSAL;
  return undefined;
}

/** Why one more file of `size` bytes does not fit the block's totals, or undefined. */
export function appBlockRefusal(stored: { count: number; bytes: number }, size: number, limits: AppUploadLimits = APP_UPLOAD_LIMITS): string | undefined {
  if (stored.count >= limits.filesPerBlock) return `This mini-app already stored ${limits.filesPerBlock} files.`;
  if (stored.bytes + size > limits.blockBytes) return `This mini-app already stored ${sizeText(limits.blockBytes)}.`;
  return undefined;
}

declare module '../api/methods.ts' {
  interface Methods {
    /**
     * X03, 'todo': registers a stored file (files.uploadChunk) as handed back by block (messageId, blockIndex) – an
     * agent's open mini-app to-do (its wf.upload). count and bytes are the block's totals (bytes include files it
     * refused for their type or size; its refusals carry both in details); repeating it changes nothing.
     */
    'blocks.file': { params: { messageId: string; blockIndex: number; fileId: string }; result: { file: FileRef; count: number; bytes: number } };
  }
}
