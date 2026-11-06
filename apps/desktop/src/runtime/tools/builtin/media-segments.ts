// media.segments: the marked parts of a stored file – a span of a recording or video, a region of a picture, each with a line of
// description – and what a cut or crop needs (seconds, pixels, ffmpeg arguments, a media: reference). They live in one memory
// note per file, one line per part ("- 0:12.0–0:18.0 [0.1,0.2,0.5,0.5] He laughs"), so anyone can read and change them by hand and
// memory search and vector.search find them by meaning; the note lies with the file's chat, so it reaches who reads that chat.
// Owns: this tool and that line format. Never: shows or marks media of chats the agent is not a member of, or presents
// descriptions as instructions (they are data about the file).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WorkforceError } from '../../../shared/errors.ts';
import type { MediaInfo, MediaRegion } from '../../../shared/model/media.ts';
import { mediaRef, parseSpan, parseTimecode, spanText } from '../../../shared/text/media-ref.ts';
import { folderOfScope, MEMORY_ENTRY } from '../../knowledge/memory-tree.ts';
import { writeAtomic } from '../../root/text-doc.ts';
import { failure, json } from '../types.ts';
import { DATA_NOTE, mediaFileId, readableMedia } from './media-common.ts';
import { clip, defineTool, internal } from './util.ts';

export interface MarkedPart { line: string; startMs?: number; endMs?: number; region?: MediaRegion; text: string }

const MARK = /^- (?:(\S+–\S+) )?(?:\[([\d.]+),([\d.]+),([\d.]+),([\d.]+)\] )?(.*)$/;

/** The parts a note holds, in file order; other lines stay out of it. */
export function partsIn(note: string): MarkedPart[] {
  return note.split(/\r?\n/).flatMap((line) => {
    const match = MARK.exec(line);
    if (!match) return [];
    const span = match[1] ? parseSpan(match[1]) : undefined;
    return [{
      line, text: match[6].trim(), ...(span ? { startMs: span.startMs, endMs: span.endMs } : {}),
      ...(match[2] ? { region: { x: Number(match[2]), y: Number(match[3]), width: Number(match[4]), height: Number(match[5]) } } : {}),
    }];
  });
}

/** One part as a line of the note; a region in fractions of the picture. */
export function partLine(part: Pick<MarkedPart, 'startMs' | 'endMs' | 'region' | 'text'>): string {
  const r = part.region;
  const box = r ? `[${[r.x, r.y, r.width, r.height].map((value) => Number(value.toFixed(4))).join(',')}] ` : '';
  const span = part.startMs !== undefined && part.endMs !== undefined ? `${spanText(part.startMs, part.endMs)} ` : '';
  return `- ${span}${box}${part.text.replace(/\s+/g, ' ').trim()}`;
}

/** What an edit needs of one part. */
function partView(part: MarkedPart, n: number, info: Pick<MediaInfo, 'fileId' | 'width' | 'height'>, file: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { n, text: part.text, ref: mediaRef(info.fileId, part) };
  const before: string[] = [];
  const after: string[] = [];
  if (part.startMs !== undefined && part.endMs !== undefined) {
    Object.assign(out, { span: spanText(part.startMs, part.endMs), start: part.startMs / 1000, end: part.endMs / 1000 });
    before.push(`-ss ${(part.startMs / 1000).toFixed(3)} -to ${(part.endMs / 1000).toFixed(3)}`);
  }
  if (part.region) {
    out.region = part.region;
    if (info.width && info.height) {
      const r = part.region;
      const box = { x: Math.round(r.x * info.width), y: Math.round(r.y * info.height), width: Math.max(1, Math.round(r.width * info.width)), height: Math.max(1, Math.round(r.height * info.height)) };
      out.regionPx = box;
      after.push(`-vf crop=${box.width}:${box.height}:${box.x}:${box.y}`);
    }
  }
  if (file && before.length + after.length) out.ffmpeg = ['ffmpeg', ...before, `-i "${file}"`, ...after].join(' ');
  return out;
}

function msOf(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = parseTimecode(value);
  if (ms === undefined) throw new WorkforceError('bad_request', `${name}: give a time code like "0:12" or seconds.`);
  return ms;
}

