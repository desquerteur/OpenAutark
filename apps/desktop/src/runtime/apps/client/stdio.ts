// B-052 track A: the stdio transport of the MCP client – a local program (spawn.ts starts it) speaking
// newline-delimited JSON-RPC on stdin/stdout. Lines are split robustly across chunks (UTF-8 safe, CRLF too); a line
// that is not JSON-RPC is ignored and counted (hint()); stderr is only kept as its last 2 KB for one user-safe line
// when the program stops ("The app's program stopped: …", tokens and the app's own env values hidden). An exit
// rejects every waiting request (sent: true for tools/call). close(): end stdin, wait 2 s, then kill.
// Owns: that wire. Never: logs a line, an env value or stderr, or writes anything but JSON-RPC messages to stdin.

import * as path from 'node:path';
import { McpTransportError, type StdioChild, type StdioSpawner, type StdioTarget } from '../types.ts';
import { asReply, clip, isRecord, type IncomingHandler, type RpcId, type RpcNotification, type RpcReply, type RpcRequest, type Wire } from './rpc.ts';
import { childEnv, defaultResolveDeps, defaultSpawner, resolveCommand, startErrorOf, type ResolveDeps } from './spawn.ts';

export const STDERR_KEEP = 2048;
/** A longer stdout line is dropped (and counted) instead of growing the buffer without end. */
export const MAX_LINE = 16 * 1024 * 1024;
const CLOSE_WAIT_MS = 2_000;
const KILL_WAIT_MS = 3_000;
const EXIT_GRACE_MS = 50; // lets the last stderr bytes arrive before the message is built
const ERRORISH = /error|cannot|can't|not found|denied|failed|missing|invalid|unauthori[sz]ed|refused|forbidden/i;

interface Pending { resolve(reply: RpcReply): void; reject(error: Error): void; toolCall: boolean }

