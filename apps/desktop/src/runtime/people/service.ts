// PeopleService (F-52): the people of the organisation next to its agents. The owner of this PC is
// the first person ('human', the admin; their name is the profile name); everyone else is created
// by the owner (Team › People), invited with a one-time link / QR code / short code bound to them
// (people/tokens.ts, people/join.ts – the owner allows each device on a host-bound to-do), and then
// connects with a person-scoped device token: ClientScope kind 'person', never the owner's scope.
// Revoking cuts every token and invite at once (the RPC server drops live connections on
// `person.upserted`), ends their chats and returns their open work (people/offboard.ts); every
// change of access is audited (people_audit). A person may manage agents and people, and an agent
// or a person may manage a person (managerId: one org chart).
// Owns: people rows, invites, joins, revocation, authentication of person tokens, audit, events.
// Never: grants owner rights, treats a person's or agent's message as the owner's consent, or keeps
// plain tokens, tickets or codes.

import type { AccessTicket, AccessWait } from '../../shared/api/methods.ts';
import type { ClientScope } from '../../shared/api/protocol.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, newId } from '../../shared/ids.ts';
import type { Avatar } from '../../shared/model/org.ts';
import type { Message } from '../../shared/model/chat.ts';
import { isPersonId, type Person, type PersonAudit, type PersonInvite, type PersonScopes } from '../../shared/model/people.ts';
import type { Bus } from '../bus.ts';
import type { Clock, Logger, RuntimeServices, SettingsService } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { defaultAvatar } from '../org/avatar.ts';
import { cleanAvatar, cleanName, cleanText } from '../org/validate.ts';
import { JoinRequests, type Timers } from './join.ts';
import { checkPersonManager } from './manager.ts';
import { offboard } from './offboard.ts';
import { PeopleRepo, activePerson, cleanScopes } from './repo.ts';
import { PersonTokens } from './tokens.ts';

export interface PeopleDeps {
  db: Db;
  clock: Clock;
  bus: Bus;
  log: Logger;
  settings: SettingsService;
  /** The runtime's services (chats, tasks, org; the owner's decision to-dos), handed over lazily. */
  services(): Pick<RuntimeServices, 'db' | 'chats' | 'tasks' | 'org'> & Partial<Pick<RuntimeServices, 'notifications'>> | undefined;
  /** The address people open (https / LAN / tailnet first); `reachable` false when only this PC's loopback exists. */
  address(): { url: string; reachable: boolean } | undefined;
  qr(text: string): Promise<string>;
  timers?: Timers;
}

export interface SaveInput { id?: string; name?: string; title?: string; avatar?: Avatar; managerId?: string | null; scopes?: PersonScopes }

export class PeopleService {
  readonly repo: PeopleRepo;
  readonly tokens: PersonTokens;
  readonly joins: JoinRequests;
  private readonly deps: PeopleDeps;

  constructor(deps: PeopleDeps) {
    this.deps = deps;
    this.repo = new PeopleRepo(deps.db);
    this.tokens = new PersonTokens(deps.db, deps.clock);
    this.joins = new JoinRequests({
      now: () => deps.clock.now(), bus: deps.bus, log: deps.log, timers: deps.timers,
      services: () => deps.services() as never,
      describe: (id) => { const person = this.repo.get(id); return person && person.status !== 'revoked' && !person.owner ? this.label(person) : undefined; },
      issue: (id, name) => this.admit(id, name),
      changed: (id, action, details) => this.record(id, 'system', action, details),
    });
  }

  /** The owner's row exists (title 'CEO' at first); called once at start. */
  ensureOwner(): Person {
    const found = this.repo.get(HUMAN_ID);
    if (found) return this.withName(found);
    const now = this.deps.clock.now();
    const owner: Person = {
      id: HUMAN_ID, name: '', title: 'CEO', avatar: { kind: 'initials', value: '' }, status: 'active', owner: true,
      scopes: { spaces: 'all', startChats: true, assignAgents: true }, createdAt: now, updatedAt: now, joinedAt: now,
    };
    this.repo.save(owner);
    return this.withName(owner);
  }

  // ------------------------------------------------------------------ reads

  /** Everyone, the owner first, with devices and open invites (the owner's view). */
  list(): Person[] {
    if (!this.repo.get(HUMAN_ID)) this.ensureOwner();
    return this.repo.list().map((person) => this.full(person));
  }

  get(id: string): Person | undefined {
    const person = this.repo.get(id);
    return person ? this.full(person) : undefined;
  }

  require(id: string): Person {
    return this.get(id) ?? (() => { throw new WorkforceError('not_found', 'Person not found.', { details: { personId: id } }); })();
  }

  /** A person's display name (the owner: the profile name, else "CEO"); undefined for unknown ids. */
  nameOf(id: string): string | undefined {
    if (id === HUMAN_ID) return this.ownerName();
    if (!isPersonId(id)) return undefined;
    return this.repo.get(id)?.name;
  }

  audit(id: string, limit?: number): PersonAudit[] { this.require(id); return this.repo.auditOf(id, limit); }

