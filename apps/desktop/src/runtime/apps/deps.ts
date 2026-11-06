// What the connectors service (service.ts) is built from: the slice of RuntimeServices it needs, the
// mailbox lookup and its constructor arguments. Shapes only; the real parts are wired in index.ts and
// tests pass fakes.
// Owns: AppsServices, MailAutoconfig, AppsDeps. Never: behaviour.

import type { MailServer } from '../../shared/model/apps.ts';
import type { Bus } from '../bus.ts';
import type { Logger } from '../contracts.ts';
import type { SecretService } from '../contracts/safety.ts';
import type { RootWatcher } from '../root/watcher.ts';
import type { Timers } from '../schedules/scheduler.ts';
import type { ToolDef } from '../tools/types.ts';
import type { NewMailInfo } from './connections.ts';
import type { AppKv, AppOAuth, McpConnectOptions, McpConnection, McpTarget } from './types.ts';

/** What the service needs of RuntimeServices (the real ones fit; tests pass fakes). */
export interface AppsServices {
  bus: Pick<Bus, 'emit'>;
  secrets: Pick<SecretService, 'use'>;
  /** The tool registry; `unregister` exists on the real one (runtime/tools/registry.ts). */
  tools: { register(tool: ToolDef): void; unregister?(name: string): void };
  log?: Logger;
  /** The data folder watcher (absent: the files are read at start only). */
  rootWatcher?: Pick<RootWatcher, 'register'>;
}

export type MailAutoconfig = { imap: MailServer; smtp: MailServer; user?: string } | { unsupported: string };

export interface AppsDeps {
  services: AppsServices;
  /** <data>: the connectors live in <data>/connectors. */
  dataDir: string;
  /** kv namespace 'apps': the tool caches ('tools:<id>'), the mail marks ('mailmark:<id>'), the sign-ins ('oauth:*'). */
  kv: AppKv;
  /** runtime/apps/client: opens one MCP connection. */
  connect: (target: McpTarget, opts: McpConnectOptions) => Promise<McpConnection>;
  /** runtime/apps/oauth: MCP authorization; `invalidate` drops an access token the server refused. */
  oauth: AppOAuth & { invalidate?(appId: string): void };
  /** Opens the sign-in page in the system browser. */
  openExternal: (url: string) => void | Promise<void>;
  clientInfo: { name: string; version: string };
  now?: () => number;
  timers?: Timers;
  /** stdio idle stop (default 10 minutes). */
  idleMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Finds a mailbox's servers from its address (runtime/apps/mail autoconfig). */
  mailAutoconfig?: (address: string) => Promise<MailAutoconfig | undefined>;
  /** New mail in an enabled, connected mailbox (index.ts: mail-wake.ts wakes its agent). */
  onNewMail?: (appId: string, info: NewMailInfo) => void;
}
