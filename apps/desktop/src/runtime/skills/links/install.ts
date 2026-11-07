// Writing a skill from a link (AF-007): the folder is built in `<parent>/.installing/<random>/` (a hidden folder the
// skill library and the folder discovery never list) and renamed into place in one step, so no half-written skill is
// ever seen; an update swaps the old folder out the same way (and back when the swap fails) and keeps the files the
// person added that the source never had. Every path is checked to stay inside the new folder; files are written plain
// (0644, no executable bit) – a script is only saved, never run. Beside the files: `.autark-source.json` (the source,
// the skill's folder in it and the sha256 of every file as written).
// Owns: the staging, the swap, the record file and the change list of an update. Never: runs a file, follows a link on
// disk (lstat; links are neither read nor counted) or writes outside the skill's folder.

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SkillFileChange, SkillLinkRecord, SkillLinkSource } from '../../../shared/model/skill-links.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { skillBudget } from './archive.ts';
import { installBytes, isScript, RECORD_FILE, sha256, textOf, type FoundSkill } from './candidates.ts';

const STAGING = '.installing';
const MAX_LOCAL_FILES = 2000;

/** `rel` ('/' separated) below `base`, or a 'forbidden' when it would land outside. */
export function inside(base: string, rel: string): string {
  const out = path.resolve(base, ...rel.split('/'));
  const relative = path.relative(base, out);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new WorkforceError('forbidden', `The path ${rel} would leave the skill's folder.`);
  return out;
}

/** The record beside a skill, or undefined when there is none or it is not one of ours. */
export function readRecord(dir: string): SkillLinkRecord | undefined {
  try {
    const file = path.join(dir, RECORD_FILE);
    if (!lstatSync(file).isFile()) return undefined;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SkillLinkRecord>;
    const source = raw.source as Partial<SkillLinkSource> | undefined;
    if (raw.version !== 1 || !source || typeof source.url !== 'string' || !['github', 'file', 'zip', 'upload'].includes(String(source.kind))) return undefined;
    if (typeof raw.name !== 'string' || typeof raw.route !== 'string' || !raw.files || typeof raw.files !== 'object') return undefined;
    return { version: 1, source: source as SkillLinkSource, route: raw.route, name: raw.name, installedAt: Number(raw.installedAt) || 0, updatedAt: Number(raw.updatedAt) || 0, files: raw.files as Record<string, string>, ...(typeof raw.commit === 'string' ? { commit: raw.commit } : {}) };
  } catch {
    return undefined;
  }
}

/** Every plain file below `dir` by relative path → sha256 (links and the record left out; bounded). */
export function folderHashes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (folder: string, rel: string) => {
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.size >= MAX_LOCAL_FILES) return;
      const own = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (!(rel === '' && entry.name === STAGING)) walk(full, own); continue; }
      if (!entry.isFile() || own === RECORD_FILE) continue;
      try { out.set(own, sha256(readFileSync(full))); } catch { /* unreadable now: left out */ }
    }
  };
  walk(dir, '');
  return out;
}

/** Lines that come and go between two texts (as multisets – a moved line counts as unchanged). */
export function lineChanges(before: string, after: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const line of before.replace(/\r\n?/g, '\n').split('\n')) count.set(line, (count.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.replace(/\r\n?/g, '\n').split('\n')) {
    const left = count.get(line) ?? 0;
    if (left > 0) count.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of count.values()) removed += left;
  return { added, removed };
}

/** The files of a found skill as they would be written (the same bytes an install writes). */
export async function skillBytes(skill: FoundSkill): Promise<Map<string, Buffer>> {
  const budget = skillBudget();
  const out = new Map<string, Buffer>();
  for (const [rel, file] of skill.files) out.set(rel, installBytes(rel, await file.read(budget)).bytes);
  return out;
}

