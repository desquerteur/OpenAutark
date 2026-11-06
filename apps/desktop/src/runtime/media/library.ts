// The media library's read/write API over the database, without state of its own: list and
// search (with the agent visibility rule), description + tag edits and the media.upserted
// event. MediaService uses it for RPC; the agent tools build one per call from their services.
// Owns: description/tag rules (trim, limits, dedupe), redaction of agent-written text, the
// "nothing written → no author" rule and the event. Never: probes files, subscribes to
// events or caches rows (so building one per call costs nothing).

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { MediaFilter, MediaInfo, MediaPatch } from '../../shared/model/media.ts';
import type { RuntimeServices } from '../contracts.ts';
import { MediaRepo, type MediaAudience } from './repo.ts';

export const MEDIA_LIMITS = { description: 4000, tags: 30, tag: 60, list: 100, maxList: 500 } as const;

export type LibraryServices = Pick<RuntimeServices, 'db' | 'bus' | 'clock'> & { secrets?: Pick<RuntimeServices['secrets'], 'redact'> };

export class MediaLibrary {
  private readonly s: LibraryServices;
  private readonly repo: MediaRepo;

  constructor(services: LibraryServices) {
    this.s = services;
    this.repo = new MediaRepo(services.db);
  }

  get(fileId: string): MediaInfo | undefined {
    return this.repo.get(fileId);
  }

  /** Newest first; with `text` ranked by name, description and tags. Owner sees everything. */
  list(filter: MediaFilter = {}, audience: MediaAudience = { kind: 'owner' }): MediaInfo[] {
    const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? MEDIA_LIMITS.list), MEDIA_LIMITS.maxList));
    return this.repo.list(filter, audience, limit);
  }

  visibleTo(fileId: string, agentId: string): boolean {
    return this.repo.visibleTo(fileId, agentId);
  }

  /**
   * Sets description and/or tags (omitted fields stay). `by` is 'human' or an agent id; when
   * neither description nor tags remain, the author is cleared too. No change → no event.
   */
  describe(fileId: string, patch: MediaPatch, by: string): MediaInfo {
    const current = this.repo.get(fileId);
    if (!current) throw new WorkforceError('not_found', 'This file is not in the media library.');
    const description = patch.description === undefined ? current.description : this.cleanDescription(patch.description, by);
    const tags = patch.tags === undefined ? current.tags ?? [] : cleanTags(patch.tags);
    if (description === current.description && tags.join('\n') === (current.tags ?? []).join('\n')) return current;
    const written = Boolean(description) || tags.length > 0;
    this.repo.describe(fileId, { description, tags, by: written ? by : undefined }, this.s.clock.now());
    const next = this.repo.get(fileId)!;
    this.emit(next);
    return next;
  }

  emit(info: MediaInfo): void {
    this.s.bus.emit('media.upserted', info);
  }

  private cleanDescription(value: string, by: string): string | undefined {
    let text = value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MEDIA_LIMITS.description);
    // Agents never hold secret values, but text they read from media might contain one.
    if (text && by !== HUMAN_ID && this.s.secrets) {
      try { text = this.s.secrets.redact(text); } catch { /* the vault may be locked; keep the text */ }
    }
    return text || undefined;
  }
}

/** Trimmed, single-spaced, without a leading '#', deduplicated (case-insensitive), capped. */
export function cleanTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = String(raw).replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim().slice(0, MEDIA_LIMITS.tag);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MEDIA_LIMITS.tags) break;
  }
  return out;
}