/** One stderr line made safe to show: no control characters, no secret-looking runs, none of `secrets`. */
export function redactLine(text: string, secrets: string[]): string {
  let out = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join('[hidden]');
  out = out.replace(/\b(bearer|basic|token)(\s+)([^\s"',;]+)/gi, (_whole, name: string, gap: string) => `${name}${gap}[hidden]`);
  out = out.replace(/\b([\w-]*(?:token|api[_-]?key|apikey|secret|password|passwd|pwd|authorization|auth|credential)[\w-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi,
    (_whole, name: string, sep: string) => `${name}${sep}[hidden]`);
  out = out.replace(/[A-Za-z0-9_\-]{20,}={0,2}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? '[hidden]' : run));
  return out.replace(/\s+/g, ' ').trim();
}

export class StdioWire implements Wire {
  private readonly child: StdioChild;
  private readonly incoming: IncomingHandler;
  private readonly secrets: string[];
  private readonly program: string;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly exited: Promise<void>;
  private stderr = '';
  private stderrCut = false;
  private badLines = 0;
  private failure: string | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;

  /** Resolves the command (Windows shims), builds the env and starts the program. */
  static async start(target: StdioTarget, deps: { spawn?: StdioSpawner; resolve?: ResolveDeps; incoming: IncomingHandler }): Promise<StdioWire> {
    const resolved = await resolveCommand(target.command, target.args, deps.resolve ?? defaultResolveDeps(), target.cwd);
    if ('refused' in resolved) throw new McpTransportError(resolved.refused, false);
    let child: StdioChild;
    try {
      child = (deps.spawn ?? defaultSpawner)(resolved.command, resolved.args, { env: childEnv(target.env), cwd: target.cwd });
    } catch {
      throw new McpTransportError('The app\'s program could not be started.', false);
    }
    return new StdioWire(child, target, deps.incoming);
  }

  constructor(child: StdioChild, target: StdioTarget, incoming: IncomingHandler) {
    this.child = child;
    this.incoming = incoming;
    this.secrets = Object.values(target.env ?? {}).filter((value) => value.length >= 6);
    this.program = clip(path.basename(target.command.replace(/\\/g, '/')) || 'program', 60);
    (child.stdin as unknown as { on?: (event: string, listener: () => void) => void }).on?.('error', () => undefined); // EPIPE is no crash
    let markExit!: () => void;
    this.exited = new Promise<void>((resolve) => { markExit = resolve; });
    child.once('exit', () => { markExit(); this.scheduleStop(); });
    void this.readOut(child.stdout as AsyncIterable<string | Uint8Array>);
    if (child.stderr) void this.readErr(child.stderr as AsyncIterable<string | Uint8Array>);
  }

  send(message: RpcRequest, signal: AbortSignal, toolCall: boolean): Promise<RpcReply> {
    if (this.failure) return Promise.reject(new McpTransportError(this.failure, false));
    if (this.closing) return Promise.reject(new McpTransportError('The connection to the app is closed.', false));
    return new Promise<RpcReply>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const onAbort = () => { this.pending.delete(message.id); reject(signal.reason); };
      const done = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(message.id, { resolve: (reply) => { done(); resolve(reply); }, reject: (error) => { done(); reject(error); }, toolCall });
      if (!this.write(message)) {
        this.pending.delete(message.id);
        done();
        reject(new McpTransportError(this.failure ?? 'The app\'s program stopped.', false));
      }
    });
  }

  async deliver(message: RpcNotification | RpcReply): Promise<void> {
    if (!this.failure && !this.closing) this.write(message);
  }

  negotiated(): void { /* stdio has no per-request headers */ }
  reset(): void { /* no session */ }

  hint(): string | undefined {
    return this.badLines > 0 ? 'The app\'s program wrote text that is not MCP.' : undefined;
  }

  async close(): Promise<void> {
    if (this.closing) { await this.waitExit(KILL_WAIT_MS); return; }
    this.closing = true;
    this.rejectAll((entry) => new McpTransportError('The connection to the app was closed.', entry.toolCall));
    try { this.child.stdin.end(); } catch { /* gone */ }
    if (await this.waitExit(CLOSE_WAIT_MS)) return;
    try { this.child.kill(); } catch { /* gone */ }
    await this.waitExit(KILL_WAIT_MS);
  }

  // ------------------------------------------------------------------ internals

  private write(message: RpcRequest | RpcNotification | RpcReply): boolean {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); return true; } catch { return false; }
  }

  private waitExit(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void this.exited.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private async readOut(stdout: AsyncIterable<string | Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    let scanFrom = 0;
    let dropping = false;
    try {
      for await (const chunk of stdout) {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        let start = 0;
        let newline = buffer.indexOf('\n', scanFrom);
        while (newline >= 0) {
          const line = buffer.slice(start, newline);
          start = newline + 1;
          if (dropping) { dropping = false; this.badLines++; } else this.line(line);
          newline = buffer.indexOf('\n', start);
        }
        buffer = buffer.slice(start);
        scanFrom = buffer.length;
        if (buffer.length > MAX_LINE) { buffer = ''; scanFrom = 0; dropping = true; }
      }
      buffer += decoder.decode();
      if (buffer.trim() && !dropping) this.line(buffer);
    } catch { /* the stream broke: the exit decides */ }
    this.scheduleStop();
  }

  private async readErr(stderr: AsyncIterable<string | Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stderr) {
        this.stderr += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        if (this.stderr.length > STDERR_KEEP) { this.stderr = this.stderr.slice(-STDERR_KEEP); this.stderrCut = true; }
      }
    } catch { /* ignore */ }
  }

  private line(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { this.badLines++; return; }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isRecord(message)) { this.badLines++; continue; }
      const reply = asReply(message);
      if (reply) {
        const entry = this.pending.get(reply.id);
        if (entry) { this.pending.delete(reply.id); entry.resolve(reply); }
        continue;
      }
      try { this.incoming(message); } catch { /* isolate */ }
    }
  }

  private scheduleStop(): void {
    if (this.stopTimer || this.failure) return;
    this.stopTimer = setTimeout(() => {
      this.failure = this.stopMessage();
      const failure = this.failure;
      this.rejectAll((entry) => new McpTransportError(failure, entry.toolCall));
    }, EXIT_GRACE_MS);
  }

  private rejectAll(error: (entry: Pending) => Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error(entry));
  }

  private stopMessage(): string {
    const start = startErrorOf(this.child);
    if (start === 'ENOENT') return `The app's program was not found: ${this.program}.`;
    if (start) return 'The app\'s program could not be started.';
    const line = this.stderrLine();
    if (line) return `The app's program stopped: ${line}`;
    if (this.badLines) return 'The app\'s program stopped (it wrote text that is not MCP).';
    return 'The app\'s program stopped.';
  }

  private stderrLine(): string | undefined {
    let lines = this.stderr.split(/\r?\n|\r/);
    if (this.stderrCut) lines = lines.slice(1); // the first kept line is cut off
    const usable = lines.map((line) => line.trim()).filter(Boolean);
    const pick = usable.find((line) => ERRORISH.test(line)) ?? usable[0];
    if (!pick) return undefined;
    const safe = redactLine(pick, this.secrets);
    return safe.length > 160 ? `${safe.slice(0, 160)}…` : safe;
  }
}
