// Tiny helpers shared by the block renderers in this folder (validated blocks are loosely typed).
// Owns: safe readers for item lists and strings. Never: validation – parse.ts already did it.

export type Item = Record<string, unknown>;

export const items = (value: unknown): Item[] => (Array.isArray(value) ? (value as Item[]) : []);
export const s = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(v => s(v)).filter(Boolean) : []);
