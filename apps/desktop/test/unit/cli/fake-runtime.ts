// Test helpers for the wf terminal client (C7): a small fake runtime on 127.0.0.1 that speaks the
// /ws protocol (Hello with the owner token, request/response, topic events) and `wf()`, which runs
// the whole client in-process (runCli with Node's real WebSocket) and checks that the token never
// reaches stdout or stderr.
// Owns: the fake server and the in-process runner. Never: starts the real runtime or reads app data.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { runCli } from '../../../src/runtime/wf-cli/run.ts';
import type { DiscoverEnv } from '../../../src/runtime/wf-cli/discover.ts';
import { AT, agent, agentMember, chat, humanMember } from './fixtures.ts';

export const TOKEN = 'owner-token-wf-cli-test-5f2c9a7e1b3d4c6a8e0f';
export const manager = agent({ id: 'ag_manager0001', name: 'Manager', role: 'Manager' });
export const launch = chat({ id: 'ch_launch0001', title: 'Launch', titleNamed: true, members: [humanMember('ch_launch0001'), agentMember('ch_launch0001', manager.id)] });
export const notes = chat({ id: 'ch_notes00001', title: 'Notes', titleNamed: true });

export type Handler = (params: unknown, runtime: FakeRuntime) => unknown;

export interface FakeRuntime {
  port: number;
  hellos: Array<Record<string, unknown>>;
  calls: Array<{ method: string; params?: unknown }>;
  push(event: string, data: unknown, topic: string): void;
  closeAll(code: number): void;
  stop(): Promise<void>;
}

const BASE: Record<string, Handler> = {
  'agents.list': () => [manager],
  'chats.list': () => [launch, notes],
  'events.subscribe': () => ({ ok: true }),
  'messages.list': () => [],
};

/** A handler error the fake answers as a runtime error frame. */
export const fault = (code: string, message: string) => Object.assign(new Error(message), { code });

export async function fakeRuntime(handlers: Record<string, Handler> = {}): Promise<FakeRuntime> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const topics = new Map<ServerSocket, Set<string>>();
  const table = { ...BASE, ...handlers };
  const runtime: FakeRuntime = {
    port: (wss.address() as { port: number }).port,
    hellos: [],
    calls: [],
    push(event, data, topic) {
      for (const [ws, subscribed] of topics) if (subscribed.has(topic)) ws.send(JSON.stringify({ event, data }));
    },
    closeAll(code) { for (const ws of topics.keys()) ws.close(code, 'bye'); },
    async stop() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  wss.on('connection', (ws) => {
    let open = false;
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { id: number; method: string; params?: unknown; token?: string };
      if (!open) {
        runtime.hellos.push(frame as unknown as Record<string, unknown>);
        if (frame.token !== TOKEN) { ws.close(4401, 'unauthorized'); return; }
        open = true;
        topics.set(ws, new Set());
        return;
      }
      runtime.calls.push({ method: frame.method, params: frame.params });
      if (frame.method === 'events.subscribe') for (const topic of (frame.params as { topics: string[] }).topics) topics.get(ws)!.add(topic);
      const handler = table[frame.method];
      if (!handler) { ws.send(JSON.stringify({ id: frame.id, error: { code: 'not_found', message: 'Unknown method.', details: { method: frame.method } } })); return; }
      Promise.resolve()
        .then(() => handler(frame.params, runtime))
        .then(
          (result) => ws.send(JSON.stringify({ id: frame.id, result: result ?? null })),
          (error: { code?: string; message: string }) => ws.send(JSON.stringify({ id: frame.id, error: { code: error.code ?? 'internal', message: error.message } })),
        );
    });
    ws.on('close', () => topics.delete(ws));
  });
  return runtime;
}

export interface Run { code: number; out: string; err: string; reads: string[] }

export interface RunOptions {
  runtime?: FakeRuntime;
  /** runtime.json content; null = the file is missing. Default: the fake's port with the right token. */
  info?: Record<string, unknown> | null;
  stdin?: string;
  interrupt?: AbortSignal;
  /** The pid in runtime.json is gone. */
  dead?: boolean;
  /** Sees stdout as it grows (to stop a stream once enough arrived). */
  onOut?: (out: string) => void;
}

export async function wf(argv: string[], options: RunOptions = {}): Promise<Run> {
  let out = '';
  let err = '';
  const reads: string[] = [];
  const info = options.info === undefined ? { port: options.runtime?.port ?? 1, token: TOKEN, pid: 4242 } : options.info;
  const env: DiscoverEnv = {
    platform: process.platform, env: {}, home: process.cwd(), cwd: process.cwd(),
    readFile(file) {
      reads.push(file);
      if (!info) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return JSON.stringify(info);
    },
    alive: () => !options.dead,
  };
  const code = await runCli(['--data', 'fake-profile', ...argv], {
    stdout: (text) => { out += text; options.onOut?.(out); }, stderr: (text) => { err += text; }, stdin: async () => options.stdin ?? '',
    env, interrupt: options.interrupt ?? new AbortController().signal, now: () => AT, version: '9.9.9',
  });
  assert.ok(!out.includes(TOKEN) && !err.includes(TOKEN), 'the owner token never reaches stdout or stderr');
  return { code, out, err, reads };
}