function stageFolder(parent: string, name: string): { root: string; dir: string } {
  const root = path.join(parent, STAGING, randomUUID());
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

function cleanup(parent: string, root: string): void {
  rmSync(root, { recursive: true, force: true });
  try { rmdirSync(path.join(parent, STAGING)); } catch { /* another install is staging, or it is gone */ }
}

function writeFiles(dir: string, files: Map<string, Buffer>, record: Omit<SkillLinkRecord, 'files'>): SkillLinkRecord {
  const hashes: Record<string, string> = {};
  for (const [rel, bytes] of files) {
    const out = inside(dir, rel);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, bytes, { flag: 'wx', mode: 0o644 });
    hashes[rel] = sha256(bytes);
  }
  const full: SkillLinkRecord = { ...record, files: hashes };
  writeFileSync(path.join(dir, RECORD_FILE), `${JSON.stringify(full, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return full;
}

const busy = (error: unknown): WorkforceError => {
  const code = (error as { code?: string }).code;
  return new WorkforceError('conflict', code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
    ? 'The skill\'s folder is in use (a file of it is open?). Close it and try again.'
    : `The skill's folder could not be swapped (${code ?? 'error'}).`);
};

export interface WriteSkillInput {
  /** The skill's final folder: <place>/<name>. */
  dir: string;
  skill: FoundSkill;
  source: SkillLinkSource;
  commit?: string;
  now: number;
}

/** Installs a new skill folder; a folder of that name in the place is a 'conflict' (nothing is written). */
export async function writeSkill(input: WriteSkillInput): Promise<SkillLinkRecord> {
  if (existsSync(input.dir)) throw new WorkforceError('conflict', `There is a skill named ${path.basename(input.dir)} in that place already. Delete it first or choose another place.`);
  const parent = path.dirname(input.dir);
  const files = await skillBytes(input.skill);
  const stage = stageFolder(parent, path.basename(input.dir));
  try {
    const record = writeFiles(stage.dir, files, {
      version: 1, source: input.source, route: input.skill.info.route, name: input.skill.info.name,
      installedAt: input.now, updatedAt: input.now, ...(input.commit ? { commit: input.commit } : {}),
    });
    if (existsSync(input.dir)) throw new WorkforceError('conflict', `A skill named ${path.basename(input.dir)} appeared in that place meanwhile.`);
    renameSync(stage.dir, input.dir);
    return record;
  } finally {
    cleanup(parent, stage.root);
  }
}

export interface SkillDiff {
  changes: SkillFileChange[];
  unchanged: number;
  /** Files the person added that the source never had: kept by the update. */
  kept: string[];
  /** The folder as compared (relative path → sha256) – an apply checks it is still so. */
  seen: Map<string, string>;
  files: Map<string, Buffer>;
}

/** What replacing `dir` (installed as `record`) with `skill` would change. */
export async function diffSkill(dir: string, record: SkillLinkRecord, skill: FoundSkill): Promise<SkillDiff> {
  const files = await skillBytes(skill);
  const seen = folderHashes(dir);
  const changes: SkillFileChange[] = [];
  let unchanged = 0;
  for (const [rel, bytes] of files) {
    const now = seen.get(rel);
    const after = sha256(bytes);
    const script = isScript(rel, skill.files.get(rel)?.mode) ? { script: true as const } : {};
    if (now === undefined) { changes.push({ path: rel, change: 'added', size: bytes.byteLength, ...script }); continue; }
    if (now === after) { unchanged++; continue; }
    const change: SkillFileChange = { path: rel, change: 'changed', size: bytes.byteLength, ...script, ...(record.files[rel] !== now ? { local: true as const } : {}) };
    const newText = textOf(bytes);
    let oldBytes: Buffer | undefined;
    try { oldBytes = readFileSync(inside(dir, rel)); } catch { oldBytes = undefined; }
    const oldText = oldBytes && textOf(oldBytes);
    if (newText !== undefined && oldText !== undefined) change.lines = lineChanges(oldText, newText);
    changes.push(change);
  }
  const kept: string[] = [];
  for (const [rel, hash] of seen) {
    if (files.has(rel)) continue;
    if (record.files[rel] === undefined) { kept.push(rel); continue; } // the person's own file: stays
    let size = 0;
    try { size = lstatSync(inside(dir, rel)).size; } catch { size = 0; }
    changes.push({ path: rel, change: 'removed', size, ...(record.files[rel] !== hash ? { local: true as const } : {}) });
  }
  const order = { changed: 0, added: 1, removed: 2 } as const;
  changes.sort((a, b) => order[a.change] - order[b.change] || (a.path < b.path ? -1 : 1));
  return { changes, unchanged, kept, seen, files };
}

export interface ReplaceSkillInput {
  dir: string;
  record: SkillLinkRecord;
  diff: SkillDiff;
  skill: FoundSkill;
  source: SkillLinkSource;
  commit?: string;
  now: number;
}

/** Swaps the skill's folder for the checked new version; the folder changed since the check is a 'conflict'. */
export function replaceSkill(input: ReplaceSkillInput): SkillLinkRecord {
  const current = folderHashes(input.dir);
  const same = current.size === input.diff.seen.size && [...current].every(([rel, hash]) => input.diff.seen.get(rel) === hash);
  if (!same) throw new WorkforceError('conflict', 'The skill changed since the check. Check for the update again.');
  const parent = path.dirname(input.dir);
  const name = path.basename(input.dir);
  const stage = stageFolder(parent, name);
  const old = path.join(stage.root, `${name}.old`);
  let keepStage = false; // the old version could not be put back: the staging folder holds the only copy
  try {
    const record = writeFiles(stage.dir, input.diff.files, {
      version: 1, source: input.source, route: input.skill.info.route, name: input.skill.info.name,
      installedAt: input.record.installedAt || input.now, updatedAt: input.now, ...(input.commit ? { commit: input.commit } : {}),
    });
    for (const rel of input.diff.kept) { // the person's own files go along
      const out = inside(stage.dir, rel);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, readFileSync(inside(input.dir, rel)), { flag: 'wx' });
    }
    try { renameSync(input.dir, old); } catch (error) { throw busy(error); }
    try {
      renameSync(stage.dir, input.dir);
    } catch (error) {
      try { renameSync(old, input.dir); } catch {
        keepStage = true;
        throw new WorkforceError('internal', `The update could not be put in place; the old version is in ${old}.`);
      }
      throw busy(error);
    }
    return record;
  } finally {
    if (!keepStage) cleanup(parent, stage.root);
  }
}
