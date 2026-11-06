// Data bound to one PC: values encrypted with this PC's OS key (secret values, the device
// identity, the web-push VAPID key), the `self` device row
// and the push subscriptions made for that VAPID key.
// Owns: carrying the running PC's own rows into a freshly restored database (so a restore on the same PC keeps
// working secrets and pairings and a restore on a new PC keeps the new PC's identity).
// Never: decrypts anything or touches account homes.

import type { DatabaseSync } from 'node:sqlite';

/** kv rows whose value holds a ciphertext of the OS key (devices/identity.ts, pwa/vapid.ts). */
export const BOUND_KV: ReadonlyArray<readonly [ns: string, key: string]> = [
  ['device', 'identity'],
  ['pwa', 'vapid'],
];

const DEVICE_COLUMNS = 'id, name, kind, role, fingerprint, public_key, addresses, caps, status, self, paired_at, last_seen_at, revoked_at';

function kvWhere(prefix: string): { sql: string; params: string[] } {
  return {
    sql: BOUND_KV.map(() => `(${prefix}ns = ? AND ${prefix}key = ?)`).join(' OR '),
    params: BOUND_KV.flatMap(([ns, key]) => [ns, key]),
  };
}

/**
 * Carries the running PC's bound data from `previousFile` (the database that was live before the
 * restore) into `restored`: bound kv rows, secret values by id, the `self` device row, and only
 * push subscriptions that existed there. References to a replaced `self` device fall back to
 * "this PC" (NULL).
 */
export function carryOver(restored: DatabaseSync, previousFile: string): void {
  restored.prepare('ATTACH DATABASE ? AS previous').run(previousFile);
  try {
    const kv = kvWhere('');
    const kvPrevious = kvWhere('p.');
    restored.exec('BEGIN IMMEDIATE');
    try {
      restored.prepare(`DELETE FROM main.kv WHERE ${kv.sql}`).run(...kv.params);
      restored.prepare(`INSERT INTO main.kv (ns, key, value, updated_at) SELECT p.ns, p.key, p.value, p.updated_at FROM previous.kv p WHERE ${kvPrevious.sql}`).run(...kvPrevious.params);
      restored.exec(`UPDATE main.secrets SET cipher = (SELECT p.cipher FROM previous.secrets p WHERE p.id = main.secrets.id)
        WHERE cipher IS NULL AND EXISTS (SELECT 1 FROM previous.secrets p WHERE p.id = main.secrets.id AND p.cipher IS NOT NULL)`);
      const replaced = restored.prepare(`SELECT id FROM main.devices WHERE self = 1 AND id NOT IN (SELECT id FROM previous.devices WHERE self = 1)`).all() as Array<{ id: string }>;
      restored.exec('DELETE FROM main.devices WHERE self = 1');
      restored.exec(`INSERT OR REPLACE INTO main.devices (${DEVICE_COLUMNS}) SELECT ${DEVICE_COLUMNS} FROM previous.devices WHERE self = 1`);
      for (const { id } of replaced) {
        restored.prepare('UPDATE main.agents SET device_id = NULL WHERE device_id = ?').run(id);
        restored.prepare('UPDATE main.accounts SET device_id = NULL WHERE device_id = ?').run(id);
      }
      restored.exec('DELETE FROM main.push_subscriptions WHERE endpoint NOT IN (SELECT endpoint FROM previous.push_subscriptions)');
      restored.exec('COMMIT');
    } catch (error) {
      restored.exec('ROLLBACK');
      throw error;
    }
  } finally {
    restored.exec('DETACH DATABASE previous');
  }
}
