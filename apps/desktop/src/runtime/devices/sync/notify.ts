// A notification decided on one of my PCs reaches the phones of all my devices (D3, owner 06.11.2026: the phone belongs
// to the company, not to one PC). The PC whose filters let it push (notify/service.ts) pushes it itself to every
// subscription it holds: its own through its channel (pwa/push.ts), and those of my other PCs, which the roster brought
// here with their keys (held-push.ts), under the same tag, so a duplicate replaces the other on the phone. A person's
// device gets nothing here (pwa/person-push.ts decides theirs).
// Compatibility: a PC on 0.3.x sends no roster, so its phones are not held here – such a PC (online, a 'ceo' link that
// never sent a roster) still gets the old hand-over 'notify.relay' – as in 0.3.x only while this PC reaches no phone
// of the owner itself (a phone paired with both PCs would alert twice) – and one from it reaches this PC's own channels.
// Owns: this fan-out and the old hand-over. Never: sends to or takes from a PC that is no 'ceo' link, or logs a text.

import { WorkforceError } from '../../../shared/errors.ts';
import type { RuntimeServices } from '../../contracts.ts';
import type { Notifications, Pushed } from '../../notify/service.ts';
import { ownerSubscriptions, pushTarget } from '../../pwa/push.ts';
import { KvRepo } from '../../store/kv.ts';
import { DevicesRepo } from '../repo.ts';
import { heldSubs, ownerHeld, pushTo } from './held-push.ts';
import { linkOf, links } from './home.ts';

export const RELAY_METHOD = 'notify.relay';
/** kv ns of the PCs that sent a roster (roster.ts marks them): they need no hand-over. */
export const ROSTER_PEERS = 'sync.roster.peers';

const URGENT = new Set(['important', 'todo', 'blocker']);
const errorText = (error: unknown) => String((error as Error)?.message ?? error);
type Services = Pick<RuntimeServices, 'db' | 'devices' | 'log' | 'host' | 'clock'>;

/** The phones of my other PCs that this PC pushes to itself (held through the roster). */
export function phonesHere(s: Pick<RuntimeServices, 'db' | 'clock'>): number {
  try { return ownerHeld(s.db, heldSubs(s.db), s.clock.now()).length; } catch { return 0; }
}

/** The pushed payload as pwa/push.ts builds it, so the service worker treats both alike. */
function payloadOf(pushed: Pushed): Record<string, unknown> {
  return {
    kind: pushed.kind, title: pushed.title.slice(0, 120), body: pushed.body.slice(0, 240), conversationId: pushed.conversationId, taskId: pushed.taskId,
    id: pushed.id, ...pushTarget(pushed), ...(pushed.silent ? { silent: true } : {}),
  };
}

/**
 * A notification that pushed here: to the held phones of my other PCs, and – while this PC has no owner phone of its
 * own – as the old hand-over to each online 'ceo' PC that never sent a roster.
 */
export function relayNotification(s: Services, pushed: Pushed): void {
  try {
    const now = s.clock.now();
    const targets = ownerHeld(s.db, heldSubs(s.db), now);
    if (targets.length) void pushTo(s, targets, payloadOf(pushed), { urgent: URGENT.has(pushed.kind) }).catch((error: unknown) => s.log.debug('held push failed', { error: errorText(error) }));
    if (ownerSubscriptions(s.db, now) > 0) return; // my phone hears it from here; a 0.3.x PC with the same phone would ring it again
    const kv = new KvRepo(s.db);
    for (const { record, link } of links(s.db)) {
      if (link.kind !== 'ceo' || kv.get(ROSTER_PEERS, record.id) || !s.devices?.online(record.id)) continue;
      s.devices.call(record.id, RELAY_METHOD, pushed).catch((error: unknown) => s.log.debug('notification not relayed', { peer: record.id, error: errorText(error) }));
    }
  } catch (error) {
    s.log.debug('notification not relayed', { error: errorText(error) });
  }
}

/** 'notify.relay' from a CEO PC on 0.3.x: this PC's phones get it. */
export async function receiveNotification(s: Pick<RuntimeServices, 'db'>, notifications: Pick<Notifications, 'relayed'>, params: unknown, from: string): Promise<{ ok: true }> {
  if (linkOf(new DevicesRepo(s.db).get(from))?.kind !== 'ceo') throw new WorkforceError('forbidden', 'Notifications come only from the CEO\'s own PCs.');
  notifications.relayed(params);
  return { ok: true };
}
