// Shared parts of the Office text readers (office.ts, office-sheets.ts, office-slides.ts): the
// limits, the package (bounded ZIP entries as UTF-8 parts, a part's relationships) and the output
// lines under the character budget (blank lines collapse; the budget ends the read with "[truncated]").
// Owns: OFFICE_LIMITS, Package and Out. Never: reads files from disk or follows external relationships.

import { readEntry, zipBudget, zipEntries, type ZipBudget, type ZipEntry } from './zip.ts';
import { relationships } from './xml-scan.ts';

export const OFFICE_LIMITS = {
  /** Largest document file that is opened. */
  bytes: 20 * 1024 * 1024,
  /** Characters of text kept at most (then "[truncated]"). */
  chars: 1_000_000,
  /** Rows per sheet, slides per deck. */
  rows: 20_000,
  slides: 2_000,
  /** Columns a sheet row is padded to keep its cells aligned. */
  columns: 100,
};

export class Full extends Error {}

/** Collected lines under the character budget; blank lines collapse. */
export class Out {
  readonly lines: string[] = [];
  private chars = 0;
  truncated = false;

  push(line: string): void {
    let end = line.length; // trailing spaces and tabs go (a loop: /[ \t]+$/ is quadratic on long inner runs)
    while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
    const text = end === line.length ? line : line.slice(0, end);
    if (!text.trim() && (!this.lines.length || !this.lines[this.lines.length - 1])) return;
    if (this.chars + text.length > OFFICE_LIMITS.chars) { this.truncated = true; throw new Full(); }
    this.chars += text.length + 1;
    this.lines.push(text.trim() ? text : '');
  }

  text(): string {
    return `${this.lines.join('\n').trim()}${this.truncated ? '\n[truncated]' : ''}`;
  }
}

export class Package {
  readonly entries: Map<string, ZipEntry>;
  private readonly buf: Buffer;
  private readonly budget: ZipBudget = zipBudget();
  constructor(buf: Buffer) {
    this.buf = buf;
    this.entries = zipEntries(buf);
  }

  async part(name: string): Promise<string | undefined> {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return (await readEntry(this.buf, entry, this.budget)).toString('utf8').replace(/^﻿/, '');
  }

  /** Relationships of part `name` (its `_rels/<file>.rels`). */
  async rels(name: string): Promise<ReturnType<typeof relationships>> {
    const slash = name.lastIndexOf('/');
    const folder = slash < 0 ? '' : name.slice(0, slash);
    const xml = await this.part(`${folder ? `${folder}/` : ''}_rels/${name.slice(slash + 1)}.rels`);
    return xml ? relationships(xml, folder) : [];
  }
}

export const folderOf = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf('/')));
export const cells = (row: readonly string[]) => `| ${row.join(' | ')} |`;

