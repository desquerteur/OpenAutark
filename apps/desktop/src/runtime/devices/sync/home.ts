// What a link between two PCs carries (owner 31.10. and 04.11.2026: the CEO's PCs share everything, an
// employee's PC sees its person's chats and tasks) and where an agent runs: on its home PC ("jeder hat halt was
// zu Hause"). An agent without a home (device_id NULL) lives on the PC that made it; a row leaving that PC carries
// its id (tables.ts), so the other PCs never run it too.
// Link kinds: 'ceo' – one of the CEO's own PCs (full sync both ways, turns follow the home); 'employee' – the other
// PC joined this one as an employee (it gets that person's chats and tasks; only the person's own lines and task
// changes come back, employee.ts); 'employer' – this PC joined the other one as an employee (it receives those and
// sends back only its person's own part). An agent homed on a PC linked here that
// is no 'ceo' link (an employee's PC, a removed PC) keeps its turns here, only its device tools go there; one homed
// on a PC this PC never linked runs on the CEO PC that knows it. A schedule fires on one PC only (firesHere).
// Owns: these reads. Never: writes, dials or decides wakes (the dispatcher's gate, rows.ts hands them over).

import type { RuntimeServices } from '../../contracts.ts';
import { DevicesRepo, type DeviceRecord } from '../repo.ts';

export type Link = { kind: 'ceo' } | { kind: 'employee'; personId: string } | { kind: 'employer' };

/** What the link to `record` carries; undefined for this PC, a phone, a removed or half-paired PC. */
export function linkOf(record: DeviceRecord | undefined): Link | undefined {
  if (!record || record.kind !== 'pc' || record.self || record.revokedAt || record.status === 'revoked' || record.status === 'pairing') return undefined;
  if (record.personId) return { kind: 'employee', personId: record.personId };
  return record.joinedAs === 'employee' ? { kind: 'employer' } : { kind: 'ceo' };
}

/** Every linked PC with what its link carries. */
export function links(db: RuntimeServices['db']): Array<{ record: DeviceRecord; link: Link }> {
  const out: Array<{ record: DeviceRecord; link: Link }> = [];
  for (const record of new DevicesRepo(db).list({ kinds: ['pc'] })) {
    const link = linkOf(record);
    if (link) out.push({ record, link });
  }
  return out;
}

/** This PC's device id (the devices row marked self). */
export function selfId(db: RuntimeServices['db']): string {
  return new DevicesRepo(db).self()?.id ?? '';
}

/**
 * The home of an agent whose turns do not run here, else undefined. They run here without a home, with this PC as
 * home, or with a home linked here that is no 'ceo' link (an employee's PC, a removed PC). A home this PC never
 * linked is another CEO PC's link (its turns run there) – unless this PC has no CEO link at all.
 */
export function homeElsewhere(services: Pick<RuntimeServices, 'db' | 'org'>, agentId: string): string | undefined {
  let home: string | undefined;
  try { home = services.org.get(agentId)?.deviceId; } catch { return undefined; }
  if (!home) return undefined;
  const record = new DevicesRepo(services.db).get(home);
  if (record) return linkOf(record)?.kind === 'ceo' ? home : undefined;
  return links(services.db).some(({ link }) => link.kind === 'ceo') ? home : undefined;
}

/** Whether this PC fires a schedule: an agent's where the agent runs, the person's on the CEO PC with the smallest id. */
export function firesHere(services: Pick<RuntimeServices, 'db' | 'org'>, ownerId: string): boolean {
  let agent = false;
  try { agent = Boolean(services.org.get(ownerId)); } catch { agent = false; }
  if (agent) return !homeElsewhere(services, ownerId);
  const self = selfId(services.db);
  return links(services.db).every(({ record, link }) => link.kind !== 'ceo' || record.id > self);
}
