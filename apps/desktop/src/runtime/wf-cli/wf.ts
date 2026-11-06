#!/usr/bin/env node
// Entry of the wf terminal client (C7), bundled to app/wf.mjs (scripts/build.mjs target 'wf'):
//   node app/wf.mjs [--data <dir>] [--json] <command> …      npm run wf -- <command> …
// Platform actions from a shell for people, scripts and other programs, over the runtime's own
// RPC with the owner token of this PC (runtime.json). See `wf help`.
// Owns: process wiring – argv, stdin, stdout/stderr, Ctrl+C, the exit code.
// Never: imports runtime modules (src/shared and this folder only – scripts/check-boundaries.mjs),
// prints the token, or exits before piped output was written.

import { nodeDiscoverEnv } from './discover.ts';
import { runCli } from './run.ts';

declare const __APP_VERSION__: string | undefined;

/** Text piped into `wf call <method> -` or `wf send <chat> -`. */
const MAX_STDIN = 16 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    size += buffer.length;
    if (size > MAX_STDIN) throw new Error('The input on stdin is larger than 16 MB.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const interrupt = new AbortController();
let interrupts = 0;
process.on('SIGINT', () => {
  if (++interrupts > 1) process.exit(130); // a second Ctrl+C does not wait
  interrupt.abort();
});
// `wf events … | head -1`: a closed pipe ends the client quietly.
process.stdout.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') process.exit(0); });

const code = await runCli(process.argv.slice(2), {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
  stdin: readStdin,
  env: nodeDiscoverEnv(),
  interrupt: interrupt.signal,
  now: Date.now,
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
});
// Exit once both streams are flushed (pipes may be asynchronous).
process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
