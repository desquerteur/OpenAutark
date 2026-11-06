// Test fixtures for the RPC server (package R3-S1): a services object built on the chat/task
// harness plus real settings, run journal and blob store, fake dispatcher/host/extras, and a
// small client for in-memory connections.
// Owns: fixtures only. Never imported by src/.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { harness } from '../chat/harness.ts';
import { tempDir } from '../store/helpers.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { nullLogger } from '../../../src/runtime/system/log.ts';
import { RpcServer } from '../../../src/runtime/rpc/server.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import type { HandlerModule } from '../../../src/runtime/rpc/table.ts';
import { memoryConnection } from '../../../src/runtime/rpc/connection.ts';
import type { MemoryClient } from '../../../src/runtime/rpc/connection.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { Dispatcher, Paths, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope, RpcEvent, RpcResponse } from '../../../src/shared/api/protocol.ts';
import type { ModelPolicy } from '../../../src/shared/model/providers.ts';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import { register as system } from '../../../src/runtime/rpc/handlers/system.ts';
import { register as org } from '../../../src/runtime/rpc/handlers/org.ts';
import { register as chats } from '../../../src/runtime/rpc/handlers/chats.ts';
import { register as tasks } from '../../../src/runtime/rpc/handlers/tasks.ts';
import { register as knowledge } from '../../../src/runtime/rpc/handlers/knowledge.ts';
import { register as files } from '../../../src/runtime/rpc/handlers/files.ts';

export const OWNER: ClientScope = { kind: 'owner' };
export const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_phone', capabilities: ['todo', 'chat', 'tasks'] };
export const TODO_ONLY: ClientScope = { kind: 'device', deviceId: 'dev_todo', capabilities: ['todo'] };

/** The six S1 modules (S2's modules are tested by R3-S2). */
export const S1_MODULES: HandlerModule[] = [system, org, chats, tasks, knowledge, files];

export function s1Table(): HandlerTable {
  const table = new HandlerTable();
  for (const register of S1_MODULES) register(table);
  return table;
}

export class FakeDispatcher {
  active: AgentActivity[] = [];
  interrupts: Array<{ agentId: string; conversationId?: string }> = [];
  urgents: Array<{ agentId: string; conversationId: string }> = [];
  start(): void {}
  async stop(): Promise<void> {}
  async interrupt(agentId: string, conversationId?: string): Promise<void> { this.interrupts.push({ agentId, conversationId }); }
  async urgent(agentId: string, conversationId: string): Promise<void> { this.urgents.push({ agentId, conversationId }); }
  activity(): AgentActivity[] { return this.active; }
}

export function fakeExtras(): RpcExtras & { policyStore: Map<string, ModelPolicy>; exchanges: Array<{ secret: string; name?: string }> } {
  const policyStore = new Map<string, ModelPolicy>();
  const exchanges: Array<{ secret: string; name?: string }> = [];
  const key = (scope: { agentId?: string; conversationId?: string }) => `${scope.agentId ?? ''}|${scope.conversationId ?? ''}`;
  const extras = {
    policyStore,
    exchanges,
    policies: {
      get: (scope: { agentId?: string; conversationId?: string }) => policyStore.get(key(scope)) ?? null,
      set: (scope: { agentId?: string; conversationId?: string }, policy: ModelPolicy) => { policyStore.set(key(scope), policy); },
    },
    system: {
      info: () => ({ version: '0.2.0', platform: 'test', arch: 'x64', dataDir: '/data', deviceId: 'dev_self', deviceName: 'Test PC', packaged: false, startedAt: 0 }),
      resources: () => ({ freeMemoryMb: 1, totalMemoryMb: 8, cpuCount: 4, heavySlots: 1, heavyInUse: 0, queued: 0, processes: [] }),
      restartReadiness: () => ({ ready: true, reasons: [] }),
      prepareRestart: async () => {},
    },
    pwa: {
      exchange: (secret: string, input: { name?: string }) => {
        if (secret !== 'good-secret') throw Object.assign(new Error('expired'), { code: 'forbidden', message: 'This link has expired or was already used.' });
        exchanges.push({ secret, name: input.name });
        return { token: 'device-token', deviceId: 'dev_new' };
      },
    },
  };
  return extras as unknown as RpcExtras & { policyStore: Map<string, ModelPolicy>; exchanges: Array<{ secret: string; name?: string }> };
}

/** Real chat/task/schedule services + settings, runs, blobs; fake dispatcher, host and extras. */
export function rpcFixture(options: { table?: HandlerTable } = {}) {
  const h = harness();
  const temp = tempDir('wf-rpc-');
  const paths: Paths = {
    data: path.join(temp.dir, 'data'), workspace: path.join(temp.dir, 'workspace'), resources: path.join(temp.dir, 'resources'),
    blobs: path.join(temp.dir, 'data', 'blobs'), accounts: path.join(temp.dir, 'data', 'accounts'),
    logs: path.join(temp.dir, 'logs'), temp: path.join(temp.dir, 'tmp'),
  };
  for (const dir of [paths.data, paths.workspace, paths.accounts, paths.temp]) mkdirSync(dir, { recursive: true });
  const opened: Array<{ path: string; reveal?: boolean }> = [];
  const dispatcher = new FakeDispatcher();
  const services = h.services as RuntimeServices;
  Object.assign(services, {
    paths,
    log: nullLogger,
    dispatcher: dispatcher as unknown as Dispatcher,
    settings: new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } }),
    runs: new Journal({ db: h.db, bus: h.bus, clock: h.clock }),
    files: new Blobs({ db: h.db, blobs: paths.blobs, clock: h.clock, log: nullLogger }),
    host: { ...services.host, openPath: async (target: string, reveal?: boolean) => { opened.push({ path: target, reveal }); } },
  });
  const extras = fakeExtras();
  const server = new RpcServer({ services: () => services, extras: () => extras, table: options.table ?? s1Table(), log: nullLogger });
  return { ...h, services, paths, dispatcher, extras, server, opened, cleanup: () => { server.close(); temp.cleanup(); } };
}

/** A connected in-memory client with promise-based calls. */
export class TestClient {
  readonly raw: MemoryClient;
  readonly detach: () => void;
  private nextId = 1;

  constructor(server: RpcServer, scope: ClientScope) {
    const pair = memoryConnection();
    this.raw = pair.client;
    this.detach = server.attach(pair.server, scope);
  }

  /** Sends a request and resolves with the full response frame. */
  request(method: string, params?: unknown): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const off = this.raw.onFrame((frame) => {
        const response = frame as RpcResponse;
        if (response && typeof response === 'object' && response.id === id && !('event' in response)) { off(); resolve(response); }
      });
      this.raw.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  /** Resolves with the result or rejects with the error data. */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await this.request(method, params);
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    return response.result as T;
  }

  events(name?: string): RpcEvent[] {
    return this.raw.received.filter((frame): frame is RpcEvent => typeof frame === 'object' && frame !== null && 'event' in frame)
      .filter((frame) => !name || frame.event === name);
  }
}

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
