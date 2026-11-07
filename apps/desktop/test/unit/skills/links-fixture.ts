// Fixtures for the skill-link tests (AF-007): a ZIP writer with Unix modes, flags, claimed sizes and an archive comment
// (git archive's commit id), a fake fetch that answers from a table (every other address is a 404, nothing reaches the
// network) and a skill library in a temp folder. No binary fixture files: every test builds the bytes it needs.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import type { LinkFetch } from '../../../src/runtime/skills/links/fetch.ts';

export interface Entry { name: string; data?: string | Buffer; mode?: number; store?: boolean; flags?: number; claimSize?: number }

/** A ZIP of `entries` (deflated unless `store`; `mode`: a Unix mode in the external attributes). */
export function zip(entries: readonly Entry[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const body = entry.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0x800, 6);
    local.writeUInt16LE(entry.store ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.claimSize ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0x800, 8);
    central.writeUInt16LE(entry.store ? 0 : 8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.claimSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const note = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...locals, directory, end, note]);
}

export const skillMd = (name: string, description: string, body = `# ${name}\n\nDo the ${name} work.`): string =>
  `---\nname: ${name}\ndescription: ${description}\nlicense: Apache-2.0\nallowed-tools: Bash\n---\n\n${body}\n`;

export const COMMIT = 'a'.repeat(40);

/** A GitHub archive: every entry inside `<repo>-<ref>/`, the commit id as the comment. */
export function githubZip(top: string, files: Record<string, string | Buffer | { data: string; mode: number }>, commit = COMMIT): Buffer {
  return zip(Object.entries(files).map(([name, value]) => typeof value === 'object' && !Buffer.isBuffer(value)
    ? { name: `${top}/${name}`, data: value.data, mode: value.mode }
    : { name: `${top}/${name}`, data: value }), commit);
}

/** A fetch that answers from `table` (a Buffer: 200 with it; a number: that status); anything else is a 404. Calls are recorded. */
export function fakeFetch(table: Record<string, Buffer | number>): LinkFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const value = table[url];
    if (Buffer.isBuffer(value)) return new Response(new Uint8Array(value), { status: 200, headers: { 'content-type': 'application/zip' } });
    return new Response('', { status: typeof value === 'number' ? value : 404 });
  }) as unknown as LinkFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** A skill library in a fresh temp folder (no ~/.claude or ~/.codex skills). */
export function library() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-links-'));
  const workspace = path.join(root, 'workspace');
  const resources = path.join(root, 'resources');
  const clock = new ManualClock();
  const skills = new SkillLibrary({ paths: { workspace, resources }, clock, home: '' });
  return { root, workspace, resources, clock, skills };
}
