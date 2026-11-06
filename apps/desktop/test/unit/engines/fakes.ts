// Test doubles: fake child processes, a scripted spawn and an executable finder.
// Owns: nothing in production. Never imported by src/.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildLike, SpawnFn, SpawnOptions, OsLike } from '../../../src/runtime/system/supervisor.ts';
import { Supervisor } from '../../../src/runtime/system/supervisor.ts';
import type { ExecutableFinder, Executable } from '../../../src/runtime/accounts/executables.ts';

let pids = 1000;

export class FakeChild extends EventEmitter {
  pid = ++pids;
  exitCode: number | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  readonly lines: unknown[] = [];
  private buffer = '';
  onLine?: (message: any, child: FakeChild) => void;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { message = line; }
        this.lines.push(message);
        this.onLine?.(message, this);
      }
    });
  }

  send(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }

  exit(code = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }

  kill(): boolean { this.killed = true; setImmediate(() => this.exit(137)); return true; }
}

export interface SpawnCall { command: string; args: string[]; options: SpawnOptions; child: FakeChild }

export function fakeSpawn(setup: (call: SpawnCall) => void = () => {}): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    const call = { command, args, options, child };
    calls.push(call);
    setup(call);
    return child as unknown as ChildLike;
  };
  return { spawn, calls };
}

export const fakeOs = (free = 4 * 1024 ** 3, cores = 4, platform: NodeJS.Platform = 'linux'): OsLike & { priorities: number[] } => {
  const priorities: number[] = [];
  return { freemem: () => free, cpuCount: () => cores, setPriority: (pid) => { priorities.push(pid); }, platform, priorities };
};

export function testSupervisor(spawn: SpawnFn): Supervisor {
  return new Supervisor({ spawn, os: fakeOs(), killTree: async () => {} });
}

