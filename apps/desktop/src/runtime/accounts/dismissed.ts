// Dismissed detected logins (PR5): removing an account that detection would adopt again – a login
// in the default CLI home or a local model server – remembers it in kv (ns 'accounts', key
// 'dismissed'), so detection stops adding it back and the detection row offers "Add again".
// Keys: '<provider>:default' for a default-home login, '<provider>:<baseUrl>' for a local server.
// Owns: the dismissal keys and marking them in a DetectionReport. Never: touches accounts or homes.

import type { Db } from '../db/database.ts';
import type { Account, DetectionReport, ProviderId } from '../../shared/model/providers.ts';
import { KvRepo } from '../store/kv.ts';

const NS = 'accounts';
const KEY = 'dismissed';
const MAX = 100;

export const loginKey = (provider: ProviderId | DetectionReport['clis'][number]['provider']): string => `${provider}:default`;
export const serverKey = (provider: ProviderId, baseUrl: string): string => `${provider}:${baseUrl}`;

/** The key detection would adopt this account by; undefined for accounts detection never adds. */
export function dismissalKey(account: Pick<Account, 'provider' | 'auth' | 'home' | 'baseUrl'>): string | undefined {
  if (account.auth === 'cli') return account.home === undefined ? loginKey(account.provider) : undefined;
  return account.auth === 'local' && account.baseUrl ? serverKey(account.provider, account.baseUrl) : undefined;
}

export class DismissedLogins {
  private readonly kv: KvRepo;
  private readonly now: () => number;

  constructor(db: Db, now: () => number) {
    this.kv = new KvRepo(db);
    this.now = now;
  }

  list(): string[] {
    const value = this.kv.get<unknown>(NS, KEY);
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string').slice(-MAX) : [];
  }

  add(key: string): void {
    this.kv.set(NS, KEY, [...this.list().filter((entry) => entry !== key), key].slice(-MAX), this.now());
  }

  /** True when the key was dismissed (and is not any more). */
  delete(key: string): boolean {
    const list = this.list();
    if (!list.includes(key)) return false;
    this.kv.set(NS, KEY, list.filter((entry) => entry !== key), this.now());
    return true;
  }

  /** The report with every dismissed login and server marked `dismissed`. */
  mark(report: DetectionReport): DetectionReport {
    const keys = new Set(this.list());
    if (!keys.size) return report;
    return {
      ...report,
      clis: report.clis.map((cli) => (keys.has(loginKey(cli.provider)) ? { ...cli, dismissed: true } : cli)),
      localServers: report.localServers.map((server) => (keys.has(serverKey(server.provider, server.baseUrl)) ? { ...server, dismissed: true } : server)),
    };
  }
}
