// Port selection for the runtime HTTP server: the configured port first, then the port that
// was chosen last time it was busy (kept in kv so installed PWAs keep their origin), then an
// ephemeral port; re-listening on another host with the same port (bind changes).
// Owns: listen-with-fallback and that one remembered value.
// Never: decides the bind host (settings do) or retries beyond a few short, bounded attempts.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeServices } from '../contracts.ts';
import type { Settings } from '../../shared/model/system.ts';
import { KvRepo } from '../store/kv.ts';

/** Default port of the runtime HTTP server. */
export const DEFAULT_PORT = 47811;

/**
 * Listen address for `settings.pwa.bind`: this computer only, or every interface for LAN /
 * tailnet access (the Host allowlist and tokens still apply to every request).
 */
export function bindHostFor(bind: Settings['pwa']['bind']): string {
  return bind === 'localhost' ? '127.0.0.1' : '0.0.0.0';
}

const KV_NS = 'http';
const KV_KEY = 'fallbackPort';

/** Listens once; rejects with the listen error (EADDRINUSE …). */
export function listenOn(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Port busy or reserved (Windows reports excluded port ranges as EACCES). */
export function isBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

export function rememberedPort(services: RuntimeServices): number | undefined {
  try {
    const value = new KvRepo(services.db).get<number>(KV_NS, KV_KEY);
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
  } catch {
    return undefined; // no database (tests, early start): nothing remembered
  }
}

export function rememberPort(services: RuntimeServices, port: number): void {
  try {
    new KvRepo(services.db).set(KV_NS, KV_KEY, port, services.clock.now());
  } catch { /* best effort */ }
}

/**
 * Listens on `host` with the configured port, the remembered fallback, then an ephemeral port.
 * Every attempt uses a fresh server from `create` (a failed server is discarded). A configured
 * port of 0 means "ephemeral" (tests) and is never remembered.
 */
export async function listenWithFallback(create: () => Server, host: string, configured: number, services: RuntimeServices): Promise<{ server: Server; port: number }> {
  const remembered = configured > 0 ? rememberedPort(services) : undefined;
  const candidates = [configured];
  if (remembered && remembered !== configured) candidates.push(remembered);
  if (configured !== 0) candidates.push(0);
  let lastError: unknown;
  for (const port of candidates) {
    const server = create();
    try {
      const chosen = await listenOn(server, host, port);
      if (configured > 0 && chosen !== configured && chosen !== remembered) rememberPort(services, chosen);
      return { server, port: chosen };
    } catch (error) {
      server.close();
      if (!isBusy(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Listens on `port` at the first of `hosts` that works. A busy port is retried a few times
 * (the previous listener on that port is still closing); other errors skip to the next host.
 */
export async function relisten(create: () => Server, hosts: readonly string[], port: number, stopped: () => boolean): Promise<{ server: Server; host: string } | undefined> {
  for (const host of hosts) {
    for (const wait of [0, 50, 250, 1000]) {
      if (wait) await delay(wait, undefined, { ref: false });
      if (stopped()) return undefined;
      const server = create();
      try {
        await listenOn(server, host, port);
        return { server, host };
      } catch (error) {
        server.close();
        if (!isBusy(error)) break;
      }
    }
  }
  return undefined;
}
