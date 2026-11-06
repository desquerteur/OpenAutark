// Files in a to-do answer (F06): the record widget answers {file}, upload {files: [...]}, a
// form the values of its upload fields (kind 'file' or 'upload': one id or a list) – each a
// stored file id. Ids the file store does not know are dropped quietly; the rest become the
// attachments of the person's answer line (the chat shows them, the media library links them to
// the chat and an agent's context names them "stored at <path>"), so the agent can use the
// recording or upload right away. A to-do without a chat has no line: its author's wake note
// carries the answer with one "path: …" line per file instead.
// A mini-app to-do's answer (X03) attaches only the files registered for its block through the
// app's wf.upload (tasks/app-files.ts): the ones its data names anywhere, or all of them when it
// names none – an id that is not registered for the block is never attached or given a path.
// Owns: that collection, the names the person's line gives those files and the path lines.
// Never: reads file bytes, takes a name or size from the client (they come from the store), takes
// a type from it except a recording's own audio/… or video/… base type (checked whole, B-076), or
// throws for an unknown id.

import { appWidgetOf } from '../../shared/blocks/app-todo.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { FileRepo } from '../store/files.ts';
import { appAnswerFileIds, appFileIds } from './app-files.ts';

/** At most this many files of one answer are attached (like a chat message). */
export const MAX_ANSWER_FILES = 20;
const FILE_ID = /^[a-f0-9]{64}$/;
const UPLOAD_FIELDS = new Set(['file', 'upload']);

export type AnswerFileDeps = { db: Db } & Partial<Pick<RuntimeServices, 'files' | 'log'>>;

/** A stored file of an answer: the receipt attachment and its blob path (when the store is wired). */
export interface AnswerFile {
  attachment: Attachment;
  path?: string;
}

const ids = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string' && FILE_ID.test(item));

/** File ids an answer names: `file`, `files`, and a form's upload fields (`widget.fields` kind file/upload). */
export function answerFileIds(answer: unknown, widget?: { type?: string; fields?: unknown }): string[] {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return [];
  const a = answer as Record<string, unknown>;
  const found = [...ids(a.file), ...ids(a.files)];
  const values = a.values && typeof a.values === 'object' ? a.values as Record<string, unknown> : undefined;
  if (values && widget?.type === 'form' && Array.isArray(widget.fields)) {
    for (const field of widget.fields as Array<Record<string, unknown> | null>) {
      if (field && typeof field.name === 'string' && UPLOAD_FIELDS.has(String(field.kind))) found.push(...ids(values[field.name]));
    }
  }
  return [...new Set(found)].slice(0, MAX_ANSWER_FILES);
}

/** The answer's stored files; unknown ids are dropped (a mini-app's: only its registered ones). */
export function answerFiles(s: AnswerFileDeps, answer: unknown, widget?: { type?: string; fields?: unknown }): AnswerFile[] {
  const app = appWidgetOf(widget);
  const wanted = app ? appAnswerFileIds(answer, appFileIds(s.db, app.messageId, app.index)).slice(0, MAX_ANSWER_FILES) : answerFileIds(answer, widget);
  if (!wanted.length) return [];
  const repo = new FileRepo(s.db);
  const out: AnswerFile[] = [];
  for (const id of wanted) {
    let ref;
    try { ref = s.files ? s.files.get(id) : repo.get(id); } catch { ref = undefined; }
    if (!ref) continue;
    // A recording's answer names what it is (audio/…, video/…); the store's guess from the bytes may only be a general type.
    // Only its base type, checked whole ("audio/webm;codecs=opus" → "audio/webm"): the type is printed into the agent's context.
    const raw = widget?.type === 'record' && typeof (answer as { mime?: unknown }).mime === 'string' ? (answer as { mime: string }).mime : '';
    const said = raw.split(';')[0]!.trim().toLowerCase();
    const mime = /^(audio|video)\/[a-z0-9.+-]{1,100}$/.test(said) && !/^(audio|video)\//.test(ref.mime) ? said : ref.mime;
    const attachment: Attachment = { fileId: ref.id, name: ref.name, mime, size: ref.size };
    if (ref.width !== undefined) attachment.width = ref.width;
    if (ref.height !== undefined) attachment.height = ref.height;
    if (ref.durationMs !== undefined) attachment.durationMs = ref.durationMs;
    let where: string | undefined;
    try { where = s.files?.path(ref.id); } catch (error) { s.log?.debug('answer file path unavailable', { fileId: ref.id, error: String(error) }); }
    out.push(where ? { attachment, path: where } : { attachment });
  }
  return out;
}

/** The stored names of the answer's files by id (shared/blocks/answer-text.ts FileNames): only files that are attached. */
export function fileNames(files: readonly AnswerFile[]): (fileId: string) => string | undefined {
  const byId = new Map(files.map((file) => [file.attachment.fileId, file.attachment.name]));
  return (fileId) => byId.get(fileId);
}

/** The person's line followed by one "path: …" line per stored file (a chat-free to-do's wake note). */
export function answerLines(text: string, files: readonly AnswerFile[] = []): string {
  const paths = files.filter((file) => file.path).map((file) => `path: ${file.path} (${file.attachment.name}, ${file.attachment.mime})`);
  return [text, ...paths].filter(Boolean).join('\n');
}
