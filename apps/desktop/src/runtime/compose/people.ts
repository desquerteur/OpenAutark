// Composition of the people of the organisation (F-52, called by compose/network.ts once phone
// access exists): the PeopleService on the database, settings and the runtime's services, the
// address people open (pwa/service.ts phoneUrl: https / LAN / tailnet first, this PC's loopback as
// the last resort, marked not reachable) and the QR renderer. B-078 (D5): no phone switch gates people
// any more – a person gets in while their accepted device row and token live.
// It also guards the hazard of parallel version numbers: a database whose schema passed 41 (42)
// before migration 41 (42) existed gets the people tables (agents.person_manager_id) here once, with a warning.
// Owns: this wiring and that guard. Never: behaviour, timers or polling.

import type { Logger, RuntimeServices } from '../contracts.ts';
import '../contracts/people.ts';
import type { Db } from '../db/database.ts';
import { sql as peopleTables } from '../db/migrations/041-people.ts';
import { sql as personManagerColumn } from '../db/migrations/042-agent-person-manager.ts';
import { PeopleService } from '../people/service.ts';
import { phoneUrl, type PwaService } from '../pwa/service.ts';

/** Adds the column of migration 42 when this database skipped it; true when it had to. */
export function ensurePersonManagerColumn(db: Db, log?: Logger): boolean {
  if (db.all<{ name: string }>('PRAGMA table_info(agents)').some((column) => column.name === 'person_manager_id')) return false;
  log?.warn('people: this database skipped migration 42 (its schema version was already higher) - adding agents.person_manager_id now');
  db.tx(() => db.exec(personManagerColumn));
  return true;
}

/** Creates the tables of migration 41 when this database skipped it; true when it had to. */
export function ensurePeopleTables(db: Db, log?: Logger): boolean {
  const found = db.get<{ n: number }>(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'people'`)?.n ?? 0;
  if (found) return false;
  log?.warn('people: this database skipped migration 41 (its schema version was already higher) - creating the people tables now');
  db.tx(() => db.exec(peopleTables));
  return true;
}

export function createPeople(s: RuntimeServices, pwa: Pick<PwaService, 'urls'>, qr: (text: string) => Promise<string>): PeopleService {
  ensurePeopleTables(s.db, s.log);
  ensurePersonManagerColumn(s.db, s.log);
  const people = new PeopleService({
    db: s.db, clock: s.clock, bus: s.bus, log: s.log, settings: s.settings,
    services: () => s,
    address: () => {
      const urls = pwa.urls();
      const best = phoneUrl(urls);
      return best ? { url: best, reachable: true } : urls[0] ? { url: urls[0], reachable: false } : undefined;
    },
    qr,
  });
  people.ensureOwner();
  s.bus.on('message.created', (message) => { try { people.recordChatChange(message); } catch (error) { s.log.warn('people: chat audit failed', { error: String(error) }); } });
  s.people = people;
  return people;
}
