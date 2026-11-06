// Fixture for the media library tests: chat harness + a real blob store in a temp dir wired
// through the media hook to a MediaService (PDF page counter injected), two chats with one
// agent each, and helpers to store files and attach them in a message.
// Owns: fixtures only. Never: imported by production code.

import path from 'node:path';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { withMediaHook } from '../../../src/runtime/media/hook.ts';
import { MediaService } from '../../../src/runtime/media/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { Attachment } from '../../../src/shared/model/chat.ts';
import type { MediaInfo } from '../../../src/shared/model/media.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { agent, harness } from '../chat/harness.ts';
import { tempDir } from '../store/helpers.ts';

export function mediaSetup(options: { pdfPages?: (bytes: Uint8Array) => Promise<number | undefined> } = {}) {
  const h = harness();
  const temp = tempDir();
  const log = new MemoryLogger();
  const blobs = new Blobs({ db: h.db, blobs: path.join(temp.dir, 'blobs'), clock: h.clock, log });
  const media = new MediaService({ services: () => h.services, pdfPages: options.pdfPages ?? (async () => undefined) });
  h.services.files = withMediaHook(blobs, (file) => media.onFileStored(file), log);
  h.org.add(agent('ag_ada', 'Ada'));
  h.org.add(agent('ag_bo', 'Bo'));
  const chat = h.chats.create({ title: 'Brand', agentIds: ['ag_ada'], createdBy: 'human' });
  const other = h.chats.create({ title: 'Ops', agentIds: ['ag_bo'], createdBy: 'human' });
  const put = (bytes: Uint8Array, name: string, mime?: string) => h.services.files.put(bytes, name, mime);
  const attach = (conversationId: string, ...files: FileRef[]) => h.chats.send({
    conversationId, body: 'see attached', authorId: 'human',
    attachments: files.map((file): Attachment => ({ fileId: file.id, name: file.name, mime: file.mime, size: file.size })),
  });
  const upserts = () => h.of('media.upserted') as MediaInfo[];
  return { h, temp, log, media, chat, other, put, attach, upserts };
}
