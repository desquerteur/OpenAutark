// Mailbox upkeep of the connectors service: a connected mailbox is held open so its IDLE watcher reports
// new mail; a server that cannot be reached is tried again after 1 min, doubling up to 30 min; a
// mailbox's servers are its entry's, else looked up once from its address (autoconfig).
// Owns: holding, the retry timers, the servers cache, the new-mail notice. Never: sets a connector's
// status itself (needsSignIn does), connects outside connections.use, or polls.

import { WorkforceError } from '../../shared/errors.ts';
import type { MailServer } from '../../shared/model/apps.ts';
import type { Logger } from '../contracts.ts';
import type { Timers } from '../schedules/scheduler.ts';
import type { AppConnections, NewMailInfo } from './connections.ts';
import type { MailAutoconfig } from './deps.ts';
import { clip } from './texts.ts';
import { McpAuthRequired, McpTransportError, ReconnectNeeded, type Connector } from './types.ts';

/** A held mailbox that could not open is tried again after 1 min, doubling up to 30 min. */
export const MAIL_RETRY_MS = 60_000;
export const MAIL_RETRY_MAX_MS = 30 * 60_000;

type Servers = { imap: MailServer; smtp: MailServer; user?: string };

export interface MailUpkeepDeps {
  timers: Timers;
  connections: Pick<AppConnections, 'use' | 'close'>;
  stopped(): boolean;
  /** The connector while it is on and connected. */
  connected(id: string): Connector | undefined;
  /** The mailbox refused its login: the connector says 'signin'. */
  needsSignIn(id: string): void;
  /** Keeps a background promise until it ends (the service's idle()). */
  track(work: Promise<unknown>): void;
  autoconfig?: (address: string) => Promise<MailAutoconfig | undefined>;
  onNewMail?: (appId: string, info: NewMailInfo) => void;
  log?: Logger;
}

export class MailUpkeep {
  private readonly d: MailUpkeepDeps;
  private readonly retries = new Map<string, { handle?: unknown; delay: number }>();
  private readonly found = new Map<string, Servers>();

  constructor(deps: MailUpkeepDeps) { this.d = deps; }

  /** New mail in a connected mailbox wakes its agent. */
  notice(id: string, info: NewMailInfo): void {
    if (this.d.stopped() || this.d.connected(id)?.transport !== 'mail') return;
    this.d.onNewMail?.(id, info);
  }

  /** Opens a connected mailbox so its IDLE watcher reports new mail; an unreachable server is tried again by timer. */
  hold(id: string): void {
    const pending = this.retries.get(id);
    if (pending?.handle !== undefined) { this.d.timers.clear(pending.handle); pending.handle = undefined; }
    const connector = this.d.connected(id);
    if (this.d.stopped() || connector?.transport !== 'mail' || !this.d.onNewMail) return;
    this.d.track(this.d.connections.use(connector, async () => undefined).then(() => { this.retries.delete(id); }, async (error: unknown) => {
      await this.d.connections.close(id);
      if (error instanceof ReconnectNeeded || error instanceof McpAuthRequired) {
        if (this.d.connected(id) === connector) this.d.needsSignIn(id);
        return;
      }
      if (error instanceof McpTransportError) this.retry(id);
      this.d.log?.warn('mailbox was not opened', { appId: id, error: error instanceof Error ? error.name : 'error' });
    }));
  }

  /** The connector left or was changed: its retry ends. */
  forget(id: string): void {
    const retry = this.retries.get(id);
    if (retry?.handle !== undefined) this.d.timers.clear(retry.handle);
    this.retries.delete(id);
  }

  stop(): void {
    for (const id of [...this.retries.keys()]) this.forget(id);
  }

  /** A mailbox's servers: its entry's, else looked up once from the address. */
  async serversOf(connector: Connector): Promise<Servers> {
    const mail = connector.mail;
    if (!mail) throw new WorkforceError('bad_request', 'The mailbox has no address.');
    if (mail.imap && mail.smtp) return { imap: mail.imap, smtp: mail.smtp };
    let servers = this.found.get(mail.address);
    if (!servers) {
      const looked = await this.d.autoconfig?.(mail.address);
      if (looked && 'unsupported' in looked) throw new WorkforceError('bad_request', clip(looked.unsupported));
      if (!looked) throw new WorkforceError('not_found', `The mail servers of ${mail.address} were not found – put "imap" and "smtp" into mail.json.`);
      servers = looked;
      this.found.set(mail.address, servers);
    }
    return { imap: mail.imap ?? servers.imap, smtp: mail.smtp ?? servers.smtp, ...(servers.user ? { user: servers.user } : {}) };
  }

  private retry(id: string): void {
    if (this.d.stopped()) return;
    const prev = this.retries.get(id);
    const delay = prev ? Math.min(prev.delay * 2, MAIL_RETRY_MAX_MS) : MAIL_RETRY_MS;
    const entry: { handle?: unknown; delay: number } = { delay };
    entry.handle = this.d.timers.set(() => { entry.handle = undefined; this.hold(id); }, delay);
    this.retries.set(id, entry);
  }
}
