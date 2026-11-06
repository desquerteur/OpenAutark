// A person's file upload into one of their chats (files.uploadChunk with `conversationId`, people/rpc-work.ts):
// the chunks go through the same chunk sessions as the owner's (rpc/uploads.ts, under <temp>/people) and the
// finished file is recorded in person_uploads, so the person may read and attach it (people/access.ts).
// Owns: that path and the rows. Never: limits beyond the chunk sessions' own.

import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import type { Person } from '../../shared/model/people.ts';
import type { FileRef } from '../../shared/model/system.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { ChunkUploads, safeFileName } from '../rpc/uploads.ts';
import { membership } from './access.ts';

export interface PersonChunk { uploadId: string; index: number; dataBase64: string; final: boolean; name: string; conversationId: string }

const sessions = new WeakMap<object, ChunkUploads>();

/** One chunk of a person's upload into their chat; the final chunk answers the stored file (with their name). */
export async function personUpload(s: RuntimeServices, person: Person, deviceId: string, input: PersonChunk): Promise<{ received: number; file?: FileRef }> {
  const chat = s.chats.get(input.conversationId);
  if (!chat || !membership(s.db, person.id, input.conversationId)) throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId: input.conversationId } });
  let chunks = sessions.get(s);
  if (!chunks) sessions.set(s, (chunks = new ChunkUploads({ temp: path.join(s.paths.temp, 'people'), files: s.files, clock: s.clock, log: s.log })));
  const name = safeFileName(input.name);
  const result = await chunks.chunk({ ...input, name, mime: undefined, owner: `person:${person.id}:${deviceId}` });
  if (!result.file) return result;
  const at = s.clock.now();
  s.db.run(
    `INSERT INTO person_uploads (file_id, person_id, conversation_id, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(person_id, file_id, conversation_id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at`,
    [result.file.id, person.id, input.conversationId, name, result.file.size, at],
  );
  return { received: result.received, file: { ...result.file, name, createdAt: at } };
}

/** The name the person gave a file they uploaded into that chat (undefined = not theirs there). */
export function uploadNameIn(db: Db, personId: string, fileId: string, conversationId: string): string | undefined {
  try {
    return db.get<{ name: string }>('SELECT name FROM person_uploads WHERE person_id = ? AND file_id = ? AND conversation_id = ?', [personId, fileId.toLowerCase(), conversationId])?.name;
  } catch {
    return undefined;
  }
}
