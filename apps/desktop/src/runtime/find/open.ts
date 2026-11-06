// Opening one candidate step by step (FIND, wave 3): a page of a skill, a memory note or a reference. The version the
// caller saw is compared: a newer skill text, corrected note or reference version is opened and said ("changed since
// you found it"). A corrected note opens as the newest version of its chain and counts as used; its first line says
// the day it was saved and its age. Another agent's own notes stay its own.
// Owns: paging and the version check. Never: returns more than one page, or presents a document as instructions.

import type { RuntimeServices } from '../contracts.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { savedText } from '../knowledge/age.ts';
import { profileZone } from '../context/time.ts';
import { skillFound, type FindCaller, type Found } from './candidates.ts';

export const PAGE_CHARS = 6000;
export const GONE = 'This resource does not exist (any more). Search again with knowledge.find.';

export interface OpenInput {
  id: string;
  /** The version the caller saw (from find); a different current version is said. */
  version?: string;
  /** 1-based page of a skill. */
  page?: number;
}

export interface Opened {
  candidate: Found;
  text: string;
  page: number;
  pages: number;
  changed?: string;
}

const gone = (): never => { throw new WorkforceError('not_found', GONE); };
const changedNote = (seen: string | undefined, now: string): string | undefined =>
  seen && seen !== now ? `changed since you found it (version ${seen} → ${now})` : undefined;

/** Pages of at most `max` characters, cut at a heading when one is near, else at a line. */
export function pagesOf(text: string, max = PAGE_CHARS): Array<{ text: string; firstLine: number; lastLine: number }> {
  const lines = text.split('\n');
  const pages: Array<{ text: string; firstLine: number; lastLine: number }> = [];
  let current: string[] = [];
  let size = 0;
  let first = 1;
  const flush = (end: number) => { if (current.length) pages.push({ text: current.join('\n'), firstLine: first, lastLine: end }); current = []; size = 0; first = end + 1; };
  lines.forEach((line, index) => {
    const heading = /^#{1,3}\s/.test(line);
    if (current.length && (size + line.length + 1 > max || (heading && size >= max / 2))) flush(index);
    current.push(line.length > max ? line.slice(0, max) : line);
    size += Math.min(line.length, max) + 1;
  });
  flush(lines.length);
  return pages.length ? pages : [{ text: '', firstLine: 1, lastLine: 1 }];
}

export function openSkill(services: RuntimeServices, caller: FindCaller, name: string, input: OpenInput, mode: ModeInfo | undefined): Opened {
  const loaded = services.skills.get(name);
  if (!loaded) return gone();
  const candidate = skillFound(services, caller, loaded.info, mode, 1, [])!;
  const pages = pagesOf(loaded.body);
  const page = Math.min(Math.max(1, input.page ?? 1), pages.length);
  const shown = pages[page - 1];
  return {
    candidate: { ...candidate, lines: { from: shown.firstLine, to: shown.lastLine }, why: 'opened' }, text: shown.text, page, pages: pages.length,
    ...(changedNote(input.version, candidate.version) ? { changed: changedNote(input.version, candidate.version) } : {}),
  };
}

/** Corrections followed at most this far (A → B → C …). */
const MAX_CORRECTIONS = 10;

export function openNote(services: RuntimeServices, caller: FindCaller, id: string, input: OpenInput): Opened {
  let item = services.knowledge.get(id);
  let changed: string | undefined;
  for (let step = 0; item?.expiredAt !== undefined && step < MAX_CORRECTIONS; step++) { // corrected or ended: the current version
    const next = services.db.get<{ id: string }>('SELECT id FROM knowledge WHERE supersedes = ? ORDER BY recorded_at DESC LIMIT 1', [item.id]);
    item = next ? services.knowledge.get(next.id) : undefined;
    changed = item ? `corrected since you found it – this is the current version note:${item.id}` : undefined;
  }
  if (!item || item.expiredAt !== undefined) return gone();
  if (item.scope === 'agent' && caller.agent && item.scopeId && item.scopeId !== caller.agent.id) return gone(); // another agent's own note
  const marker = services.knowledge as { markUsed?(ids: string[]): void };
  try { marker.markUsed?.([item.id]); } catch { /* usage stats only */ }
  const version = `r${item.recordedAt.toString(36)}`;
  const place = `memory · ${item.scope}${item.pinned ? ' · pinned' : ''}`;
  changed ??= changedNote(input.version, version);
  return {
    candidate: { id: `note:${item.id}`, kind: 'note', authority: 'hint', title: item.title, route: place, version, score: 1, why: 'opened', origin: place },
    text: `${item.title} (${savedText(item.recordedAt, services.clock.now(), profileZone(services))})\n${item.description ? `${item.description}\n` : ''}${item.body}`, page: 1, pages: 1, ...(changed ? { changed } : {}),
  };
}
