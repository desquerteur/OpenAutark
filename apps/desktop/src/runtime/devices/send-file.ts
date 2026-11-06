// devices.send_file: a file goes to another linked PC over the mesh's RPC, one piece at a time, and lands in inbox/<sending PC>/ of
// that PC's workspace under a free name. The tool is a remote one, so `device` picks the PC the file lies on: with
// `device: "Tower", to: "<this PC's name>"` a file comes from Tower to here ("this" there would mean Tower itself).
// Owns: this tool and the receiving peer method 'files.put'. Never: overwrites a file, or keeps a partial one after a stop.

import { randomUUID } from 'node:crypto';
import { open, rename, rm, stat, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices } from '../contracts.ts';
import { decodeBase64 } from '../rpc/uploads.ts';
import { readPath } from '../tools/builtin/files.ts';
import { clip, defineTool } from '../tools/builtin/util.ts';
import { resolveDevice } from '../tools/placement.ts';
import { failure, json } from '../tools/types.ts';

/** A piece's base64 stays well under the channel's frame limit (8 MiB, channel.ts). */
const PIECE_BYTES = 1024 * 1024; // B-077: 1 MiB, so the link's keepalive pings never wait long behind one piece
const ID = /^[0-9a-f-]{36}$/;

const clean = (name: string, fallback: string): string => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120) || fallback;

/** `name` in `dir`, or the first free "name (2).ext". */
async function freeName(dir: string, name: string): Promise<string> {
  const { name: stem, ext } = path.parse(name);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!await stat(candidate).catch(() => undefined)) return candidate;
  }
}

/** The peer method: one piece of a file from a linked PC; the last one puts the file in place. */
export async function receivePiece(services: RuntimeServices, params: unknown, fromDeviceId: string): Promise<{ ok: true; path?: string }> {
  const p = (params ?? {}) as { id?: unknown; name?: unknown; offset?: unknown; dataBase64?: unknown; last?: unknown; abort?: unknown };
  if (typeof p.id !== 'string' || !ID.test(p.id)) throw new WorkforceError('bad_request', 'A file piece needs its transfer id.');
  let from = 'linked PC';
  try { from = services.devices.list().find((device) => device.id === fromDeviceId)?.name ?? from; } catch { /* unnamed */ }
  const dir = path.join(services.paths.workspace, 'inbox', clean(from, 'linked PC'));
  const part = path.join(dir, `.${p.id}.part`);
  if (p.abort === true) { await rm(part, { force: true }); return { ok: true }; }
  if (typeof p.name !== 'string' || typeof p.dataBase64 !== 'string' || typeof p.offset !== 'number') throw new WorkforceError('bad_request', 'A file piece needs name, offset and dataBase64.');
  await mkdir(dir, { recursive: true });
  const have = (await stat(part).catch(() => undefined))?.size ?? 0;
  if (have !== p.offset) throw new WorkforceError('conflict', `This file piece does not follow the last one (${have} bytes so far).`);
  await appendFile(part, decodeBase64(p.dataBase64, 'dataBase64'));
  if (p.last !== true) return { ok: true };
  const target = await freeName(dir, clean(p.name, 'file'));
  await rename(part, target);
  return { ok: true, path: target };
}

export const sendFile = defineTool<{ to: string; path: string }>({
  name: 'devices.send_file',
  description: "Send a file to a linked PC: it lands in inbox/<this PC>/ of that PC's workspace and the answer names the path. to: a name or id from devices.list. To bring a file here from a linked PC, pass device: that PC and to: this PC's name.",
  inputSchema: { type: 'object', properties: { to: { type: 'string', minLength: 1, maxLength: 120 }, path: { type: 'string', minLength: 1, maxLength: 1024 } }, required: ['to', 'path'], additionalProperties: false },
  category: 'write_local', remote: true, anyMode: true,
  describe: (args) => ({ summary: `Send ${clip(args.path, 80)} to ${clip(args.to, 40)}`, resource: args.path, reversible: true, external: false }),
  async run(args, ctx) {
    const target = resolveDevice(ctx.services, args.to);
    if ('error' in target) return failure(target.error);
    if (target.self || !target.id) return failure(`${target.name} is the PC the file already lies on.`);
    const file = await readPath(ctx, args.path);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return failure(`There is no file at ${args.path}.`);
    const id = randomUUID();
    const name = path.basename(file);
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(PIECE_BYTES);
      let offset = 0;
      for (;;) {
        ctx.signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, PIECE_BYTES, offset);
        const last = offset + bytesRead >= info.size;
        const answer = await ctx.services.devices.call(target.id, 'files.put', { id, name, offset, dataBase64: buffer.subarray(0, bytesRead).toString('base64'), last }, ctx.signal) as { path?: string };
        offset += bytesRead;
        if (last) return json({ ok: true, sentTo: target.name, path: answer.path, bytes: offset });
        if (!bytesRead) throw new WorkforceError('conflict', 'The file got shorter while it was being sent.');
      }
    } catch (error) {
      await ctx.services.devices.call(target.id, 'files.put', { id, abort: true }).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
  },
});
