// RPC handlers: uploads (base64 ≤ 25 MB, chunked ≤ 300 MB, by path for the pane's media tab – on a linked PC when it
// names one, files-path.ts onDevice), file metadata/bytes, and opening files with the OS (owner only).
// Owns: param checks, size caps, the per-runtime chunk-upload sessions, path confinement for
// files.openPath (workspace or data dir, never the CLI account homes; `anywhere`, from the file tab: the whole PC) and named copies of
// blobs for files.open (blobs have no extension, so the OS could not pick an app; bytes still on another of the
// person's PCs are pulled first, and a type without an app here, like an .apk, is shown in its folder instead).
// Never: opens paths outside those roots unasked, opens executables directly (only "show in folder"),
// or reads big files into memory for a client.

import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkforceError } from '../../../shared/errors.ts';
import type { FileRef } from '../../../shared/model/system.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { input, notFound, num, optBool, optNum, optText, text } from '../params.ts';
import { ChunkUploads, base64Length, decodeBase64, safeFileName } from '../uploads.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import { onDevice, PATH_RULE } from './files-path.ts';
import { needBlob } from '../../devices/sync/blobs.ts';

const TODO = { capability: 'todo' } as const;
const INLINE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const READ_DEFAULT_BYTES = 5 * 1024 * 1024;
const READ_MAX_BYTES = 25 * 1024 * 1024;
const OPEN_COPIES_TTL_MS = 24 * 3_600_000;
const SHA256 = /^[a-f0-9]{64}$/;
/** Extensions that run code (or mount/install something) when "opened"; such files are only revealed in their folder. */
const EXECUTABLE = new Set([
  'exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'psc1', 'vb', 'vbs', 'vbe', 'js', 'jse', 'ws', 'wsf', 'wsc', 'wsh',
  'msi', 'msp', 'mst', 'msc', 'scr', 'hta', 'chm', 'cpl', 'lnk', 'pif', 'reg', 'jar', 'jnlp', 'sh', 'bash', 'zsh', 'command',
  'tool', 'terminal', 'app', 'appref-ms', 'url', 'website', 'scf', 'shb', 'shs', 'inf', 'ins', 'isp', 'gadget', 'application',
  'xbap', 'dll', 'ocx', 'sys', 'drv', 'xll', 'py', 'pyw', 'pyz', 'pyc', 'pl', 'rb', 'appx', 'appxbundle', 'msix', 'msixbundle',
  'appinstaller', 'diagcab', 'settingcontent-ms', 'library-ms', 'search-ms', 'searchconnector-ms', 'iso', 'img', 'vhd', 'vhdx',
  'desktop', 'appimage', 'run', 'pkg', 'mpkg', 'dmg', 'workflow', 'action', 'scpt', 'applescript',
]);
const EXTENSION_FOR: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'video/mp4': 'mp4',
  'video/webm': 'webm', 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'text/plain': 'txt',
  'text/markdown': 'md', 'application/json': 'json', 'text/csv': 'csv', 'video/quicktime': 'mov', 'audio/mp4': 'm4a',
};

interface FilesState { uploads?: ChunkUploads; sweptAt: number }
const states = new WeakMap<RuntimeServices, FilesState>();
function state(services: RuntimeServices): FilesState {
  let value = states.get(services);
  if (!value) states.set(services, (value = { sweptAt: Number.NEGATIVE_INFINITY }));
  return value;
}

function uploads(services: RuntimeServices): ChunkUploads {
  const s = state(services);
  s.uploads ??= new ChunkUploads({ temp: services.paths.temp, files: services.files, clock: services.clock, log: services.log });
  return s.uploads;
}

function fileOrThrow(services: RuntimeServices, fileId: string): FileRef {
  if (!SHA256.test(fileId)) throw new WorkforceError('bad_request', 'Invalid parameter "id": expected a file id.', { details: { param: 'id' } });
  return services.files.get(fileId) ?? notFound('File', { id: fileId });
}

function ownerKey(ctx: HandlerContext): string {
  return ctx.scope.kind === 'device' ? `device:${ctx.scope.deviceId}` : ctx.scope.kind;
}

/** Extension of the last path segment; Windows ignores trailing dots/spaces ("setup.exe." runs as setup.exe). */
function extensionOf(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[. ]+$/, '');
  return /\.([A-Za-z0-9_-]{1,32})$/.exec(base)?.[1]?.toLowerCase() ?? '';
}