/** A region in the file's pixels (any value above 1) or fractions → fractions. */
function regionOf(region: MediaRegion, info: Pick<MediaInfo, 'width' | 'height'>): MediaRegion {
  if (![region.x, region.y, region.width, region.height].some((value) => value > 1)) return region;
  if (!info.width || !info.height) throw new WorkforceError('bad_request', 'The size of this file is not known: give the region as fractions 0–1.');
  return { x: region.x / info.width, y: region.y / info.height, width: region.width / info.width, height: region.height / info.height };
}

/** The file's note: below its chat's memory (`company` for a file of no chat), where a search of its readers looks. */
export function marksFile(dataDir: string, info: Pick<MediaInfo, 'fileId' | 'conversationId'>): string {
  const folder = info.conversationId ? folderOfScope('conversation', info.conversationId) : folderOfScope('global', undefined);
  return path.join(dataDir, MEMORY_ENTRY, folder, 'media', `${info.fileId.slice(0, 16)}.md`);
}

const noteHead = (info: MediaInfo, by: string) => [
  '---', `title: ${JSON.stringify(`Parts of ${info.name}`)}`, 'kind: reference', 'tags: [media]', `source: agent:${by}`, '---', '',
  `Marked parts of media:${info.fileId} (${info.name}). One line each, read and changed by media.segments or right here.`, '', '',
].join('\n');

const segments = defineTool<{ fileId: string; text?: string; start?: string; end?: string; region?: MediaRegion; remove?: number }>({
  name: 'media.segments',
  description: 'The marked parts of a stored file, with seconds, pixels and ffmpeg arguments for a cut or crop. With text: mark a part (start and end, a region of the picture, or both). remove: drop part n. They are found later with vector.search.',
  inputSchema: {
    type: 'object',
    properties: {
      fileId: { type: 'string', minLength: 64, maxLength: 1000 }, text: { type: 'string', minLength: 1, maxLength: 600 },
      start: { type: 'string', maxLength: 20, description: 'a time code "0:12" or seconds "12.5"' }, end: { type: 'string', maxLength: 20 },
      region: {
        type: 'object', description: 'from the top left, in pixels of the file or fractions 0–1',
        properties: { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 } },
        required: ['x', 'y', 'width', 'height'], additionalProperties: false,
      },
      remove: { type: 'integer', minimum: 1 },
    },
    required: ['fileId'], additionalProperties: false,
  },
  category: 'write_local',
  describe: (args) => internal(`${args.text ? 'Mark a part of' : args.remove ? 'Remove a part of' : 'Read the parts of'} media ${clip(mediaFileId(args.fileId) ?? args.fileId, 70)}`, mediaFileId(args.fileId)),
  async run(args, ctx) {
    const found = readableMedia(ctx, args.fileId, 'mark');
    if ('refused' in found) return found.refused;
    const { info } = found;
    const noteFile = marksFile(ctx.services.paths.data, info);
    let note = existsSync(noteFile) ? readFileSync(noteFile, 'utf8') : '';
    if (args.remove !== undefined) {
      const part = partsIn(note)[args.remove - 1];
      if (!part) return failure(`There is no part ${args.remove}.`);
      note = note.split(/\r?\n/).filter((line) => line !== part.line).join('\n');
      writeAtomic(noteFile, note);
    }
    if (args.text !== undefined) {
      const startMs = msOf(args.start, 'start');
      const endMs = msOf(args.end, 'end');
      if ((startMs === undefined) !== (endMs === undefined)) return failure('A span needs both start and end.');
      if (startMs !== undefined && endMs! <= startMs) return failure('end must lie after start.');
      if (startMs === undefined && !args.region) return failure('Mark a span (start and end), a region, or both.');
      const line = partLine({ startMs, endMs, region: args.region ? regionOf(args.region, info) : undefined, text: args.text });
      note = `${(note || noteHead(info, ctx.agent.id)).trimEnd()}\n${line}\n`;
      writeAtomic(noteFile, note);
    }
    let file: string | undefined;
    try { file = ctx.services.files?.path(info.fileId); } catch { file = undefined; }
    return json({ note: DATA_NOTE, marksFile: noteFile, parts: partsIn(note).map((part, index) => partView(part, index + 1, info, file)) });
  },
});

export const mediaSegmentTools = [segments];
