// The tree's own words about itself and where it lives without a data folder: the top folders say what they are for, a new
// branch or agent folder whose it is; a database without a folder (tests) gets a temporary tree.
// Owns: those descriptions and the temporary folder. Never: writes an entry.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { MemoryTree } from './memory-tree.ts';

const TOP_FOLDERS: ReadonlyArray<readonly [string, string]> = [
  ['company', 'What the whole company knows.'],
  ['branches', 'One folder per branch (space) of the company.'],
  ['agents', 'One folder per agent: what that agent keeps for itself.'],
  ['references', "People's own words, reasons and corrections, one folder per person (human = the owner)."],
];

export function describeTop(tree: MemoryTree, log?: Logger): void {
  try { for (const [folder, text] of TOP_FOLDERS) tree.describe(folder, text); } catch (error) { log?.warn('memory: top folders not described', { error: String(error) }); }
}

/** A new branch or agent folder says whose it is. */
export function describePlace(tree: MemoryTree, db: Db, rel: string): void {
  const [top, id, next] = rel.split('/');
  if (!next || (top !== 'branches' && top !== 'agents') || tree.exists(`${top}/${id}`)) return;
  const table = top === 'branches' ? 'spaces' : 'agents';
  let name: string | undefined;
  try { name = db.get<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, [id])?.name; } catch { /* no such table in a small test database */ }
  if (name) tree.describe(`${top}/${id}`, top === 'branches' ? `What the branch ${name} knows.` : `What ${name} keeps for itself.`);
}

const scratchRoots = new Set<string>();

/** A temporary tree for a database without a folder (tests); removed when the process ends. */
export function scratchRoot(): string {
  if (!scratchRoots.size) process.once('exit', () => { for (const dir of scratchRoots) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the system's temp folder */ } } });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-'));
  scratchRoots.add(dir);
  return dir;
}
