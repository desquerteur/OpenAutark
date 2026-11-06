// Test helper: starts the headless runtime (app/runtime-cli.mjs) in a temp data dir and talks
// to it over the real WebSocket RPC (owner token), exactly like the PWA/desktop clients do.
// Owns: process lifecycle, JSON-RPC calls, event waiting. Never: touches the user's data.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Options: dataDir, keepData, fake (default true), env, startTimeoutMs, port (default 0 = ephemeral; a restart on the same port keeps a browser's origin). */
export async function startRuntime(options = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-'));
  const args = [path.join(root, 'app', 'runtime-cli.mjs'), '--data', dataDir, '--resources', path.join(root, 'resources'), '--ui', path.join(root, 'app', 'ui'), '--port', String(options.port ?? 0)];
  if (options.fake !== false) args.push('--fake');
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WORKFORCE_TEST_DATA: dataDir, ...options.env } }); // an isolated test profile: no automatic speech-model download (voice/local/auto.ts)
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
  const info = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`runtime did not start in time\n${stderr}`)), options.startTimeoutMs ?? 60_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n').find((entry) => entry.trim().startsWith('{'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`runtime exited (${code})\n${stderr}`)); });
  });
  const client = await connect(info.port, info.token);
  return {
    dataDir, port: info.port, token: info.token, child, client,
    stderr: () => stderr,
    async stop() {
      client.close();
      child.kill('SIGTERM');
      await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); setTimeout(resolve, 8000).unref?.(); });
      if (!options.keepData) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    },
  };
}

export async function connect(port, token, client = 'cli') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ protocol: 1, token, client }));
  let next = 1;
  const pending = new Map();
  const events = [];
  const waiters = new Set();
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.event) {
      events.push(frame);
      for (const waiter of [...waiters]) if (waiter.match(frame)) { waiters.delete(waiter); waiter.resolve(frame.data); }
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.error) entry.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
    else entry.resolve(frame.result);
  });
  // A closed socket (revoked token, shutdown) fails every open and later call instead of hanging.
  let closed;
  ws.on('close', (code) => {
    closed = new Error(`connection closed (${code})`);
    for (const entry of pending.values()) entry.reject(closed);
    pending.clear();
  });
  return {
    events,
    call(method, params) {
      const id = next++;
      return new Promise((resolve, reject) => {
        if (closed) { reject(closed); return; }
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
      });
    },
    /** Resolves with the data of the first (past or future) event matching `predicate`. */
    waitFor(event, predicate = () => true, timeoutMs = 30_000) {
      const seen = events.find((frame) => frame.event === event && predicate(frame.data));
      if (seen) return Promise.resolve(seen.data);
      return new Promise((resolve, reject) => {
        const waiter = { match: (frame) => frame.event === event && predicate(frame.data), resolve };
        waiters.add(waiter);
        setTimeout(() => { if (waiters.delete(waiter)) reject(new Error(`timeout waiting for ${event}`)); }, timeoutMs).unref?.();
      });
    },
    close() { ws.close(); },
  };
}

// ---- linked PCs (MP13): waits that ignore events seen before the call, without clearing them.

/** Like client.waitFor, but only for events that arrive after this call. */
export function waitForNew(client, event, predicate = () => true, timeoutMs = 30_000) {
  const before = new Set(client.events.map((frame) => frame.data));
  return client.waitFor(event, (data) => !before.has(data) && predicate(data), timeoutMs);
}

/** Waits (event-driven, topic 'system') until `runtime` lists device `id` with `status`. */
export async function waitDeviceStatus(runtime, id, status, timeoutMs = 30_000) {
  const next = waitForNew(runtime.client, 'device.upserted', (device) => device.id === id && device.status === status, timeoutMs);
  const now = (await runtime.client.call('devices.list')).find((device) => device.id === id)?.status;
  if (now === status) { next.catch(() => undefined); return; }
  await next;
}

// ---- routing (RT10): the catalog and finished turns, event-driven.

/** Resolves with models.list once every id in `ids` is listed and available (models.updated, topic 'providers'). */
export async function waitModels(client, ids, timeoutMs = 60_000) {
  await client.call('events.subscribe', { topics: ['providers'] });
  const ready = (list) => ids.every((id) => list.some((model) => model.id === id && model.available));
  const next = waitForNew(client, 'models.updated', ready, timeoutMs);
  const now = await client.call('models.list');
  if (ready(now)) { next.catch(() => undefined); return now; }
  return next;
}

/** Runs `action` (e.g. a messages.send) and resolves with the first run matching `match` that ends after it (topic runs:<agentId>). */
export async function runEndedAfter(client, match, action, timeoutMs = 90_000) {
  const ended = waitForNew(client, 'run.upserted', (run) => run.endedAt !== undefined && match(run), timeoutMs);
  ended.catch(() => undefined); // a failing action rejects first; the caller awaits `ended` itself
  await action();
  return ended;
}

// ---- org (O8): one agent turn as a timed round trip.

/**
 * Sends `body` into a chat and resolves with `{ message, ms }`: the next final reply of `agentId`
 * there whose body matches `pattern` (subscribe to 'chat:<id>' first) and the whole round trip.
 */
export async function ask(client, conversationId, agentId, body, { pattern = /[\s\S]/, timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  const reply = waitForNew(client, 'message.updated', (message) => message.conversationId === conversationId
    && message.authorId === agentId && message.state === 'final' && pattern.test(message.body), timeoutMs);
  reply.catch(() => undefined); // a failing send rejects first; the reply is awaited below
  await client.call('messages.send', { conversationId, body });
  const message = await reply;
  return { message, ms: Date.now() - started };
}
