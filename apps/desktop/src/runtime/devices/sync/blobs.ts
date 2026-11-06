// Stored files (attachments, avatars: <blobs>/ab/cd/<sha256>) between the CEO's own PCs: their `files` rows travel
// as rows (tables.ts), the bytes when they are first needed – a reader that finds a blob missing awaits needBlob(),
// which pulls it by its sha from an online CEO PC (op 'blob' of 'sync.file', files.ts) into <blobs>/tmp (mode 0600),
// checks the hash and puts it in place. One pull per blob at a time; false when no CEO PC had it.
// Owns: these pulls and the pieces this PC serves. Never: serves a blob without its files row, asks a PC that is no
// 'ceo' link, passes a request on to a third PC, or logs content.

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeServices } from '../../contracts.ts';
import { hashFile, pullPieces, readPiece, replaceWith, type Piece } from './file-io.ts';
import { links } from './home.ts';

const SHA256 = /^[a-f0-9]{64}$/;
/** Running pulls by blob path (one data folder per runtime, so one entry per blob). */
const pulling = new Map<string, Promise<boolean>>();

export type BlobServices = Pick<RuntimeServices, 'db' | 'files' | 'devices' | 'log' | 'paths'>;

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

/** A piece of a blob this PC has (its files row and its bytes); undefined: not here. */
export async function blobPiece(s: Pick<RuntimeServices, 'files'>, id: string, offset: number): Promise<Piece | undefined> {
  if (!SHA256.test(id) || !s.files.get(id)) return undefined;
  return readPiece(s.files.path(id), offset);
}

/** Makes sure the bytes of stored file `id` are here: true when they are (now). */
export function needBlob(s: BlobServices, id: string): Promise<boolean> {
  if (!SHA256.test(id)) return Promise.resolve(false);
  const file = s.files.path(id);
  let running = pulling.get(file);
  if (!running) {
    running = pull(s, id, file).finally(() => pulling.delete(file));
    pulling.set(file, running);
  }
  return running;
}

async function pull(s: BlobServices, id: string, file: string): Promise<boolean> {
  if ((await lstat(file).catch(() => undefined))?.isFile()) return true;
  const peers = links(s.db).filter(({ record, link }) => link.kind === 'ceo' && s.devices.online(record.id)).map(({ record }) => record.id);
  for (const peer of peers) {
    const temp = path.join(s.paths.blobs, 'tmp', `${randomUUID()}.part`); // a crash leaves it to the blob clean-up
    try {
      await mkdir(path.dirname(temp), { recursive: true });
      await pullPieces(temp, (offset) => s.devices.call(peer, 'sync.file', { op: 'blob', id, offset }));
      if (await hashFile(temp) !== id) throw new Error('other bytes arrived');
      await mkdir(path.dirname(file), { recursive: true });
      await replaceWith(temp, file);
      return true;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      s.log.info('stored file not pulled', { id, peer, error: errorText(error) });
    }
  }
  return false;
}