export function fakeFinder(map: Record<string, string | null>): ExecutableFinder {
  return {
    find: async (id: string) => (map[id] ? ({ command: map[id]!, prefixArgs: [], path: map[id]! } as Executable) : null),
    clear: () => {},
  } as unknown as ExecutableFinder;
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export function account(patch: Record<string, unknown> = {}): any {
  return { id: 'acc_test', provider: 'codex', label: 'Codex', auth: 'cli', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1, ...patch };
}

export function turnInput(patch: Record<string, unknown> = {}): any {
  const events: any[] = [];
  const approvals: any[] = [];
  const toolCalls: any[] = [];
  const input = {
    runId: 'run_1', agentId: 'ag_1', account: account(), model: 'gpt-test', effort: 'medium',
    system: { stable: 'STABLE', volatile: 'VOLATILE' },
    input: [{ type: 'text', text: 'hello' }],
    tools: [{ name: 'tasks.create', description: 'Create a task', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }],
    callTool: async (name: string, args: unknown, callId: string) => { toolCalls.push({ name, args, callId }); return { content: [{ type: 'text', text: `created ${JSON.stringify(args)}` }] }; },
    cwd: '/work', approve: async (request: unknown) => { approvals.push(request); return 'allow'; },
    onEvent: (event: unknown) => { events.push(event); },
    signal: new AbortController().signal,
    ...patch,
  };
  return { input, events, approvals, toolCalls };
}

/** In-memory file operations for CLI engines (Claude's prompt and MCP files): nothing touches the disk. */
export function memoryFiles(stored: Record<string, Uint8Array> = {}) {
  const written = new Map<string, string>();
  const removed: string[] = [];
  const files = {
    writeFile: async (file: string, data: string) => { written.set(file, data); },
    readFile: async (file: string) => { if (!stored[file]) throw new Error('not found'); return stored[file]; },
    rm: async (file: string) => { removed.push(file); },
    mkdir: async () => {},
  };
  return { files, written, removed };
}

// ------------------------------------------------------------------ scripted ACP agent (PR7)

/** One running `session/prompt` of the scripted ACP agent. */
export interface FakeAcpTurn {
  child: FakeChild;
  msg: any;
  sessionId: string;
  /** The prompt's text blocks joined (instructions/context block included). */
  text: string;
  update(update: Record<string, unknown>): void;
  /** Agent → client request (e.g. session/request_permission); the reply lands in state.replies. */
  request(id: number | string, method: string, params: Record<string, unknown>): void;
  end(stopReason?: string, extra?: Record<string, unknown>): void;
  fail(code: number, message: string): void;
}

export interface FakeAcpOptions {
  /** Merged over the default initialize result (protocol 1, loadSession, images, HTTP MCP, one auth method). */
  init?: Record<string, unknown>;
  /** Extra fields of the session/new|load|resume result (e.g. models, configOptions). */
  session?: Record<string, unknown>;
  /** Handles a client message first; return true when it answered. */
  handle?(msg: any, reply: { result(value: unknown): void; error(code: number, message: string): void }, child: FakeChild): boolean;
  /** Drives a prompt; default: one "Echo: <last text block>" chunk, then end_turn. */
  onPrompt?(turn: FakeAcpTurn): void;
  /** Ignore session/cancel (the agent never confirms). */
  ignoreCancel?: boolean;
}

/** A scripted ACP agent over FakeChild: records requests and replies, answers the protocol basics. */
export function acpAgent(options: FakeAcpOptions = {}) {
  const state = { requests: [] as any[], replies: new Map<unknown, any>(), sessions: [] as string[], prompts: new Map<string, any>(), onReply: undefined as ((reply: any) => void) | undefined };
  const { spawn, calls } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg?.method) state.requests.push(msg);
      if (msg?.id !== undefined && !msg.method) { state.replies.set(msg.id, msg); state.onReply?.(msg); return; }
      const reply = {
        result: (value: unknown) => child.send({ jsonrpc: '2.0', id: msg.id, result: value }),
        error: (code: number, message: string) => child.send({ jsonrpc: '2.0', id: msg.id, error: { code, message } }),
      };
      if (options.handle?.(msg, reply, child)) return;
      switch (msg.method) {
        case 'initialize':
          reply.result({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true } }, authMethods: [{ id: 'oauth', name: 'Sign in' }], ...options.init });
          break;
        case 'session/new': {
          const sessionId = `sess_${state.sessions.length + 1}`;
          state.sessions.push(sessionId);
          reply.result({ sessionId, ...options.session });
          break;
        }
        case 'session/load':
        case 'session/resume':
          reply.result({ ...options.session });
          break;
        case 'session/prompt': {
          const sessionId = msg.params.sessionId;
          state.prompts.set(sessionId, msg);
          const blocks = (msg.params.prompt ?? []).filter((b: any) => b.type === 'text');
          const done = () => state.prompts.get(sessionId) === msg && state.prompts.delete(sessionId);
          const turn: FakeAcpTurn = {
            child, msg, sessionId, text: blocks.map((b: any) => b.text).join('\n'),
            update: (update) => child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }),
            request: (id, method, params) => child.send({ jsonrpc: '2.0', id, method, params }),
            end: (stopReason = 'end_turn', extra = {}) => { if (done()) reply.result({ stopReason, ...extra }); },
            fail: (code, message) => { if (done()) reply.error(code, message); },
          };
          (options.onPrompt ?? ((t: FakeAcpTurn) => { t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Echo: ${blocks.at(-1)?.text ?? ''}` } }); t.end(); }))(turn);
          break;
        }
        case 'session/cancel': {
          const pending = state.prompts.get(msg.params.sessionId);
          if (pending && !options.ignoreCancel) { state.prompts.delete(msg.params.sessionId); child.send({ jsonrpc: '2.0', id: pending.id, result: { stopReason: 'cancelled' } }); }
          break;
        }
        case 'session/set_model':
        case 'session/set_config_option':
        case 'session/close':
        case 'authenticate':
          reply.result({});
          break;
        default:
          if (msg.id !== undefined) reply.error(-32601, 'Method not found');
      }
    };
  });
  return { spawn, calls, state };
}
