// Default agent avatars and the rule that keeps agents of one org apart: initials from the
// name, a stable palette index from the id, and `distinctLooks`, which walks the agents in
// creation order and gives each generated avatar the freest palette color (never one an
// earlier agent with the same first letter already has) plus a second letter when the
// initials would still collide.
// Owns: these pure derivation rules, shared by the runtime (stored defaults) and the UI
// (what is drawn). Never: imports outside src/shared, changes image/emoji avatars, or names
// colors (the UI maps index → palette token).

import type { Avatar } from '../model/org.ts';

export const PALETTE_SIZE = 6;

/** "Content Creator" → "CC", "Manager" → "M", "  " → "?". At most two letters. */
export function avatarInitials(name: string): string {
  const words = name.trim().split(/[\s_-]+/u).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '').join('');
  return letters ? letters.toLocaleUpperCase() : '?';
}

/** FNV-1a 32-bit → palette index; stable across runs and devices. */
export function avatarPaletteIndex(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % PALETTE_SIZE;
}

export interface LookInput {
  id: string;
  name: string;
  avatar?: Avatar;
  createdAt?: number;
}

/** What an initials avatar shows: one or two characters on palette color `color`. */
export interface Look {
  text: string;
  color: number;
}

const SAME_LETTER_WEIGHT = 1000;

function validColor(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < PALETTE_SIZE;
}

/** Freest color: fewest same-letter agents first, then fewest agents overall; ties keep `preferred`. */
function pickColor(preferred: number, sameLetter: readonly number[], total: readonly number[]): number {
  let best = preferred;
  let bestScore = Infinity;
  for (let offset = 0; offset < PALETTE_SIZE; offset++) {
    const color = (preferred + offset) % PALETTE_SIZE;
    const score = sameLetter[color] * SAME_LETTER_WEIGHT + total[color];
    if (score < bestScore) { best = color; bestScore = score; }
  }
  return best;
}

/** Two-character alternatives from the name: first letter + each later letter ("Mira" → Mi, Mr, Ma). */
function alternatives(name: string, first: string): string[] {
  const rest = Array.from(name.trim()).slice(1).filter((char) => /[\p{L}\p{N}]/u.test(char));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const char of rest) {
    const lower = char.toLocaleLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(first + lower);
  }
  return out;
}

function byCreation(a: LookInput, b: LookInput): number {
  const at = (a.createdAt ?? 0) - (b.createdAt ?? 0);
  if (at) return at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Looks for every agent whose avatar is initials (or missing). Deterministic: earlier agents
 * keep their look when later ones are added. A color that differs from the id's hash color was
 * chosen on purpose and is kept. Image and emoji avatars are not in the result.
 */
export function distinctLooks(agents: readonly LookInput[]): Map<string, Look> {
  const looks = new Map<string, Look>();
  const total: number[] = new Array<number>(PALETTE_SIZE).fill(0);
  const byLetter = new Map<string, number[]>();
  const texts = new Set<string>(); // lower-cased texts already shown
  const pairs = new Set<string>(); // `${text}|${color}`, lower-cased
  for (const agent of [...agents].sort(byCreation)) {
    const avatar = agent.avatar;
    if (avatar && avatar.kind !== 'initials') {
      if (avatar.kind === 'emoji' && validColor(avatar.color)) total[avatar.color]++;
      continue;
    }
    const base = Array.from(avatar?.value?.trim() || avatarInitials(agent.name)).slice(0, 2).join('');
    const first = Array.from(base)[0] ?? '?';
    const letterKey = first.toLocaleLowerCase();
    const sameLetter = byLetter.get(letterKey) ?? new Array<number>(PALETTE_SIZE).fill(0);
    byLetter.set(letterKey, sameLetter);
    const hashColor = avatarPaletteIndex(agent.id);
    const chosen = validColor(avatar?.color) && avatar.color !== hashColor;
    const color = chosen ? avatar.color as number : pickColor(hashColor, sameLetter, total);

    let text = base;
    const clash = (candidate: string) => texts.has(candidate.toLocaleLowerCase());
    const pairTaken = (candidate: string) => pairs.has(`${candidate.toLocaleLowerCase()}|${color}`);
    if ((Array.from(base).length === 1 && clash(base)) || pairTaken(base)) {
      text = alternatives(agent.name, first).find((candidate) => !clash(candidate)) ?? base;
    }
    looks.set(agent.id, { text, color });
    texts.add(text.toLocaleLowerCase());
    pairs.add(`${text.toLocaleLowerCase()}|${color}`);
    sameLetter[color]++;
    total[color]++;
  }
  return looks;
}
