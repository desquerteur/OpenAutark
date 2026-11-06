// Chat details › Notes, pure: the row's second line – who changed the notes last and when.
// Owns: that line. Never: reads notes or names people (the caller passes `nameOf`).

import type { NotesMeta } from '../../../shared/model/notes.ts';
import { listTime } from '../../lib/format.ts';

/** "Mara · 12:03"; nothing while nobody wrote any notes. */
export function notesLine(meta: Pick<NotesMeta, 'version' | 'updatedAt' | 'updatedBy'> | null, nameOf: (id: string) => string, now = Date.now()): string {
  if (!meta || !meta.version) return '';
  const by = meta.updatedBy ? nameOf(meta.updatedBy) : '';
  const at = meta.updatedAt ? listTime(meta.updatedAt, now) : '';
  return [by, at].filter(Boolean).join(' · ');
}
