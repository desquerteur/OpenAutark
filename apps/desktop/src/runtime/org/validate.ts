// Input checks for agents and spaces (names, modes, avatars, voices).
// Owns: field-level validation with user-safe messages. Never: org rules (service.ts).

import { WorkforceError } from '../../shared/errors.ts';
import type { Agent, Space } from '../../shared/model/org.ts';
import { PALETTE_SIZE } from './avatar.ts';

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function bad(message: string, field: string): never {
  throw new WorkforceError('bad_request', message, { details: { field } });
}

export function cleanName(value: unknown, field = 'name', max = 80): string {
  if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value) || !value.trim() || value.trim().length > max) {
    bad(`Enter a ${field} with 1 to ${max} characters.`, field);
  }
  return value.trim().replace(/\s+/gu, ' ');
}

export function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) bad(`The ${field} is too long or invalid.`, field);
  return value;
}

export const MODE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function cleanMode(value: unknown): string {
  if (typeof value !== 'string' || !MODE_KEY.test(value)) bad('Choose a valid mode.', 'mode');
  return value;
}

export function cleanSkills(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(item))) {
    bad('Choose valid skill names.', 'skills');
  }
  return [...new Set(value as string[])];
}

export function cleanAvatar(value: unknown): Agent['avatar'] {
  if (!plain(value) || !['initials', 'emoji', 'image'].includes(value.kind as string)) bad('Choose a valid avatar.', 'avatar');
  const text = cleanText(value.value, 'avatar', 80);
  if (!text) bad('Choose a valid avatar.', 'avatar');
  const avatar: Agent['avatar'] = { kind: value.kind as Agent['avatar']['kind'], value: text };
  if (value.color !== undefined) {
    if (!Number.isInteger(value.color) || (value.color as number) < 0 || (value.color as number) >= PALETTE_SIZE) bad('Choose a valid avatar color.', 'avatar');
    avatar.color = value.color as number;
  }
  return avatar;
}

/** A speech model's voice name ("nova", "en-US-Ava"): letters, digits, . _ - and spaces, ≤ 40. */
export function cleanVoice(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,39}$/.test(value.trim())) bad('Enter a voice name like "nova" (letters, digits, dots, dashes; up to 40).', 'voice');
  return value.trim();
}

/** Shallow structural check for JSON-only objects (model policy). */
export function cleanObject<T>(value: unknown, field: string): T {
  if (!plain(value)) bad(`Enter a valid ${field}.`, field);
  if (JSON.stringify(value).length > 20000) bad(`The ${field} is too large.`, field);
  return structuredClone(value) as T;
}

export const SPACE_KINDS: ReadonlyArray<Space['kind']> = ['company', 'brand', 'private', 'custom'];

export function cleanSpaceKind(value: unknown): Space['kind'] {
  if (!SPACE_KINDS.includes(value as Space['kind'])) bad('Choose a valid space kind.', 'kind');
  return value as Space['kind'];
}

export function cleanColor(value: unknown): string {
  if (typeof value !== 'string' || !/^(#[0-9a-fA-F]{6}|[a-z][a-z0-9-]{0,31})$/.test(value)) bad('Choose a valid color.', 'color');
  return value;
}
