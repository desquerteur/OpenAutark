// B-078 D15 for an organisation that already exists (owner 06.11.: a flat "Chief of staff" with every agent under
// it, a second one per PC, the personal assistant missing): once per company (kv marker), the personal manager gets
// one wake to look at the team as it is, with the bundled skill org-setup-onboarding. The app changes nothing in the
// org itself – the shape is the manager's own work. A fresh company (the person never wrote a line yet) only gets
// the marker: its first run builds the new shape anyway.
// Owns: that one wake. Never: hires, archives, renames or moves an agent itself, or wakes twice.

import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { managerAgent } from '../../shared/text/manager-chat.ts';

type Deps = Pick<RuntimeServices, 'db' | 'org' | 'wakes' | 'clock'>;

const MARKER = { ns: 'b078', key: 'org-review' };

/** The manager's note, in its own voice. */
export const ORG_REVIEW_NOTE = [
  'Since the update the way this organisation is built is described in my bundled skill org-setup-onboarding ("clean agent organisation").',
  'I am the person\'s personal manager – their right hand and head of staff. Department heads for each real area sit beside me and report to the person; parallel work I split (Ultra) before I hire; every agent owns its own SYSTEM.md "My role".',
  'I look at our team as it is now: a head per real area beside me where an area has grown, duplicates (a second chief of staff on another PC, for example) merged or archived, a personal assistant where the person wants one, and my own role named "Personal manager" (agents.update).',
  'What I change, I tell the person in one short line; what fits as it is, stays.',
].join('\n');

/** One review wake for the personal manager of an existing organisation; false when nothing was woken. */
export function wakeOrgReview(s: Deps): boolean {
  const kv = new KvRepo(s.db);
  if (kv.get(MARKER.ns, MARKER.key) !== undefined) return false;
  const now = s.clock.now();
  const manager = managerAgent(s.org.list());
  const lived = s.db.get(`SELECT 1 AS hit FROM messages WHERE author_kind = 'human' LIMIT 1`) !== undefined;
  if (manager && lived) {
    s.wakes.wake({ agentId: manager.id, reason: 'event', coalesceKey: `${MARKER.key}:${manager.id}`, origin: { source: 'system', label: 'Update' }, note: ORG_REVIEW_NOTE });
  }
  kv.set(MARKER.ns, MARKER.key, { at: now, agentId: manager?.id, woken: Boolean(manager && lived) }, now);
  return Boolean(manager && lived);
}
