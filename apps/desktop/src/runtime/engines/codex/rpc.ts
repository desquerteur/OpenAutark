// Newline-delimited JSON-RPC client for `codex app-server --listen stdio://`.
// Owns: request/response matching, notifications fan-out, server→client requests (answered by
// a handler; unknown methods get -32601), timeouts and connection failure.
// Never: knows thread/turn semantics (server.ts / engine.ts do) or logs message bodies.

import type { ChildLike } from '../../system/supervisor.ts';
import { readJsonLines, isRecord } from '../shared.ts';

export interface RpcNotification { method: string; params: Record<string, unknown> }
export type ServerRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export class RpcError extends Error {
  readonly rpcCode: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.rpcCode = code;
    this.data = data;
  }
}

export class RpcClient {
  private readonly child: ChildLike;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(n: RpcNotification) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private sequence = 0;
  private closed: Error | undefined;
  handler: ServerRequestHandler | undefined;

  constructor(child: ChildLike) {
    this.child = child;
    const fail = (reason: string) => this.close(new Error(`codex connection closed (${reason})`));
    if (!child.stdout || !child.stdin) throw new Error('codex child needs piped stdio');
    readJsonLines(child.stdout, (message) => this.receive(message), fail);
    child.stdin.on('error', () => fail('stdin'));
    child.once('exit', () => fail('exit'));
    child.once('error', () => fail('spawn'));
  }

  get isClosed(): boolean { return this.closed !== undefined; }

  onNotification(listener: (n: RpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.closed) { listener(this.closed); return () => {}; }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(-32000, `codex did not answer ${method}`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }

  close(error: Error = new Error('codex connection closed')): void {
    if (this.closed) return;
    this.closed = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    for (const listener of this.closeListeners) { try { listener(error); } catch { /* isolate */ } }
    this.closeListeners.clear();
  }

  private write(message: unknown): void {
    if (this.closed) throw this.closed;
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new Error('codex stdin unavailable');
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: unknown): void {
    if (!isRecord(message)) return;
    const id = message.id;
    const method = typeof message.method === 'string' ? message.method : undefined;
    if (method && id !== undefined && id !== null) { void this.answerServer(id, method, isRecord(message.params) ? message.params : {}); return; }
    if (method) {
      const note = { method, params: isRecord(message.params) ? message.params : {} };
      for (const listener of this.listeners) { try { listener(note); } catch { /* isolate */ } }
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : -32000;
      const text = typeof message.error.message === 'string' ? message.error.message.slice(0, 300) : 'codex error';
      entry.reject(new RpcError(code, text, message.error.data));
    } else entry.resolve(message.result);
  }

  private async answerServer(id: unknown, method: string, params: Record<string, unknown>): Promise<void> {
    let reply: Record<string, unknown>;
    if (!this.handler) reply = { id, error: { code: -32601, message: 'This action is not available.' } };
    else {
      try { reply = { id, result: await this.handler(method, params) }; }
      catch (error) {
        const code = error instanceof RpcError ? error.rpcCode : -32603;
        reply = { id, error: { code, message: error instanceof RpcError ? error.message : 'The request failed.' } };
      }
    }
    try { this.write(reply); } catch { /* connection gone */ }
  }
}