/** F-52 (people/uploads.ts): a name the OS would run as a program – the same list files.open refuses. */
export function runsCode(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? '';
  return [extensionOf(base), extensionOf(base.split(':')[0])].some((extension) => EXECUTABLE.has(extension));
}

/** Refuses executables; also checks the part before an NTFS stream suffix ("run.bat::$DATA"). */
function refuseExecutable(name: string, reveal: boolean): void {
  if (reveal) return;
  const base = name.split(/[\\/]/).pop() ?? '';
  for (const extension of [extensionOf(base), extensionOf(base.split(':')[0])]) {
    if (EXECUTABLE.has(extension)) {
      throw new WorkforceError('forbidden', 'This file type can run programs. Use "Show in folder" instead.', { details: { extension } });
    }
  }
}

/** macOS `open` runs an extensionless Unix executable in Terminal: such files are only revealed. */
async function refuseExecutableMode(target: string, reveal: boolean): Promise<void> {
  if (reveal || process.platform === 'win32' || extensionOf(target)) return;
  const info = await stat(target).catch(() => undefined);
  if (info?.isFile() && (info.mode & 0o111) !== 0) {
    throw new WorkforceError('forbidden', 'This file can run as a program. Use "Show in folder" instead.');
  }
}

/** True when `target` is `root` or inside it (case-insensitive on Windows via path.relative). */
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function real(value: string): Promise<string> {
  try { return await realpath(value); } catch { return path.resolve(value); }
}

/** Resolves a path for files.openPath: must exist inside workspace or data, not in account homes. */
async function confinedPath(services: RuntimeServices, requested: string, anywhere: boolean): Promise<string> {
  if (!path.isAbsolute(requested)) throw new WorkforceError('bad_request', 'Invalid parameter "path": expected an absolute path.', { details: { param: 'path' } });
  let target: string;
  try { target = await realpath(requested); } catch { throw new WorkforceError('not_found', 'This file no longer exists.'); }
  if (anywhere) return target; // the person's own file tab, which reaches the whole PC (files-path.ts)
  const [workspace, data, accounts] = await Promise.all([real(services.paths.workspace), real(services.paths.data), real(services.paths.accounts)]);
  if (inside(accounts, target)) throw new WorkforceError('forbidden', 'Account folders cannot be opened from here.');
  if (!inside(workspace, target) && !inside(data, target)) throw new WorkforceError('forbidden', 'Only files in the workspace or the app data folder can be opened.');
  return target;
}

/** The name of the named copy: the stored name made safe, plus an extension from the mime type. */
function copyName(file: FileRef): string {
  const name = safeFileName(file.name);
  return !extensionOf(name) && EXTENSION_FOR[file.mime] ? `${name}.${EXTENSION_FOR[file.mime]}` : name;
}

/** A copy of the blob under <temp>/open/<id>/<name> so the OS sees the real name and type. */
async function namedCopy(services: RuntimeServices, file: FileRef, name: string): Promise<string> {
  const root = path.join(services.paths.temp, 'open');
  const dir = path.join(root, file.id.slice(0, 16));
  const target = path.join(dir, name);
  try {
    if ((await stat(target)).size === file.size) return target;
  } catch { /* not copied yet */ }
  // Rows travel between the person's PCs before the bytes (devices/sync/blobs.ts): fetch them like every other reader.
  const blob = services.files.path(file.id);
  if (!(await stat(blob).catch(() => undefined)) && !(await needBlob(services, file.id).catch(() => false))) {
    throw new WorkforceError('unavailable', 'This file is still on your other PC, which is not reachable right now.');
  }
  await mkdir(dir, { recursive: true });
  // A copy (copy-on-write where the file system supports it), never a hard link: an editor
  // saving in place must not change the content-addressed blob.
  await copyFile(blob, target, constants.COPYFILE_FICLONE);
  void sweepOpenCopies(services, root, dir);
  return target;
}

