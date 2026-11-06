// Runtime logger: one JSON line per entry in <logs>/runtime.log, rotated by size
// (runtime.log → runtime.1.log → … → runtime.<keep>.log), plus console output in dev.
// Owns: formatting, redaction of secret-looking fields, size cap, rotation.
// Never: logs secret values on purpose – callers pass ids/handles; `redact` is a safety net.

import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Clock, Logger } from '../contracts.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface FileLoggerOptions {
  dir: string;
  clock: Clock;
  fileName?: string; // default runtime.log
  maxBytes?: number; // per file, default 2 MiB
  keep?: number; // rotated files kept, default 3
  level?: Level; // minimum file level, default 'info'
  console?: boolean; // mirror to console (dev)
}

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|cipher|private[_-]?key)/i;
const MAX_STRING = 2000;

/** Replaces values of secret-looking keys and caps long strings (recursive, bounded depth). */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[…]';
  if (value instanceof Error) return { name: value.name, message: value.message, code: (value as { code?: unknown }).code };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && item !== undefined && item !== null && typeof item !== 'boolean' ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

export class FileLogger implements Logger {
  private readonly file: string;
  private readonly options: Required<Omit<FileLoggerOptions, 'console'>> & { console: boolean };
  private fd: number | undefined;
  private size = 0;

  constructor(options: FileLoggerOptions) {
    this.options = {
      fileName: 'runtime.log', maxBytes: 2 * 1024 * 1024, keep: 3, level: 'info', console: false, ...options,
    };
    this.file = path.join(options.dir, this.options.fileName);
  }

  debug(message: string, data?: Record<string, unknown>): void { this.write('debug', message, data); }
  info(message: string, data?: Record<string, unknown>): void { this.write('info', message, data); }
  warn(message: string, data?: Record<string, unknown>): void { this.write('warn', message, data); }
  error(message: string, data?: Record<string, unknown>): void { this.write('error', message, data); }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  private write(level: Level, message: string, data?: Record<string, unknown>): void {
    const entry = { t: new Date(this.options.clock.now()).toISOString(), level, msg: message, ...(data ? { data: redact(data) } : {}) };
    if (this.options.console) {
      const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      method(`[${level}] ${message}`, data ? entry.data : '');
    }
    if (ORDER[level] < ORDER[this.options.level]) return;
    // Logging must never crash the runtime: disk-full or permission errors are swallowed.
    try {
      const line = `${JSON.stringify(entry)}\n`;
      const bytes = Buffer.byteLength(line);
      this.open();
      if (this.size + bytes > this.options.maxBytes && this.size > 0) this.rotate();
      writeSync(this.fd!, line);
      this.size += bytes;
    } catch { /* ignore */ }
  }

  private open(): void {
    if (this.fd !== undefined) return;
    mkdirSync(this.options.dir, { recursive: true });
    this.fd = openSync(this.file, 'a', 0o600);
    this.size = statSync(this.file).size;
  }

  private rotate(): void {
    this.close();
    const rotated = (index: number) => path.join(this.options.dir, this.options.fileName.replace(/(\.log)?$/, `.${index}$1`));
    const oldest = rotated(this.options.keep);
    if (existsSync(oldest)) rmSync(oldest, { force: true });
    for (let index = this.options.keep - 1; index >= 1; index--) {
      if (existsSync(rotated(index))) renameSync(rotated(index), rotated(index + 1));
    }
    if (this.options.keep > 0) renameSync(this.file, rotated(1));
    else rmSync(this.file, { force: true });
    this.open();
  }
}

/** Logger that discards everything (tests that do not inspect logs). */
export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Logger that records entries in memory (tests that inspect logs). */
export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: Level; message: string; data?: Record<string, unknown> }> = [];
  debug(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'debug', message, data }); }
  info(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'info', message, data }); }
  warn(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'warn', message, data }); }
  error(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'error', message, data }); }
}
