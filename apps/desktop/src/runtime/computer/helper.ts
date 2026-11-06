// Client for the persistent Windows helper process (one `powershell.exe -NoProfile
// -NonInteractive` speaking JSON lines). Started lazily on the first call, leased from the
// supervisor (below-normal priority, hidden window) and idle-killed after 5 minutes. The same client
// runs the Linux AT-SPI helper (computer/drivers.ts: another command, args and start-failure text).
// Owns: start/ready handshake, request ids, per-request timeouts, restart after a hang or crash, a short
// cool-down after repeated start failures, and the helper's "the person moved the mouse mid-path" as a
// 'conflict' with details.humanActive (B-055, HUMAN_ACTIVE).
// Never: retries a request by itself (an input action must never run twice) or polls.

import type { Logger } from '../contracts.ts';
import type { Lease, Supervisor } from '../system/supervisor.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { encodeRequest, errorCodeOf, HELPER_PROTOCOL, HUMAN_ACTIVE, LineDecoder, type HelperMessage, type HelperOp, type HelperReady } from './protocol.ts';

/** What ComputerService needs from a helper (tests inject a fake). */
export interface HelperClient {
  call<T = unknown>(op: HelperOp, args?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
  running(): boolean;
  dispose(): Promise<void>;
}

export interface WindowsHelperDeps {
  supervisor: Pick<Supervisor, 'spawn'>;
  scriptPath: string;
  log: Logger;
  command?: string; // default powershell.exe (Windows PowerShell 5.1 – present on every Windows 10/11)
  /** The command's arguments (default: PowerShell running scriptPath); computer/drivers.ts sets them for other platforms. */
  args?: string[];
  /** What a start failure says (default: the Windows PowerShell texts). */
  startFailure?: { exit: string; timeout: string; repeated: string };
  idleMs?: number; // default 5 min
  startTimeoutMs?: number; // default 45 s (Add-Type compiles the C# part once per process)
  now?: () => number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

const DEFAULT_TIMEOUT = 20_000;
const FAILURE_WINDOW_MS = 60_000;

export class WindowsHelper implements HelperClient {
  private readonly deps: WindowsHelperDeps;
  private lease: Lease | undefined;
  private starting: Promise<Lease> | undefined;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private failures: number[] = [];
  private stderrTail = '';
  ready: HelperReady | undefined;

  constructor(deps: WindowsHelperDeps) {
    this.deps = deps;
  }

  running(): boolean {
    return Boolean(this.lease && this.ready);
  }

