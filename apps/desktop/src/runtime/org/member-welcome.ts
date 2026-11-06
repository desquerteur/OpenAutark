// B-078 (D15/D20, owner 06.11.2026: "dass Mitarbeiter praktisch persönlichen Assistent bekommen"): when an employee
// joins the organisation (their first device is admitted, people/join.ts), the owner's personal manager gets one wake
// that names them – a personal manager or assistant of their own is its to set up (skill head-of-staff). One wake per
// person, ever: a marker in kv, and the wake coalesces per person while it waits. People already active before B-078
// are marked once at start (markExistingMembers), so only someone who really joins now is welcomed.
// Owns: that wake and its marker. Never: hires an agent itself, wakes for the owner, or puts a person into the origin.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { managerAgent } from '../../shared/text/manager-chat.ts';

export type WelcomeServices = Pick<RuntimeServices, 'db' | 'org' | 'wakes' | 'clock'>;

const NAMESPACE = 'member-welcome';
/** The key (no person id has this shape) marking that the people from before B-078 were marked once. */
const BACKFILLED = ':before-b078';

/** The note the personal manager reads, in its own voice. */
export function welcomeNote(label: string, personId: string): string {
  return `${label} (${personId}) just joined our organisation. A personal manager or assistant of their own is mine to set up, as the head-of-staff skill shows: who they are for this person, reporting to them, a first line – and one line to ${label.split(' · ')[0]} saying who works for them now.`;
}

/** One wake for the owner's personal manager about a person who joined; false when nothing was woken. */
export function welcomeMember(s: WelcomeServices, person: { id: string; label: string }): boolean {
  const kv = new KvRepo(s.db);
  if (kv.get(NAMESPACE, person.id) !== undefined) return false;
  const manager = managerAgent(s.org.list());
  if (!manager) return false;
  s.db.tx(() => {
    s.wakes.wake({
      agentId: manager.id, reason: 'event', coalesceKey: `${NAMESPACE}:${person.id}`,
      origin: { source: 'people', label: 'Someone joined' },
      note: welcomeNote(person.label, person.id),
    });
    kv.set(NAMESPACE, person.id, { at: s.clock.now(), agentId: manager.id }, s.clock.now());
  });
  return true;
}

/**
 * Once, at the first start of B-078 (kv marker): every person already active in the organisation counts as welcomed –
 * a second phone or a re-accepted PC of someone who joined in October is no new member. Returns how many were marked.
 */
export function markExistingMembers(s: Pick<RuntimeServices, 'db' | 'clock'>): number {
  const kv = new KvRepo(s.db);
  if (kv.get(NAMESPACE, BACKFILLED) !== undefined) return 0;
  const now = s.clock.now();
  let marked = 0;
  s.db.tx(() => {
    let rows: Array<{ id: string }> = [];
    try { rows = s.db.all<{ id: string }>(`SELECT id FROM people WHERE status = 'active' AND id <> ?`, [HUMAN_ID]); } catch { rows = []; }
    for (const { id } of rows) {
      if (kv.get(NAMESPACE, id) !== undefined) continue;
      kv.set(NAMESPACE, id, { at: now, before: true }, now);
      marked++;
    }
    kv.set(NAMESPACE, BACKFILLED, { at: now }, now);
  });
  return marked;
}

/** True when `s` carries what welcomeMember needs (the join flow sees a narrower service view). */
export function canWelcome(s: object | undefined): s is WelcomeServices {
  const v = s as Partial<WelcomeServices> | undefined;
  return Boolean(v?.db && v.org && v.wakes && v.clock);
}
