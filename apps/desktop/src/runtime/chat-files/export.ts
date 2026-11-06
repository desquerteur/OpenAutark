// chats.export (B-050 K8 b): the chosen chats as chat folders (format.ts) written fresh from the
// database – not copied from the mirror – plus every file their messages attach as files/<sha256>,
// into `dir` or <data>/exports/chats-<time>/. Owner only (a folder of this PC); the people's own chats
// are refused like everywhere else for the owner.
// Owns: the export folder and its counts. Never: writes the database or the mirror.

import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices } from '../contracts.ts';
import { notFound } from '../rpc/params.ts';
import { chatFile, chatFileText, chatFolderName, FILES_DIR } from './format.ts';
import { memberNamer } from './names.ts';
import { shardSource, writeAllMonths, writeChatJson } from './write.ts';

export interface ChatExport {
  dir: string;
  chats: number;
  messages: number;
  files: number;
}

type Services = Pick<RuntimeServices, 'db' | 'chats' | 'files' | 'clock' | 'paths'> & Partial<Pick<RuntimeServices, 'devices' | 'secrets' | 'settings' | 'org' | 'people'>>;

/** A new folder under <data>/exports named after the time (a suffix when taken). */
async function defaultDir(s: Services): Promise<string> {
  const stamp = new Date(s.clock.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const base = path.join(s.paths.data, 'exports', `chats-${stamp}`);
  for (let n = 1; n < 100; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    try { await stat(dir); } catch { return dir; }
  }
  throw new WorkforceError('conflict', 'Too many exports in this minute. Try again shortly.');
}

export async function exportChats(s: Services, input: { conversationIds: readonly string[]; dir?: string }): Promise<ChatExport> {
  const chats = input.conversationIds.map((id) => {
    const chat = s.chats.get(id) ?? notFound('Chat', { conversationId: id });
    return chat;
  });
  const dir = input.dir ?? await defaultDir(s);
  await mkdir(dir, { recursive: true });
  const src = shardSource(s);
  const nameOf = src.nameOf;
  const fileIds = new Set<string>();
  let messages = 0;
  for (const chat of chats) {
    const file = chatFile(s, chat, nameOf);
    const folder = path.join(dir, chatFolderName(file));
    await writeChatJson(folder, chatFileText(file));
    const written = await writeAllMonths(src, folder, chat.id);
    messages += written.lines;
    for (const id of written.files) fileIds.add(id);
  }
  let files = 0;
  for (const id of fileIds) {
    if (!/^[0-9a-f]{64}$/.test(id) || !s.files.get(id)) continue; // a file the store no longer has stays a reference
    await mkdir(path.join(dir, FILES_DIR), { recursive: true });
    await copyFile(s.files.path(id), path.join(dir, FILES_DIR, id));
    files++;
  }
  return { dir, chats: chats.length, messages, files };
}
