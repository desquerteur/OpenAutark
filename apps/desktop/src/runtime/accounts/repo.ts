// Accounts table repository.
// Owns: row ↔ Account mapping and the few queries AccountService needs.
// Never: stores secrets (only `secret_id` references and, for auth 'env', the variable's name in
// `env_var`) or emits events.

import type { Db, Row } from '../db/database.ts';
import { bool, int, json, toJson } from '../db/database.ts';
import type { Account } from '../../shared/model/providers.ts';

function toAccount(row: Row): Account {
  const opt = <T>(value: unknown): T | undefined => (value === null || value === undefined ? undefined : (value as T));
  return {
    id: String(row.id), provider: row.provider as Account['provider'], label: String(row.label), auth: row.auth as Account['auth'],
    home: opt<string>(row.home), baseUrl: opt<string>(row.base_url), secretId: opt<string>(row.secret_id), envVar: opt<string>(row.env_var),
    state: row.state as Account['state'], plan: opt<string>(row.plan), email: opt<string>(row.email),
    limits: json<Account['limits']>(row.limits, undefined), coolingUntil: opt<number>(row.cooling_until),
    priority: Number(row.priority), rotation: bool(row.rotation), enabled: bool(row.enabled), detected: bool(row.detected),
    deviceId: opt<string>(row.device_id), createdAt: Number(row.created_at), checkedAt: opt<number>(row.checked_at),
  };
}

export class AccountRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  list(): Account[] {
    return this.db.all('SELECT * FROM accounts ORDER BY priority, created_at').map(toAccount);
  }

  get(id: string): Account | undefined {
    const row = this.db.get('SELECT * FROM accounts WHERE id = ?', [id]);
    return row ? toAccount(row) : undefined;
  }

  save(a: Account): Account {
    this.db.run(`INSERT INTO accounts (id, provider, label, auth, home, base_url, secret_id, env_var, state, plan, email, limits, cooling_until, priority, rotation, enabled, detected, device_id, created_at, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, label = excluded.label, auth = excluded.auth, home = excluded.home,
        base_url = excluded.base_url, secret_id = excluded.secret_id, env_var = excluded.env_var, state = excluded.state, plan = excluded.plan,
        email = excluded.email, limits = excluded.limits, cooling_until = excluded.cooling_until, priority = excluded.priority,
        rotation = excluded.rotation, enabled = excluded.enabled, detected = excluded.detected, device_id = excluded.device_id,
        checked_at = excluded.checked_at`, [
      a.id, a.provider, a.label, a.auth, a.home ?? null, a.baseUrl ?? null, a.secretId ?? null, a.envVar ?? null, a.state, a.plan ?? null,
      a.email ?? null, a.limits ? toJson(a.limits) : null, a.coolingUntil ?? null, a.priority, int(a.rotation), int(a.enabled), int(a.detected),
      a.deviceId ?? null, a.createdAt, a.checkedAt ?? null,
    ]);
    return a;
  }

  remove(id: string): void {
    this.db.run('DELETE FROM accounts WHERE id = ?', [id]);
  }
}