  async call<T = unknown>(op: HelperOp, args: Record<string, unknown> = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    options.signal?.throwIfAborted();
    const lease = await this.ensure();
    // The process may have died between the start and this call: fail now instead of writing
    // into a closed pipe and waiting for the timeout.
    if (this.lease !== lease || lease.child.exitCode !== null) {
      throw new WorkforceError('unavailable', 'The computer-use helper stopped. Re-observe before trying again.');
    }
    const id = ++this.sequence;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    lease.touch();
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        settled: false,
        resolve: (value) => { if (entry.settled) return; entry.settled = true; cleanup(); resolve(value as T); },
        reject: (error) => { if (entry.settled) return; entry.settled = true; cleanup(); reject(error); },
        timer: setTimeout(() => {
          entry.reject(new WorkforceError('timeout', `The computer did not answer "${op}" in time. The helper was restarted; re-observe before trying again.`));
          // A hung UIA call blocks every later request: restart instead of queueing behind it.
          void this.restart(lease, 'timeout');
        }, timeoutMs),
      };
      (entry.timer as { unref?: () => void }).unref?.();
      const onAbort = () => entry.reject(new WorkforceError('cancelled', 'Stopped.'));
      const cleanup = () => {
        clearTimeout(entry.timer);
        options.signal?.removeEventListener('abort', onAbort);
        // A late reply of a cancelled or timed-out request finds no entry and is dropped.
        this.pending.delete(id);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, entry);
      try {
        lease.child.stdin!.write(encodeRequest({ id, op, args }));
      } catch (error) {
        entry.reject(new WorkforceError('unavailable', 'The computer-use helper is not reachable.', { cause: error }));
      }
    });
  }

  async dispose(): Promise<void> {
    const lease = this.lease;
    this.lease = undefined;
    this.ready = undefined;
    this.rejectAll(new WorkforceError('cancelled', 'The computer-use helper was stopped.'));
    if (lease) await lease.release();
  }

  // ------------------------------------------------------------------ process

  private ensure(): Promise<Lease> {
    if (this.lease && this.ready && this.lease.child.exitCode === null) return Promise.resolve(this.lease);
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<Lease> {
    const now = this.deps.now?.() ?? Date.now();
    this.failures = this.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    if (this.failures.length >= 3) {
      throw new WorkforceError('unavailable', this.deps.startFailure?.repeated ?? 'The Windows computer-use helper failed to start several times. Try again in a minute.', { retryAfterMs: FAILURE_WINDOW_MS });
    }
    const lease = this.deps.supervisor.spawn({
      command: this.deps.command ?? 'powershell.exe',
      args: this.deps.args ?? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.deps.scriptPath],
      owner: 'computer:windows-helper',
      kind: 'light',
      stdio: ['pipe', 'pipe', 'pipe'],
      idleMs: this.deps.idleMs ?? 5 * 60_000,
      onIdle: () => this.deps.log.debug('computer helper idle, stopping'),
    });
    this.lease = lease;
    this.ready = undefined;
    this.stderrTail = '';
    const decoder = new LineDecoder();
    let onReady: ((ready: HelperReady) => void) | undefined;
    const readyPromise = new Promise<HelperReady>((resolve) => { onReady = resolve; });
    lease.child.stdout?.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) this.receive(message, onReady);
    });
    lease.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-2000);
    });
    lease.child.stdin?.on('error', () => undefined); // EPIPE after exit is handled by the exit path
    let exitedEarly: ((code: number | null) => void) | undefined;
    const exitPromise = new Promise<number | null>((resolve) => { exitedEarly = resolve; });
    void lease.exited.then((code) => {
      exitedEarly?.(code);
      if (this.lease === lease) {
        this.lease = undefined;
        this.ready = undefined;
        this.rejectAll(new WorkforceError('unavailable', 'The computer-use helper stopped. Re-observe before trying again.'));
      }
    });

    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      startTimer = setTimeout(() => resolve('timeout'), this.deps.startTimeoutMs ?? 45_000);
      (startTimer as { unref?: () => void }).unref?.();
    });
    const outcome = await Promise.race([readyPromise, exitPromise.then(() => 'exit' as const), timeout]);
    clearTimeout(startTimer);
    if (outcome === 'timeout' || outcome === 'exit') {
      this.failures.push(this.deps.now?.() ?? Date.now());
      this.deps.log.warn('computer helper did not start', { outcome, stderr: this.stderrTail.slice(-500) });
      if (this.lease === lease) this.lease = undefined;
      await lease.release();
      throw new WorkforceError('unavailable', outcome === 'exit'
        ? this.deps.startFailure?.exit ?? 'The Windows computer-use helper could not start (PowerShell is blocked or failed).'
        : this.deps.startFailure?.timeout ?? 'The Windows computer-use helper did not start in time.');
    }
    this.ready = outcome;
    if (outcome.protocol !== HELPER_PROTOCOL) this.deps.log.warn('computer helper protocol mismatch', { expected: HELPER_PROTOCOL, got: outcome.protocol });
    if (!outcome.dpiAware) this.deps.log.warn('computer helper is not DPI aware; coordinates may be scaled');
    return lease;
  }

  private receive(message: HelperMessage, onReady: ((ready: HelperReady) => void) | undefined): void {
    if (message.kind === 'ready') { onReady?.(message.ready); return; }
    if (message.kind === 'noise') { this.deps.log.debug('computer helper output', { line: message.line.slice(0, 200) }); return; }
    const response = message.response;
    const entry = this.pending.get(response.id);
    this.lease?.touch();
    if (!entry) return; // late answer of a timed-out or cancelled request
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new WorkforceError(errorCodeOf(response.error.code), response.error.message, response.error.code === HUMAN_ACTIVE ? { details: { humanActive: true } } : {}));
  }

  private async restart(lease: Lease, reason: string): Promise<void> {
    if (this.lease !== lease) return;
    this.deps.log.warn('restarting computer helper', { reason });
    this.lease = undefined;
    this.ready = undefined;
    this.rejectAll(new WorkforceError('unavailable', 'The computer-use helper was restarted. Re-observe before trying again.'));
    await lease.release();
  }

  private rejectAll(error: WorkforceError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
