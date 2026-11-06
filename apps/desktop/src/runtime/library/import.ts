// Index-only import of big catalogs (B-078 D13): a list of skills written by others as name + description + URL only, never
// their bodies – embedded by description (knowledge/catalog.ts), opened on the web when one fits. Reads a JSON list
// (an array, or {skills|plugins|entries|items: [...]}, Claude's marketplace.json included) or a Markdown list of links
// ("- [name](url) – description", the awesome-lists people share). skillsclau.de is no source: it has no machine-readable
// list, a sign-in gate and malware reports (research 06.11.2026).
// Owns: parsing such a list and storing it as <data>/library/<id>.index.json. Never: downloads an entry's files or runs anything.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LibraryEntry } from '../../shared/model/library.ts';
import { stripInvisible } from '../../shared/text/external.ts';
import { skillSlug } from '../skills/import-text.ts';

export const MAX_INDEX = 50_000;
const DESCRIPTION_CHARS = 400;
const FETCH_MS = 30_000;
const MAX_BYTES = 16 * 1024 * 1024;

export type FetchText = (url: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const clean = (value: unknown): string => (typeof value === 'string' ? stripInvisible(value).text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '');
const cut = (text: string): string => (text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : text);

function urlOf(value: unknown, base: string): string | undefined {
  const given = typeof value === 'string' ? value : value && typeof value === 'object' ? (value as { url?: unknown; repo?: unknown }).url ?? (value as { repo?: unknown }).repo : undefined;
  if (typeof given !== 'string' || !given.trim()) return undefined;
  try {
    const url = new URL(given.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch { return undefined; }
}

function fromJson(data: unknown, source: string, base: string): LibraryEntry[] {
  const list = Array.isArray(data) ? data : data && typeof data === 'object'
    ? ['skills', 'plugins', 'entries', 'items'].map((key) => (data as Record<string, unknown>)[key]).find(Array.isArray) as unknown[] | undefined
    : undefined;
  if (!list) return [];
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const name = skillSlug(clean(row.name ?? row.title));
    const description = cut(clean(row.description ?? row.summary));
    const url = urlOf(row.url ?? row.homepage ?? row.source ?? row.repository, base);
    return name && description ? [{ source, name, description, ...(url ? { url } : {}) }] : [];
  });
}

const LINK = /^\s*[-*+]\s+\*{0,2}\[([^\]]{2,120})\]\(([^)\s]+)\)\*{0,2}\s*(?:[-–—:|]\s*)?(.*)$/;

function fromMarkdown(text: string, source: string, base: string): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const match = LINK.exec(line);
    if (!match) continue;
    const name = skillSlug(clean(match[1]));
    const description = cut(clean(match[3].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '')));
    const url = urlOf(match[2], base);
    if (name && description.length >= 8 && url) out.push({ source, name, description, url });
  }
  return out;
}

/** The entries of one list, each name once (the first counts), at most MAX_INDEX. */
export function parseIndex(text: string, source: string, base: string): LibraryEntry[] {
  let entries: LibraryEntry[];
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { entries = fromJson(JSON.parse(trimmed), source, base); } catch { entries = []; }
  } else {
    entries = fromMarkdown(text, source, base);
  }
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entry.name) && seen.add(entry.name)).slice(0, MAX_INDEX);
}

export const indexFile = (libraryDir: string, id: string): string => path.join(libraryDir, `${id}.index.json`);

/** Fetches a list and stores its entries; the count, or why not. */
export async function importIndex(libraryDir: string, id: string, url: string, fetchText: FetchText = (target, signal) => fetch(target, { signal, redirect: 'follow' })): Promise<{ entries: number } | { problem: string }> {
  let body: string;
  try {
    const response = await fetchText(url, AbortSignal.timeout(FETCH_MS));
    if (!response.ok) return { problem: `the list answered ${response.status}` };
    body = await response.text();
  } catch (error) {
    return { problem: `the list could not be fetched (${(error as Error).message})` };
  }
  if (body.length > MAX_BYTES) return { problem: 'the list is larger than 16 MB' };
  const entries = parseIndex(body, id, url);
  if (!entries.length) return { problem: 'the list holds no entries I can read (a JSON list of name + description, or a Markdown list of links)' };
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(indexFile(libraryDir, id), JSON.stringify(entries), 'utf8');
  return { entries: entries.length };
}

/** The stored entries of a list ([] when it was never fetched). */
export function readIndex(libraryDir: string, id: string): LibraryEntry[] {
  try {
    const data = JSON.parse(readFileSync(indexFile(libraryDir, id), 'utf8')) as LibraryEntry[];
    return Array.isArray(data) ? data.filter((entry) => entry && typeof entry.name === 'string' && typeof entry.description === 'string') : [];
  } catch {
    return [];
  }
}
