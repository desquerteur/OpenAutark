// The shared ping keepalive for every upgraded socket (client + peer), split out of http/ws.ts in C8 (ws.ts re-exports
// it, so imports stay the same): one interval for all sockets, armed only while sockets exist; a socket that showed no
// sign of life since the last ping is terminated. B-077 (owner 05.11.2026: changes pushed at once, like a realtime
// database): every 15 s, on BOTH ends of a link between PCs (compose/peer-dial.ts uses it for the sockets this PC dials),
// so a dead link closes within 15–30 s on either side and the mesh's retry and catch-up start (before, the dialing side
// never noticed and kept sending into a dead link for minutes). Any frame counts as life, not only the pong (a pong can
// wait behind a big frame), and a tick that comes late because this process itself stalled pings again without
// terminating anyone (a low-RAM PC paused, not the other side).
// Owns: that interval and the alive flags. Never: closes healthy sockets or keeps one after close.

import type { WebSocket } from 'ws';

export const KEEPALIVE_MS = 15_000;

/** One interval for all sockets, armed only while sockets exist; dead peers are terminated. */
export class Keepalive {
  private readonly sockets = new Map<WebSocket, { alive: boolean }>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private last = 0;

  constructor(intervalMs = KEEPALIVE_MS, now: () => number = Date.now) {
    this.intervalMs = intervalMs;
    this.now = now;
  }

  add(ws: WebSocket): void {
    const state = { alive: true };
    this.sockets.set(ws, state);
    const alive = () => { state.alive = true; };
    ws.on('pong', alive);
    ws.on('message', alive);
    ws.once('close', () => this.remove(ws));
    if (!this.timer) {
      this.last = this.now();
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  remove(ws: WebSocket): void {
    this.sockets.delete(ws);
    if (!this.sockets.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  all(): WebSocket[] {
    return [...this.sockets.keys()];
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sockets.clear();
  }

  /** Exposed for tests: one round of the interval. */
  tick(): void {
    const now = this.now();
    const late = now - this.last > this.intervalMs * 1.5; // this process stalled: the answers may sit unread
    this.last = now;
    for (const [ws, state] of this.sockets) {
      if (!state.alive && !late) {
        ws.terminate();
        this.remove(ws);
        continue;
      }
      state.alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }
}
