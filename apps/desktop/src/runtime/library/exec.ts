// One external program call for the public library (B-078 D13): git to clone and update a source, gh to publish with the
// person's own GitHub sign-in. No shell, a time limit, an output cap, non-interactive (no prompt, no pager).
// Owns: that call and its result shape. Never: decides what is run (sources.ts, publish.ts) or reads a token.

import { execFile } from 'node:child_process';

export interface RunResult { code: number; stdout: string; stderr: string; missing?: boolean }
export type Run = (command: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; input?: string }) => Promise<RunResult>;

const MAX_BUFFER = 8 * 1024 * 1024;

export const runCommand: Run = (command, args, options) => new Promise((resolve) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_PAGER: 'cat', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  const child = execFile(command, [...args], { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, env, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (!error) { resolve({ code: 0, stdout, stderr }); return; }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') { resolve({ code: -1, stdout: '', stderr: `${command} is not installed`, missing: true }); return; }
    resolve({ code: typeof code === 'number' ? code : 1, stdout: stdout ?? '', stderr: stderr || error.message });
  });
  if (options.input !== undefined) child.stdin?.end(options.input);
});