  // ------------------------------------------------------------------ owner changes

  /** A new person (status invited) or an edit; `by` is 'human' (only the owner edits people). */
  save(input: SaveInput): Person {
    const now = this.deps.clock.now();
    const current = input.id ? this.repo.get(input.id) : undefined;
    if (input.id && !current) throw new WorkforceError('not_found', 'Person not found.', { details: { personId: input.id } });
    if (current?.status === 'revoked' && input.scopes) throw new WorkforceError('conflict', 'Invite this person again first.');
    const id = current?.id ?? newId('per', now);
    const name = input.name !== undefined ? cleanName(input.name) : current?.name;
    if (!name && id !== HUMAN_ID) throw new WorkforceError('bad_request', 'Enter a name.', { details: { field: 'name' } });
    const next: Person = current ? { ...current } : {
      id, name: name ?? '', title: '', avatar: defaultAvatar(id, name ?? ''), status: 'invited', owner: false,
      scopes: cleanScopes({}), createdAt: now, updatedAt: now,
    };
    if (id !== HUMAN_ID && name) {
      if (current?.avatar.kind === 'initials' && input.avatar === undefined && name !== current.name) next.avatar = defaultAvatar(id, name);
      next.name = name;
    }
    if (input.title !== undefined) next.title = cleanText(input.title, 'title', 80).trim();
    if (input.avatar !== undefined) next.avatar = cleanAvatar(input.avatar);
    if (input.scopes !== undefined && id !== HUMAN_ID) next.scopes = this.checkScopes(input.scopes);
    if (input.managerId !== undefined) next.managerId = checkPersonManager(this.repo, this.deps.services()?.org, id, input.managerId ?? undefined);
    next.updatedAt = now;
    this.deps.db.tx(() => {
      this.repo.save(next);
      const changed = Object.keys(input).filter((key) => key !== 'id');
      this.repo.audit(id, now, HUMAN_ID, current ? 'updated' : 'created', { fields: changed });
    });
    return this.emit(id);
  }

  /** A fresh invite (link/QR 72 h and a 6-digit code 10 min); replaces an open one. */
  async invite(id: string): Promise<PersonInvite> {
    const person = this.require(id);
    if (person.owner) throw new WorkforceError('bad_request', 'The owner does not need an invite.');
    const address = this.deps.address();
    if (!address) throw new WorkforceError('unavailable', 'This PC has no address people can open yet.');
    const { ticket, expiresAt } = this.tokens.createInvite(id);
    const code = this.joins.newCode(id);
    if (person.status === 'revoked') this.repo.save({ ...this.repo.get(id)!, status: 'invited', revokedAt: undefined, updatedAt: this.deps.clock.now() });
    this.record(id, HUMAN_ID, 'invited', { reachable: address.reachable });
    const url = `${address.url}/#join=${ticket}`;
    const invite: PersonInvite = { personId: id, url, qrDataUrl: await this.deps.qr(url), code: code.code, codeExpiresAt: code.expiresAt, expiresAt, reachable: address.reachable };
    this.emit(id);
    return invite;
  }

  closeInvite(id: string): void {
    this.require(id);
    const closed = this.tokens.closeInvites(id);
    this.joins.dropCode(id);
    if (closed) this.record(id, HUMAN_ID, 'invite_closed', {});
    this.emit(id);
  }

  /** Ends a person's access at once: tokens and invites, open join requests, chats, open work. */
  revoke(id: string): Person {
    const person = this.require(id);
    if (person.owner) throw new WorkforceError('bad_request', 'The owner cannot be removed.');
    const now = this.deps.clock.now();
    const reports = this.repo.reports(id).map((entry) => entry.id);
    this.tokens.revokeAll(id);
    this.joins.closeFor(id, 'This person no longer has access.');
    this.repo.save({ ...this.repo.get(id)!, status: 'revoked', revokedAt: now, updatedAt: now });
    this.emit(id); // the RPC server closes the person's live connections now
    const s = this.deps.services();
    const result = s ? offboard(s, this.repo, this.deps.log, id, now) : { chats: 0, tasks: 0, reports: 0 };
    this.record(id, HUMAN_ID, 'revoked', { ...result });
    for (const report of reports) this.emit(report);
    return this.emit(id);
  }

  /** Removes one device of a person (its token ends; the connection closes). */
  removeDevice(id: string, deviceId: string): Person {
    this.require(id);
    if (!this.tokens.revokeDevice(id, deviceId)) throw new WorkforceError('not_found', 'Device not found.', { details: { deviceId } });
    this.record(id, HUMAN_ID, 'device_removed', { deviceId });
    return this.emit(id);
  }

