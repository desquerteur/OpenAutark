// File writes of the chat folders (B-050 K8, format.ts): chat.json when its text changed (the folder
// moved when its name changed), a month shard written whole from the database (paged, into a temp file
// that is then renamed over the shard, so a reader never sees half a file and a deleted text is really
// gone), every month of a chat, appended lines, the shard that holds a message – and the reads they
// need (messages by id; names and redaction: shardSource; whether a folder or shard is there).
// The agents' change notices ("Message #12 was edited", shared/model/message-changes.ts isAgentNotice) are never
// written: they tell the agents' sessions on this PC what changed, every view of the person leaves them out, and
// after an import they would turn into plain notes with another PC's seq numbers (B-050 live test, 28.10.).
// Owns: these file operations. Never: decides what to write (mirror.ts, export.ts) or writes the database.

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '../../shared/model/chat.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';
import { toMessage } from '../chat/message-repo.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { CHAT_JSON, MESSAGES_DIR, isMonthFile, lineNeedle, messageLine, monthBounds } from './format.ts';
import { memberNamer, type NameOf } from './names.ts';

/** Messages read from the database at once while a shard is written. */
const PAGE = 500;

/** What a shard is written from. */
export interface ShardSource {
  db: Db;
  nameOf: NameOf;
  redact: (text: string) => string;
}

/** Names looked up fresh, bodies through the vault's redaction. */
export function shardSource(s: Pick<RuntimeServices, 'db'> & Partial<Pick<RuntimeServices, 'secrets' | 'settings' | 'org' | 'people'>>): ShardSource {
  return { db: s.db, nameOf: memberNamer(s), redact: (text) => { try { return s.secrets?.redact(text) ?? text; } catch { return text; } } };
}

/** Messages by id, in seq order. */
export function messagesById(db: Db, ids: readonly string[]): Message[] {
  if (!ids.length) return [];
  return db.all<Record<string, unknown>>(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY seq`, [...ids]).map(toMessage);
}

const tempOf = (file: string) => `${file}.${randomBytes(4).toString('hex')}.tmp`;

export async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = tempOf(file);
  try {
    await writeFile(temp, text);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Writes chat.json when its text changed; true when written. */
export async function writeChatJson(folder: string, text: string): Promise<boolean> {
  const file = path.join(folder, CHAT_JSON);
  try { if (await readFile(file, 'utf8') === text) return false; } catch { /* not there yet */ }
  await mkdir(folder, { recursive: true });
  await writeAtomic(file, text);
  return true;
}

/** chat.json in the folder `name` under root, the folder moved from `before` when its name changed; the folder's path. */
export async function placeChat(root: string, before: string | undefined, name: string, text: string): Promise<string> {
  if (before && before !== name) {
    await rm(path.join(root, name), { recursive: true, force: true });
    try { await rename(path.join(root, before), path.join(root, name)); } catch { /* gone: written anew below */ }
  }
  const folder = path.join(root, name);
  await writeChatJson(folder, text);
  return folder;
}

/** The month shards of a chat folder ('YYYY-MM.jsonl'), oldest first. */
export async function shardNames(folder: string): Promise<string[]> {
  try {
    return (await readdir(path.join(folder, MESSAGES_DIR))).filter(isMonthFile).sort();
  } catch {
    return [];
  }
}

/**
 * Writes one month of the chat from the database (finished, failed and stopped messages by seq);
 * a month without messages loses its shard. Returns the line count and the attached file ids.
 */
export async function writeMonth(src: ShardSource, folder: string, chatId: string, month: string): Promise<{ lines: number; files: string[] }> {
  const [from, to] = monthBounds(month);
  const dir = path.join(folder, MESSAGES_DIR);
  const file = path.join(dir, `${month}.jsonl`);
  await mkdir(dir, { recursive: true });
  const temp = tempOf(file);
  const handle = await open(temp, 'w');
  const files = new Set<string>();
  let lines = 0;
  try {
    for (let after = -1; ;) {
      const page = src.db.all<Record<string, unknown>>(
        `SELECT * FROM messages WHERE conversation_id = ? AND state != 'streaming' AND created_at >= ? AND created_at < ? AND seq > ? ORDER BY seq LIMIT ${PAGE}`,
        [chatId, from, to, after],
      ).map(toMessage);
      if (!page.length) break;
      const kept = page.filter((message) => !isAgentNotice(message)); // agents' change notices: see the header
      if (kept.length) await handle.write(`${kept.map((message) => JSON.stringify(messageLine(message, src.nameOf, src.redact))).join('\n')}\n`);
      for (const message of kept) for (const attachment of message.attachments) files.add(attachment.fileId);
      lines += kept.length;
      after = page[page.length - 1].seq;
      if (page.length < PAGE) break;
    }
    await handle.close();
    if (lines) await rename(temp, file);
    else await Promise.all([rm(temp, { force: true }), rm(file, { force: true })]);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw error;
  }
  return { lines, files: [...files] };
}

/** Every month of the chat from the database; shards of months without messages go. */
export async function writeAllMonths(src: ShardSource, folder: string, chatId: string): Promise<{ lines: number; files: string[] }> {
  const months = src.db.all<{ month: string }>(
    `SELECT DISTINCT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month FROM messages WHERE conversation_id = ? AND state != 'streaming' ORDER BY month`,
    [chatId],
  ).map((row) => row.month).filter((month) => /^\d{4}-\d{2}$/.test(month));
  const files = new Set<string>();
  let lines = 0;
  for (const month of months) {
    const written = await writeMonth(src, folder, chatId, month);
    lines += written.lines;
    for (const id of written.files) files.add(id);
  }
  const wanted = new Set(months.map((month) => `${month}.jsonl`));
  for (const name of await shardNames(folder)) if (!wanted.has(name)) await rm(path.join(folder, MESSAGES_DIR, name), { force: true });
  return { lines, files: [...files] };
}

/** True when the file or folder is there. */
export function isThere(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

export function shardFile(folder: string, month: string): string {
  return path.join(folder, MESSAGES_DIR, `${month}.jsonl`);
}

/** Appends lines (JSON texts) to a month shard. */
export async function appendLines(folder: string, month: string, texts: readonly string[]): Promise<void> {
  if (!texts.length) return;
  const dir = path.join(folder, MESSAGES_DIR);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${month}.jsonl`), `${texts.join('\n')}\n`);
}

/** The month whose shard holds the message (newest shards first); undefined when none does. */
export async function shardHolding(folder: string, messageId: string): Promise<string | undefined> {
  const needle = lineNeedle(messageId);
  for (const name of (await shardNames(folder)).reverse()) {
    let text: string;
    try { text = await readFile(path.join(folder, MESSAGES_DIR, name), 'utf8'); } catch { continue; }
    if (text.includes(needle)) return name.slice(0, 7);
  }
  return undefined;
}
