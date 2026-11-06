// Connectors – composition of runtime/apps/: the kv namespace 'apps' (tool caches, mail marks and the sign-ins'
// 'oauth:*' keys), MCP authorization (oauth/), the MCP client (client/) with stdio servers started through the
// runtime's process supervisor, mailboxes (mail/, servers found with mailAutoconfig, new mail waking the mailbox's
// agent through mail-wake.ts), the system browser through the host and the files in <data>/connectors (service.ts).
// compose/services.ts calls createApps() once the registry and the vault exist and starts it; compose/lifecycle.ts
// stops it (step 'apps').
// Owns: this wiring and the KV adapter. Never: behaviour, a token, header or env value, or starting a server.

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/root.ts'; // RuntimeServices.rootWatcher
import { KvRepo } from '../store/kv.ts';
import type { Supervisor } from '../system/supervisor.ts';
import { connectMcp, supervisorSpawner } from './client/index.ts';
import { mailAutoconfig } from './mail/index.ts';
import { MailWaker } from './mail-wake.ts';
import { createAppOAuth } from './oauth/index.ts';
import { Apps } from './service.ts';
import type { AppKv, StdioSpawner } from './types.ts';

export type { AppsService } from './types.ts';

/** The KV namespace of every connector key. */
export const APPS_NS = 'apps';
/** client_name of the sign-in registration at a server's authorization server. */
export const OAUTH_CLIENT_NAME = 'Autark';
/** clientInfo.name of the MCP handshake. */
export const MCP_CLIENT_NAME = 'workforce';

export interface CreateAppsDeps {
  /** The runtime's process supervisor (compose/services.ts); without it the client uses a private one. */
  supervisor?: Pick<Supervisor, 'spawn'>;
  /** The app version the MCP handshake reports. */
  version?: string;
  /** Test seam: finds a mailbox's servers (default mail/ mailAutoconfig over the network). */
  mailAutoconfig?: typeof mailAutoconfig;
}

/** The 'apps' namespace of the kv table; keys(prefix) reads the keys only. */
export function appsKv(services: Pick<RuntimeServices, 'db' | 'clock'>): AppKv {
  const repo = new KvRepo(services.db);
  return {
    get: <T>(key: string) => repo.get<T>(APPS_NS, key),
    set: (key, value) => repo.set(APPS_NS, key, value, services.clock.now()),
    delete: (key) => { repo.delete(APPS_NS, key); },
    keys: (prefix = '') => services.db
      .all<{ key: string }>('SELECT key FROM kv WHERE ns = ? AND substr(key, 1, ?) = ? ORDER BY key', [APPS_NS, prefix.length, prefix])
      .map((row) => String(row.key)),
  };
}

/** The connectors service on the real parts. */
export function createApps(services: RuntimeServices, deps: CreateAppsDeps = {}): Apps {
  const kv = appsKv(services);
  const spawn: StdioSpawner | undefined = deps.supervisor ? supervisorSpawner(deps.supervisor, 'app') : undefined;
  const findMail = deps.mailAutoconfig ?? mailAutoconfig;
  let apps: Apps | undefined;
  const waker = new MailWaker({ services, connected: (id) => apps?.connected(id) });
  apps = new Apps({
    services,
    dataDir: services.paths.data,
    kv,
    oauth: createAppOAuth({ secrets: services.secrets, kv, clientName: OAUTH_CLIENT_NAME }),
    connect: (target, opts) => connectMcp(target, spawn ? { ...opts, spawn } : opts),
    openExternal: (url) => services.host.openExternal(url),
    clientInfo: { name: MCP_CLIENT_NAME, version: deps.version || 'dev' },
    now: () => services.clock.now(),
    mailAutoconfig: async (address) => {
      const found = await findMail(address);
      if ('unsupported' in found) return { unsupported: found.unsupported };
      return { imap: found.imap, smtp: found.smtp, ...(found.user ? { user: found.user } : {}) };
    },
    onNewMail: (id, info) => waker.notice(id, info),
  });
  const stop = apps.stop.bind(apps);
  apps.stop = async () => { waker.close(); await stop(); };
  return apps;
}