/** Removes named copies older than a day (at most once per hour). */
async function sweepOpenCopies(services: RuntimeServices, root: string, keep: string): Promise<void> {
  const s = state(services);
  const now = Date.now(); // file mtimes are wall-clock times
  if (now - s.sweptAt < 3_600_000) return;
  s.sweptAt = now;
  try {
    for (const entry of await readdir(root)) {
      const dir = path.join(root, entry);
      if (dir === keep) continue;
      const info = await stat(dir).catch(() => undefined);
      if (info && now - info.mtimeMs > OPEN_COPIES_TTL_MS) await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    services.log.debug('open copies cleanup skipped', { error: String(error) });
  }
}

export function register(table: HandlerTable): void {
  table.add('files.upload', async (params, ctx) => {
    const o = input(params);
    const name = text(o, 'name', { max: 200 });
    const dataBase64 = text(o, 'dataBase64', { max: base64Length(INLINE_UPLOAD_MAX_BYTES) + 4, allowEmpty: true });
    const bytes = decodeBase64(dataBase64, 'dataBase64');
    if (bytes.length > INLINE_UPLOAD_MAX_BYTES) throw new WorkforceError('bad_request', 'Files sent this way can be at most 25 MB. Use a chunked upload.');
    return ctx.services.files.put(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), name, optText(o, 'mime', { max: 120 }));
  }, TODO);

  table.add('files.uploadChunk', (params, ctx) => {
    const o = input(params);
    return uploads(ctx.services).chunk({
      uploadId: text(o, 'uploadId', { max: 64 }), index: num(o, 'index', { min: 0, max: 100_000 }),
      dataBase64: text(o, 'dataBase64', { max: base64Length(4 * 1024 * 1024) + 4, allowEmpty: true }),
      final: optBool(o, 'final') ?? false, name: text(o, 'name', { max: 200 }), mime: optText(o, 'mime', { max: 120 }), owner: ownerKey(ctx),
    });
  }, TODO);

  // A media tab by path – on the phone too (its pane is the PC's, on a secure transport like the file tab); B-076:
  // `device` names the linked PC the file is on.
  table.add('files.uploadPath', (params, ctx) => onDevice(ctx, params, 'store', async (o) => {
    const requested = text(o, 'path', { max: 4096 });
    if (!path.isAbsolute(requested)) throw new WorkforceError('bad_request', 'Invalid parameter "path": expected an absolute path.', { details: { param: 'path' } });
    return ctx.services.files.putPath(requested);
  }) as Promise<FileRef>, PATH_RULE);

  table.add('files.get', (params, ctx) => fileOrThrow(ctx.services, text(input(params), 'id', { max: 64 })), TODO);

  table.add('files.read', async (params, ctx) => {
    const o = input(params);
    const file = fileOrThrow(ctx.services, text(o, 'id', { max: 64 }));
    const maxBytes = optNum(o, 'maxBytes', { min: 1, max: READ_MAX_BYTES }) ?? READ_DEFAULT_BYTES;
    if (file.size > maxBytes) {
      throw new WorkforceError('bad_request', 'This file is too large to send here.', { details: { size: file.size, maxBytes } });
    }
    const bytes = await ctx.services.files.read(file.id);
    return { dataBase64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'), mime: file.mime };
  }, TODO);

  table.add('files.open', async (params, ctx) => {
    const o = input(params);
    const file = fileOrThrow(ctx.services, text(o, 'id', { max: 64 }));
    const name = copyName(file);
    // APKs go to a phone. Windows reports success even when it merely opens its app chooser.
    const reveal = (optBool(o, 'reveal') ?? false) || extensionOf(name) === 'apk';
    // Both names are checked: the OS acts on the copy's name, which safeFileName may have changed.
    refuseExecutable(file.name, reveal);
    refuseExecutable(name, reveal);
    const copy = await namedCopy(ctx.services, file, name);
    try {
      await ctx.services.host.openPath(copy, reveal);
    } catch (error) {
      // No app for this type here (an .apk on Windows): the file in its folder, ready to copy or send on.
      if (reveal) throw error;
      await ctx.services.host.openPath(copy, true);
    }
    return { ok: true };
  });

  table.add('files.openPath', async (params, ctx) => {
    const o = input(params);
    const reveal = optBool(o, 'reveal') ?? false;
    const target = await confinedPath(ctx.services, text(o, 'path', { max: 4096 }), optBool(o, 'anywhere') ?? false);
    refuseExecutable(target, reveal);
    await refuseExecutableMode(target, reveal);
    await ctx.services.host.openPath(target, reveal);
    return { ok: true };
  });
}
