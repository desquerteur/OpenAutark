// A file, folder or media tab that came from another of the CEO's PCs reads and writes there (B-076, mesh method
// 'files.path', the way computer.preview asks a linked PC): files.readPath / writePath / listPath and the media tab's
// files.uploadPath name that PC in `device`, and this PC asks it – when its link is down at once "<name> is offline",
// so the tab says so calmly and its next look tries again. The other PC answers with its own file-tab rules
// (rpc/handlers/files-path.ts PATH_OPS – a stamp conflict stays a conflict). A media file it stores ('store') comes back
// with its `files` row, which this PC takes like a synced row (rows.ts); the bytes follow when first shown (blobs.ts
// needBlob pulls them from there). One mesh frame holds at most 8 MiB (channel.ts) and a larger one closes the whole
// link, so a save that cannot fit stays here with a clear answer, and a read whose text would not fit answers 'large'.
// Owns: this forwarding and the peer method. Never: answers a PC that is no 'ceo' link, passes a request on to a third
// PC, or logs a path or a file's content.

import path from 'node:path';
import { WorkforceError } from '../../../shared/errors.ts';
import type { FileRef } from '../../../shared/model/system.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { DevicesRepo } from '../repo.ts';
import { linkOf } from './home.ts';
import type { RowSync } from './rows.ts';

export type PathOp = 'read' | 'write' | 'list' | 'store';
type Obj = Record<string, unknown>;
/** This PC's own operations on checked parameters (files-path.ts PATH_OPS). */
export type PathOps = Record<'read' | 'write' | 'list', (o: Obj) => Promise<unknown>>;

const plain = (value: unknown): value is Obj => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** What a request or an answer between PCs may hold, under the mesh's 8 MiB frame (channel.ts) with room for the rest. */
const FRAME_ROOM = 7 * 1024 * 1024;
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

export class RemotePaths {
  private readonly s: RuntimeServices;
  private readonly rows: RowSync;
  private readonly ops: PathOps;

  constructor(s: RuntimeServices, rows: RowSync, ops: PathOps) {
    this.s = s;
    this.rows = rows;
    this.ops = ops;
    hubs.set(s, this);
  }

  /** Runs `op` on linked CEO PC `device` (parameters without `device`); a media file stored there arrives with its row. */
  async forward(device: string, op: PathOp, params: Obj): Promise<unknown> {
    const record = new DevicesRepo(this.s.db).get(device);
    if (!record || linkOf(record)?.kind !== 'ceo') throw new WorkforceError('not_found', 'That PC is not linked here.', { details: { deviceId: device } });
    if (!this.s.devices.online(device)) throw new WorkforceError('unavailable', `${record.name} is offline.`, { details: { deviceId: device, reachable: false } });
    if (op === 'write' && bytesOf(params) > FRAME_ROOM) throw new WorkforceError('bad_request', `This text is too large to save on ${record.name} (about 7 MB at most between PCs).`, { details: { deviceId: device } });
    const answer = await this.s.devices.call(device, 'files.path', { ...params, op });
    if (op !== 'store') return answer;
    const { ref, item } = (plain(answer) ? answer : {}) as { ref?: FileRef; item?: unknown };
    if (!ref) throw new WorkforceError('unavailable', `${record.name} did not send the file.`);
    if (item) await this.rows.receive({ items: [item] }, device).catch((error: unknown) => this.s.log.info('stored file row not taken', { id: ref.id, error: String((error as Error)?.message ?? error) }));
    return ref;
  }

  /** 'files.path' from a CEO PC: the operation here. */
  async serve(params: unknown, from: string): Promise<unknown> {
    if (linkOf(new DevicesRepo(this.s.db).get(from))?.kind !== 'ceo') throw new WorkforceError('forbidden', 'Files are read only for the CEO\'s own PCs.');
    const { op, ...rest } = plain(params) ? params : {};
    if (op === 'read') {
      const answer = await this.ops.read(rest);
      if (!plain(answer) || bytesOf(answer) <= FRAME_ROOM) return answer;
      const { text: _text, ...facts } = answer;
      return { ...facts, state: 'large' };
    }
    if (op === 'write' || op === 'list') return this.ops[op](rest);
    if (op !== 'store') throw new WorkforceError('bad_request', 'Unknown file request.');
    if (Object.keys(rest).some((key) => key !== 'path') || typeof rest.path !== 'string' || !path.isAbsolute(rest.path)) throw new WorkforceError('bad_request', 'A stored file needs its absolute path.');
    const ref = await this.s.files.putPath(rest.path);
    return { ref, item: this.rows.fileItem(ref.id) };
  }
}

const hubs = new WeakMap<object, RemotePaths>();

/** This runtime's forwarding (made by the sync, devices/sync/service.ts). */
export function remotePathsOf(s: object): RemotePaths {
  const hub = hubs.get(s);
  if (!hub) throw new WorkforceError('unavailable', 'Linked PCs are not available in this runtime.');
  return hub;
}
