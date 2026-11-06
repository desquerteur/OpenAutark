// Runs one adb command as a supervised, short-lived lease and collects its output (bounded).
// Owns: the exec shape AdbPhone uses (tests inject a fake AdbExec instead), the output cap and
// waiting for the pipe to drain after the exit event.
// Never: runs through a shell, or keeps adb's server process as a lease (it forks itself).

import type { Supervisor } from '../system/supervisor.ts';
import { WorkforceError } from '../../shared/errors.ts';

export interface ExecResult { code: number | null; stdout: Uint8Array; stderr: string }
export type AdbExec = (command: string, args: string[], options: { timeoutMs: number; maxBytes: number }) => Promise<ExecResult>;

/** The default AdbExec: `command args…` without a shell, killed after `timeoutMs` idle. */
export function spawnAdb(supervisor: Pick<Supervisor, 'spawn'> | undefined, command: string, args: string[], options: { timeoutMs: number; maxBytes: number }): Promise<ExecResult> {
  if (!supervisor) throw new WorkforceError('unavailable', 'Phone control is not set up in this runtime.');
  return new Promise<ExecResult>((resolve, reject) => {
    const lease = supervisor.spawn({ command, args, owner: 'adb', kind: 'light', stdio: ['ignore', 'pipe', 'pipe'], idleMs: options.timeoutMs });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let overflow = false;
    lease.child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) { overflow = true; void lease.release(); return; }
      chunks.push(chunk);
    });
    lease.child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });
    lease.child.once('error', (error) => reject(new WorkforceError('unavailable', 'adb could not be started.', { cause: error })));
    // 'exit' can come before the last stdout chunks were read (multi-MB screencaps): wait for
    // the pipe to end – bounded, because a forked adb server may keep the pipe open.
    const stdout = lease.child.stdout;
    const drained = stdout
      ? new Promise<void>((done) => { stdout.once('end', done); stdout.once('close', done); stdout.once('error', () => done()); })
      : Promise.resolve();
    void lease.exited.then(async (code) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([drained, new Promise<void>((done) => { grace = setTimeout(done, 2000); (grace as { unref?: () => void }).unref?.(); })]);
      clearTimeout(grace);
      if (overflow) { reject(new WorkforceError('conflict', 'The phone returned too much data.')); return; }
      if (code === null && !chunks.length) { reject(new WorkforceError('timeout', 'The phone did not answer in time.')); return; }
      resolve({ code, stdout: new Uint8Array(Buffer.concat(chunks)), stderr });
    });
  });
}
