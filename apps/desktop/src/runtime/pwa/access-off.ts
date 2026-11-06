// The first start after phone access was switched off in 0.3.x (B-078 D5 dropped the switch; settings.pwa.enabled ===
// false is what is left of it): access becomes exactly the accepted rows the owner sees. The phones and browsers
// paired before B-078 (their tokens lack 'permissions', tokens.ts olderDevices) are removed like Remove does
// (token, push subscriptions, row revoked), colleagues' phone/browser tokens end (they join again by invite), and the
// HTTP port goes back to this PC only (bind 'localhost'), as off meant. Then pwa.enabled is written true, so this runs
// once. A phone paired by Remote ID in this build keeps its token.
// Owns: that one-time closing. Never: touches linked PCs, the owner's own window or CLI, or runs while access was on.

import type { RuntimeServices } from '../contracts.ts';
import type { PwaService } from './service.ts';

type Deps = Pick<RuntimeServices, 'db' | 'clock' | 'log' | 'settings'>;

/** Closes what 0.3.x had switched off; returns how many devices and colleague tokens ended (tests). */
export async function closeAccessTurnedOff(s: Deps, pwa: Pick<PwaService, 'revoke' | 'tokens'>): Promise<{ devices: number; people: number } | undefined> {
  let settings;
  try { settings = s.settings.get().pwa; } catch { return undefined; }
  if (settings.enabled !== false) return undefined;
  const devices = pwa.tokens.olderDevices();
  for (const deviceId of devices) {
    try { await pwa.revoke(deviceId); } catch (error) { s.log.warn('a device of switched-off phone access stayed', { deviceId, error: String(error) }); }
  }
  const people = s.db.all<{ device_id: string | null }>(`SELECT device_id FROM tokens WHERE kind = 'person' AND revoked_at IS NULL`);
  s.db.run(`UPDATE tokens SET revoked_at = ? WHERE kind = 'person' AND revoked_at IS NULL`, [s.clock.now()]);
  for (const row of people) if (row.device_id) s.db.run('DELETE FROM push_subscriptions WHERE device_id = ?', [row.device_id]);
  s.settings.update({ pwa: { enabled: true, bind: 'localhost' } });
  if (devices.length || people.length) s.log.info('phone access was off: earlier devices removed', { devices: devices.length, people: people.length });
  return { devices: devices.length, people: people.length };
}
