// Default agent avatars: initials from the name and a palette index – the id's stable hash
// color, or, when the other agents of the org are passed, the freest color by creation order
// (rules in shared/text/avatar-looks.ts, the same ones the UI draws with).
// Owns: the stored default. Never: colors themselves (the UI maps index → palette token) and
// never touches custom image/emoji avatars.

import type { Avatar } from '../../shared/model/org.ts';
import { avatarInitials, avatarPaletteIndex, distinctLooks, PALETTE_SIZE } from '../../shared/text/avatar-looks.ts';
import type { LookInput } from '../../shared/text/avatar-looks.ts';

export { PALETTE_SIZE };

/** "Content Creator" → "CC", "Manager" → "M", "  " → "?". At most two letters. */
export function initials(name: string): string {
  return avatarInitials(name);
}

/** FNV-1a 32-bit → palette index; stable across runs and devices. */
export function paletteIndex(id: string): number {
  return avatarPaletteIndex(id);
}

/**
 * Generated avatar for a new or renamed agent. With `others` (the org's existing agents) the
 * color is the one `distinctLooks` gives a newest agent, so agents with the same initial differ.
 * The stored text stays the plain initials; the UI adds a second letter where needed.
 */
export function defaultAvatar(id: string, name: string, others?: readonly LookInput[]): Avatar {
  const text = initials(name);
  if (!others?.length) return { kind: 'initials', value: text, color: paletteIndex(id) };
  const newest = Math.max(0, ...others.map((agent) => agent.createdAt ?? 0)) + 1;
  const look = distinctLooks([...others.filter((agent) => agent.id !== id), { id, name, createdAt: newest }]).get(id);
  return { kind: 'initials', value: text, color: look?.color ?? paletteIndex(id) };
}
