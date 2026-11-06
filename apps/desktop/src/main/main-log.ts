// Main-process log file: <userData>/logs/main.log (main's own lines plus the runtime's
// stdout/stderr, which the runtime uses only for crashes – its structured log is runtime.log).
// Rotated once at startup when it grew past the cap (main.log → main.1.log).
// Owns: the append stream, a never-failing sink for piped child output, the line format.
// Never: logs secrets, tokens or message text – callers pass short operational sentences only.

import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

const MAX_BYTES = 2 * 1024 * 1024;

export interface MainLog {
  /**
   * Sink for piped child output. It always consumes (also when the file is unavailable), so a
   * child writing to stdout can never block on a full pipe.
   */
  readonly sink: Writable;
  line(message: string): void;
  close(): void;
}

function open(dir: string): WriteStream | null {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'main.log');
    try {
      if (statSync(file).size > MAX_BYTES) {
        rmSync(path.join(dir, 'main.1.log'), { force: true });
        renameSync(file, path.join(dir, 'main.1.log'));
      }
    } catch { /* no log yet */ }
    return createWriteStream(file, { flags: 'a', mode: 0o600 });
  } catch {
    return null;
  }
}

export function openMainLog(dir: string, mirror = false): MainLog {
  let file = open(dir);
  file?.on('error', () => { file = null; }); // a full disk must never crash main
  const write = (chunk: string | Uint8Array) => {
    if (mirror) process.stderr.write(chunk);
    if (file && !file.writableEnded) file.write(chunk);
  };
  const sink = new Writable({
    write(chunk: Uint8Array, _encoding, done) {
      write(chunk);
      done();
    },
  });
  return {
    sink,
    line(message: string) {
      write(`${new Date().toISOString()} [main] ${message.replace(/\s+/g, ' ').slice(0, 1000)}\n`);
    },
    close() {
      file?.end();
      file = null;
    },
  };
}
