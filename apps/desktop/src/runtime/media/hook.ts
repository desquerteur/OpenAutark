// FileStore decorator that tells the media library about every stored file. The composition
// root wraps the blob store with it, so all uploads (files.upload, chunked uploads, uploadPath,
// agent outputs, legacy import) reach MediaService.onFileStored without touching FileStore.
// Owns: the "after put/putPath" notification and isolating its failures.
// Never: changes what put/putPath store or return, delays them on media work, or lets a media
// error fail an upload.

import type { FileRef } from '../../shared/model/system.ts';
import type { FileStore, Logger } from '../contracts.ts';

export type FileStoredListener = (file: FileRef) => void;

/** The same store (same object, same behaviour) whose put/putPath also notify `onStored`. */
export function withMediaHook(files: FileStore, onStored: FileStoredListener, log: Logger): FileStore {
  const notify = (file: FileRef): FileRef => {
    try { onStored(file); } catch (error) { log.warn('media hook failed', { id: file.id, error: String(error) }); }
    return file;
  };
  const put = files.put.bind(files);
  const putPath = files.putPath.bind(files);
  files.put = async (data, name, mime) => notify(await put(data, name, mime));
  files.putPath = async (source, mime) => notify(await putPath(source, mime));
  return files;
}