  /**
   * A chat's member line about a person (added / removed) becomes an audit line of that person; the
   * owner joining the people's own chat (a take-over) one of every person who is or was in it.
   */
  recordChatChange(message: Message): void {
    const status = message.kind === 'status' ? message.meta?.status : undefined;
    if (!status || (status.type !== 'member_added' && status.type !== 'member_removed')) return;
    const personId = status.details?.memberId;
    const by = typeof status.details?.by === 'string' ? status.details.by : 'system';
    if (personId === HUMAN_ID && status.type === 'member_added' && status.details?.takeover === true) {
      for (const row of this.deps.db.all<{ member_id: string }>('SELECT member_id FROM members WHERE conversation_id = ?', [message.conversationId])) {
        if (isPersonId(row.member_id)) this.record(String(row.member_id), by, 'owner_joined_chat', { conversationId: message.conversationId });
      }
    }
    if (typeof personId !== 'string' || !isPersonId(personId)) return;
    this.record(personId, by, status.type === 'member_added' ? 'chat_added' : 'chat_removed', { conversationId: message.conversationId });
  }

  // ------------------------------------------------------------------ joining (tokenless)

  join(input: { ticket?: string; code?: string; name?: string; remote?: string }): AccessTicket {
    const redeem = input.ticket !== undefined ? () => this.tokens.redeemInvite(input.ticket) : () => this.joins.redeemCode(input.code);
    return this.joins.create({ name: input.name, remote: input.remote, redeem });
  }

  awaitJoin(ticket: string, signal: AbortSignal): Promise<AccessWait> { return this.joins.wait(ticket, signal); }

  // ------------------------------------------------------------------ authentication

  /** A person token → its scope (the transport adds `secure`); undefined = not a live person token. */
  authenticate(token: string): ClientScope | undefined {
    const found = this.tokens.authenticate(token);
    if (!found) return undefined;
    const person = this.repo.get(found.personId);
    if (!person || person.status === 'revoked' || person.owner) return undefined;
    return { kind: 'person', personId: found.personId, deviceId: found.deviceId, tokenId: found.tokenId };
  }

  /** A refused token of a removed person/device (closed with 4403, the page shows "removed"). */
  revoked(token: string): boolean { return this.tokens.isRevoked(token); }

  /** The scope's token and person still hold (checked on every call and after every person change). */
  isLive(scope: ClientScope): boolean {
    if (scope.kind !== 'person' || !this.tokens.live(scope.tokenId)) return false;
    return activePerson(this.deps.db, scope.personId);
  }

  /** The person of a live scope; throws 'forbidden' when access ended meanwhile. */
  caller(scope: ClientScope): Person {
    if (scope.kind !== 'person' || !this.isLive(scope)) throw new WorkforceError('forbidden', 'This access was removed.', { details: { reason: 'removed' } });
    return this.require(scope.personId);
  }

  /** "Anna Berg · Designer". */
  label(person: Pick<Person, 'name' | 'title'>): string { return person.title ? `${person.name} · ${person.title}` : person.name; }

  // ------------------------------------------------------------------ internals

  /** Device accepted and collected: the token, status active, the audit line. */
  private admit(personId: string, name: string): { token: string; deviceId: string } {
    const person = this.repo.get(personId);
    if (!person || person.status === 'revoked') throw new WorkforceError('forbidden', 'This person no longer has access.');
    const issued = this.tokens.issue(personId, name);
    const now = this.deps.clock.now();
    this.repo.save({ ...person, status: 'active', joinedAt: person.joinedAt ?? now, updatedAt: now });
    this.record(personId, HUMAN_ID, 'joined', { deviceId: issued.deviceId, device: name });
    this.emit(personId);
    return { token: issued.token, deviceId: issued.deviceId };
  }

  private checkScopes(scopes: PersonScopes): PersonScopes {
    const clean = cleanScopes(scopes);
    if (clean.spaces !== 'all') {
      const known = new Set(this.deps.services()?.org.spaces().map((space) => space.id) ?? []);
      const unknown = clean.spaces.find((id) => !known.has(id));
      if (unknown) throw new WorkforceError('not_found', 'This space no longer exists.', { details: { spaceId: unknown } });
    }
    return clean;
  }

  private record(id: string, actor: string, action: PersonAudit['action'], details: Record<string, unknown>): void {
    try { this.repo.audit(id, this.deps.clock.now(), actor, action, details); } catch (error) {
      this.deps.log.warn('person audit not written', { personId: id, action, error: String((error as Error)?.message ?? error) });
    }
  }

  private ownerName(): string {
    try { return this.deps.settings.get().profile.name?.trim() || 'CEO'; } catch { return 'CEO'; }
  }

  private withName(person: Person): Person {
    return person.owner ? { ...person, name: this.ownerName() } : person;
  }

  private full(person: Person): Person {
    const view = this.withName(person);
    if (view.owner) return view;
    const invite = this.tokens.openInvite(view.id);
    return { ...view, devices: this.tokens.devices(view.id), ...(invite ? { inviteOpenUntil: invite } : {}) };
  }

  private emit(id: string): Person {
    const person = this.require(id);
    try { this.deps.bus.emit('person.upserted', person); } catch (error) { this.deps.log.warn('person event not sent', { error: String((error as Error)?.message ?? error) }); }
    return person;
  }
}
