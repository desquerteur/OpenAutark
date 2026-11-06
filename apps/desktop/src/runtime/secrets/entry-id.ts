// The id of a new catalog entry (owner 29.10.2026: "a catalog like a skill" – the id is generated automatically, the
// AI may suggest one): a readable slug of the suggestion, else "sec_" + a slug of the name, made unique against every
// stored secret, field and group ("-2", "-3" …). The id is the handle (`secret://<id>`) and the entry's key in its
// route file, so it uses only a–z, 0–9, "_" and "-" (at most 64 characters).
// Owns: that rule. Never: reads or names a value.

import type { SecretGroup, SecretInfo } from '../../shared/model/security.ts';

const MAX_ID = 64;

/** A slug: lower-case a–z/0–9 words joined by "-" (accents dropped), at most `max` characters; '' when nothing is left. */
export function slugOf(text: string, max = 48): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

/** A free id for a new entry named `name` (`suggested`: the AI's suggestion, used when it is a valid, free slug base). */
export function newEntryId(secrets: readonly Pick<SecretInfo, 'id'>[], groups: readonly Pick<SecretGroup, 'id'>[], name: string, suggested?: string): string {
  const taken = new Set([...secrets.map((entry) => entry.id.toLowerCase()), ...groups.map((entry) => entry.id.toLowerCase())]);
  const own = suggested ? suggested.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, MAX_ID - 4) : '';
  const base = own.length >= 3 ? own : `sec_${slugOf(name) || 'secret'}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base.slice(0, MAX_ID - String(n).length - 1)}-${n}`;
    if (!taken.has(id)) return id;
  }
}
