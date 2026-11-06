// Host side of wf.upload (X03): an agent's to-do mini-app hands a recording, an image or a
// document back to its agent. The frame posts the Blob itself (a structured-clone handle). Before
// any byte is stored this checks: a to-do app, a Blob, an allowed type (the name gets a matching
// extension), at most 100 MB, at most 10 files and 300 MB per block, one file at a time per block,
// fewer than three refused files. Then it stores the file in chunks (deps.upload:
// files.uploadChunk) and registers it for the block (deps.register: blocks.file, where the runtime
// checks the stored file again; a registration the lost connection cut off is sent once more
// when it is back – blocks.file repeats harmlessly). A file the runtime refuses was stored for
// nothing: it counts against the block's bytes (the runtime's totals when the refusal names them),
// so an app cannot loop refused uploads past the cap. The app gets {fileId, name, mime, size}
// only. No extra dialog: the app shows its own saving state.
// Wired by app-tools.ts; pure apart from the injected calls.
// Owns: those checks and this window's per-block counters. Never: reads the bytes, gives the app
// a path, or treats an upload as consent (it is a "via mini-app" call like any other).

import type { ParamsOf, ResultOf } from '../../shared/api/methods.ts';
import { appBlockRefusal, appFileRefusal, appUploadMime, appUploadName } from '../../shared/blocks/app-files.ts';
import { blockKey } from '../../shared/blocks/parse.ts';
import type { FileRef } from '../../shared/model/system.ts';
import { toolError, toolResult, type BridgeResult } from './app-host.ts';

export interface AppUploadDeps {
  /** Stores the blob (ui/lib/files.ts uploadBlob). */
  upload(blob: Blob, name: string): Promise<FileRef>;
  /** Registers the stored file for the block (blocks.file). */
  register(params: ParamsOf<'blocks.file'>): Promise<ResultOf<'blocks.file'>>;
}

/** Refused files after which a block stores nothing more in this window. */
export const MAX_REFUSED = 3;
export const REFUSED_TEXT = 'This mini-app\'s files were refused too often.';

interface BlockUploads { count: number; bytes: number; busy: boolean; refused: number }

/** Per block key: what the runtime last reported stored, whether a file is on its way, how many were refused. */
const blocks = new Map<string, BlockUploads>();

function message(error: unknown): string {
  const text = (error as { message?: unknown } | null)?.message;
  return typeof text === 'string' && text.trim() ? text : 'The file could not be stored.';
}

/** The block's totals a refusal of blocks.file names in its details (RpcError.data), if any. */
function totalsOf(error: unknown): { count: number; bytes: number } | undefined {
  const details = (error as { data?: { details?: { count?: unknown; bytes?: unknown } } } | null)?.data?.details;
  const { count, bytes } = details ?? {};
  return typeof count === 'number' && Number.isFinite(count) && typeof bytes === 'number' && Number.isFinite(bytes) ? { count, bytes } : undefined;
}

/** blocks.file; when the connection was lost on the way, once more (rpc sends it when the connection is back). */
async function register(deps: AppUploadDeps, params: ParamsOf<'blocks.file'>): Promise<ResultOf<'blocks.file'>> {
  try {
    return await deps.register(params);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'unavailable') throw error;
    return deps.register(params);
  }
}

/** One wf_upload call of the app of block (messageId, index). */
export async function appUpload(block: { messageId: string; index: number; todo: boolean }, args: Record<string, unknown>, deps: AppUploadDeps): Promise<BridgeResult> {
  if (!block.todo) return toolError('This app is not a to-do.');
  const data = args.data;
  if (typeof Blob === 'undefined' || !(data instanceof Blob)) return toolError('wf.upload needs a Blob or bytes.');
  const mime = appUploadMime(data.type, typeof args.name === 'string' ? args.name : undefined) ?? '';
  const name = appUploadName(args.name, mime);
  const refusal = appFileRefusal({ name, mime, size: data.size });
  if (refusal) return toolError(refusal);
  const key = blockKey(block.messageId, block.index);
  const state = blocks.get(key) ?? { count: 0, bytes: 0, busy: false, refused: 0 };
  if (state.busy) return toolError('Another file of this app is still being stored.');
  if (state.refused >= MAX_REFUSED) return toolError(REFUSED_TEXT);
  const over = appBlockRefusal(state, data.size);
  if (over) return toolError(over);
  state.busy = true;
  blocks.set(key, state);
  try {
    let ref: FileRef;
    try { ref = await deps.upload(new Blob([data], { type: mime }), name); } catch (error) { return toolError(message(error)); }
    try {
      const stored = await register(deps, { messageId: block.messageId, blockIndex: block.index, fileId: ref.id });
      state.count = stored.count;
      state.bytes = stored.bytes;
      const { file } = stored;
      return toolResult({ fileId: file.id, name: file.name, mime: file.mime, size: file.size });
    } catch (error) {
      const totals = totalsOf(error);
      state.refused += 1;
      if (totals) Object.assign(state, totals);
      else state.bytes += data.size;
      return toolError(message(error));
    }
  } finally {
    state.busy = false;
  }
}

/** Forgets every block's counters (tests). */
export function resetAppUploads(): void {
  blocks.clear();
}
