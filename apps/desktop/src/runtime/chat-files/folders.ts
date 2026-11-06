// The mirror's bookkeeping (B-050 K8 a, mirror.ts): which folder under <data>/chats this PC wrote for
// which chat (chat.json's id with a matching id suffix, and no origin or this PC's), chats/README.md,
// and a chat's stamp – what the mirror last wrote must equal it for the chat to be up to date
// (finished messages, newest row, newest seq, newest edit, the chat's update time; kv 'chatMirror').
// Owns: these reads and the README write. Never: writes a chat folder (write.ts) or the database.

import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/database.ts';
import { CHAT_JSON, idSuffix } from './format.ts';
import { CHATS_README } from './readme.ts';
import { writeAtomic } from './write.ts';

/** Chat id → folder name of the folders this PC wrote (a folder from another PC is never touched). */
export async function folderIndex(root: string, self: string | undefined): Promise<Map<string, string>> {
  const folders = new Map<string, string>();
  let names: string[] = [];
  try { names = await readdir(root); } catch { return folders; }
  for (const name of names) {
    if (!/-[a-z0-9]{1,8}$/.test(name)) continue;
    try {
      const file = JSON.parse(await readFile(path.join(root, name, CHAT_JSON), 'utf8')) as { id?: unknown; origin?: { deviceId?: unknown } };
      const origin = file.origin?.deviceId;
      if (typeof file.id === 'string' && name.endsWith(`-${idSuffix(file.id)}`) && (origin === undefined || origin === self)) folders.set(file.id, name);
    } catch { /* not a chat folder of this PC */ }
  }
  return folders;
}

/** chats/README.md, written when its text changed. */
export async function writeReadme(root: string): Promise<void> {
  const file = path.join(root, 'README.md');
  try { if (await readFile(file, 'utf8') === CHATS_README) return; } catch { /* not there yet */ }
  await mkdir(root, { recursive: true });
  await writeAtomic(file, CHATS_README);
}

export function chatStamp(db: Db, chatId: string): string {
  const m = db.get<{ n: number; r: number | null; q: number | null; e: number | null }>(
    `SELECT COUNT(*) AS n, MAX(rowid) AS r, MAX(seq) AS q, MAX(edited_at) AS e FROM messages WHERE conversation_id = ? AND state != 'streaming'`, [chatId],
  );
  const c = db.get<{ u: number }>('SELECT updated_at AS u FROM conversations WHERE id = ?', [chatId]);
  return [m?.n ?? 0, m?.r ?? 0, m?.q ?? 0, m?.e ?? 0, c?.u ?? 0].join(':');
}
