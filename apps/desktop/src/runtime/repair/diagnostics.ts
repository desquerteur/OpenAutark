// Diagnostics export (23.10.2026): one plain text file the person can look at and pass on when a
// start fails – app and runtime versions, platform, the data's schema against this app's, the start
// problem and attempts, the copies from before updates and the last lines of the runtime log. Everything
// passes the feedback redaction (keys, tokens, e-mail addresses, user names in paths); nothing is sent anywhere.
// Owns: the text and where it is written (<data>/diagnostics/diagnostics-<time>.txt, last 5 kept).
// Never: reads the database's content, chat text, secrets or account homes, or uploads the file.

import { closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RepairState } from '../../shared/model/repair.ts';
import { redactText } from '../feedback/redact.ts';
import { stamp } from '../portability/backup.ts';

const LOG_BYTES = 64 * 1024;
const LOG_LINES = 200;
const KEEP = 5;

export interface DiagnosticsInput {
  dataDir: string;
  version: string;
  state: RepairState;
  now: number;
}

/** The data's schema, read-only (undefined when the file is missing or unreadable). */
export function dataSchema(dataDir: string): number | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dataDir, 'workforce.db'), { readOnly: true });
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value?: string } | undefined;
    return row?.value === undefined ? undefined : Number(row.value);
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

function logTail(dataDir: string): string[] {
  const file = path.join(dataDir, 'logs', 'runtime.log');
  try {
    const size = statSync(file).size;
    const length = Math.min(size, LOG_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    return (size > length ? lines.slice(1) : lines).slice(-LOG_LINES);
  } catch {
    return ['(no runtime log)'];
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** The diagnostics text (redacted). */
export function diagnosticsText(input: DiagnosticsInput): string {
  const { state } = input;
  const problem = state.problem;
  const lines = [
    'Autark diagnostics',
    `Created: ${new Date(input.now).toISOString()}`,
    `App version: ${input.version}`,
    `Platform: ${process.platform} ${process.arch} (${os.release()}), Node ${process.versions.node}${process.versions.electron ? `, Electron ${process.versions.electron}` : ''}`,
    `Data folder: ${input.dataDir}`,
    `Data schema: ${dataSchema(input.dataDir) ?? 'unknown'} (this app: ${state.appSchema})`,
    `Repair screen: ${state.active ? 'shown' : 'not shown'}`,
    ...(problem ? [
      `Start problem: ${problem.code}${problem.attempts ? ` after ${problem.attempts} starts` : ''} (${new Date(problem.at).toISOString()}, version ${problem.version})`,
      ...(problem.detail ? [`  ${problem.detail}`] : []),
    ] : []),
    `Copies from before updates: ${state.backups.length ? '' : 'none'}`,
    ...state.backups.map((info) => `  ${info.id}: version ${info.appVersion}, schema ${info.schema}, ${megabytes(info.bytes)}, ${new Date(info.createdAt).toISOString()}`),
    '',
    `Recent runtime log (last ${LOG_LINES} lines):`,
    ...logTail(input.dataDir),
    '',
  ];
  return redactText(lines.join('\n'));
}

/** Writes the diagnostics file and prunes older ones; returns its path and size. */
export function writeDiagnostics(input: DiagnosticsInput): { path: string; bytes: number } {
  const dir = path.join(input.dataDir, 'diagnostics');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `diagnostics-${stamp(input.now, true)}.txt`);
  const text = diagnosticsText(input);
  writeFileSync(file, text, { mode: 0o600 });
  try {
    const old = readdirSync(dir).filter((name) => /^diagnostics-.*\.txt$/.test(name)).sort().reverse().slice(KEEP);
    for (const name of old) rmSync(path.join(dir, name), { force: true });
  } catch { /* pruning is best effort */ }
  return { path: file, bytes: Buffer.byteLength(text) };
}
