// People (F-52): real humans as first-class members of the one organisation, next to the agents.
// The owner of this PC (the CEO, member id 'human') is the first person and the admin; everyone
// else is invited (Team › People › Invite: a one-time link / QR code / short code bound to that
// person) and connects a phone or browser with a person-scoped token – never the owner's scope.
// One org chart: an agent's or a person's manager may be a person or an agent. Chats hold people
// and agents (a chat without the CEO is possible); a person sees only the chats they belong to,
// from the time they joined unless the chat shares its whole history (`history: 'full'`). Data
// physically stays on the owner's PC (local-first); the owner's views do not show chats the owner
// is not in, but the owner's PC holds them.
// Perspective: in a person's session the ids are projected so the shared UI works unchanged –
// 'human' means "you" (the caller) and the CEO appears as OWNER_ALIAS (runtime/people/perspective.ts).
// Owns: the shapes shared by runtime and UI, the people.* methods and person.* events (augmenting
// Methods / EventMap / SessionInfo – methods.ts is at its size limit) and the id helpers.
// Never: carries tokens, tickets or invite codes beyond the one invite answer shown to the owner.

import type { AccessTicket, AccessWait } from '../api/methods.ts';
import type { Avatar } from './org.ts';

/** invited: no device yet · active: at least one device joined · revoked: access ended (devices cut, chats left). */
export type PersonStatus = 'invited' | 'active' | 'revoked';

/** What a person may do besides reading and writing in their own chats and finishing their own to-dos. */
export interface PersonScopes {
  /** Spaces whose agents the person may add to chats and give tasks to ('all' = every space, chosen by the owner). */
  spaces: 'all' | string[];
  /** May start chats and groups (with people and with agents of those spaces). */
  startChats: boolean;
  /** May give tasks to agents (people can always be given tasks in a shared chat). */
  assignAgents: boolean;
}

/** A new person works with no space's agents until the owner picks spaces (never the private space by default). */
export const DEFAULT_PERSON_SCOPES: PersonScopes = { spaces: [], startChats: true, assignAgents: true };

/** A phone or browser of a person (the owner's view only). */
export interface PersonDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
}

export interface Person {
  /** 'human' for the owner; 'per_…' for everyone else. */
  id: string;
  name: string;
  /** Job title / role ("Designer", "CEO"). */
  title: string;
  avatar: Avatar;
  /** Reports to: a person id ('human' = the owner) or an agent id; absent = top of the org. */
  managerId?: string;
  status: PersonStatus;
  /** The owner of this PC: the admin of the organisation. */
  owner: boolean;
  scopes: PersonScopes;
  createdAt: number;
  updatedAt: number;
  joinedAt?: number;
  revokedAt?: number;
  /** Owner's view only: the person's connected devices; an open invite's expiry. */
  devices?: PersonDevice[];
  inviteOpenUntil?: number;
}

/** Team › People › Invite: shown once to the owner (link, QR, short code). */
export interface PersonInvite {
  personId: string;
  url: string;
  qrDataUrl: string;
  /** 6 digits ("482 913") for Enter code on this PC's address; valid 10 minutes. */
  code: string;
  codeExpiresAt: number;
  /** The link: valid 72 hours, one use. */
  expiresAt: number;
  /** False when only this PC's own address exists (set up Tailscale or the network first). */
  reachable: boolean;
}

/** One audit line of a person (invited, joined, device removed, scopes changed, revoked …). */
export interface PersonAudit {
  at: number;
  /** 'human' (the owner), 'system', or the person themself. */
  actor: string;
  action: 'created' | 'updated' | 'invited' | 'invite_closed' | 'join_requested' | 'joined' | 'join_declined' | 'device_removed' | 'revoked' | 'chat_added' | 'chat_removed'
    | 'owner_joined_chat';
  details: Record<string, unknown>;
}

/** Team › People › a person › Chats: what the owner as admin may see of a person's chats – no messages. */
export interface PersonChat {
  id: string;
  title: string;
  /** Member display names (people and agents). */
  members: string[];
  /** The owner is a member (the owner's own chat list shows it). */
  withOwner: boolean;
  /** The person is no longer a member (a people's chat they left or lost with their access; the owner may take it over by joining). */
  left?: boolean;
}

/** In a person's session the CEO's member id (`human` there means the caller). */
export const OWNER_ALIAS = 'owner';
const PERSON_ID = /^per_[0-9a-z]{10,40}$/;

/** A person other than the owner ('per_…'). */
export function isPersonId(value: unknown): boolean {
  return typeof value === 'string' && PERSON_ID.test(value);
}

/** The owner or another person – a human actor (for attribution, never for consent). */
export function isHumanActor(value: unknown): boolean {
  return value === 'human' || isPersonId(value);
}

declare module './chat.ts' {
  interface ConversationSettings {
    /** What people who join later see: from their join on ('join', default) or the whole chat ('full'). */
    history?: 'join' | 'full';
    /**
     * Runtime only (clients never set it): a chat of people without the owner – set when it is created
     * or left so, cleared only by the owner's visible join. It keeps the chat out of the owner's views
     * also after its last person left or lost access (runtime/people/access.ts hiddenFromOwner).
     */
    peopleChat?: boolean;
  }
}

declare module './tasks.ts' {
  interface TaskFilter {
    /** Runtime only (never an RPC param): narrows the query in SQL to tasks this person may read (runtime/people/access.ts). */
    readableByPerson?: string;
  }
}

declare module '../api/methods.ts' {
  interface SessionInfo {
    /** A person's session (kind 'person'): who it is and what they may do. */
    person?: { id: string; name: string; title: string; scopes: PersonScopes };
  }
  interface Methods {
    /** Owner: every person (the owner first) with devices; a person: the directory (names, titles, managers). */
    'people.list': { params: void; result: Person[] };
    /** Owner: a new person (status invited) or changes to one (name, title, avatar, manager, scopes). */
    'people.save': { params: { id?: string; name?: string; title?: string; avatar?: Avatar; managerId?: string | null; scopes?: PersonScopes }; result: Person };
    /** Owner: a new invite for a person (replaces an open one): link + QR (72 h, one use) and a 6-digit code (10 min). */
    'people.invite': { params: { id: string }; result: PersonInvite };
    /** Owner: ends a person's open invite. */
    'people.closeInvite': { params: { id: string }; result: { ok: true } };
    /** Owner: ends a person's access at once – devices cut, chats left, their open work back to the team. */
    'people.revoke': { params: { id: string }; result: Person };
    /** Owner: removes one device of a person (its token stops working at once). */
    'people.removeDevice': { params: { id: string; deviceId: string }; result: Person };
    /** Owner: a person's audit lines, newest first. */
    'people.audit': { params: { id: string; limit?: number }; result: PersonAudit[] };
    /** Owner (admin): a person's chats as metadata – titles and members, never messages. */
    'people.chats': { params: { id: string }; result: PersonChat[] };
    /** Owner or a person: the 1:1 chat with that person (created on first use). */
    'people.directChat': { params: { id: string }; result: { conversationId: string } };
    /** Tokenless: a person's browser asks to join with the invite's ticket (link / QR) or code. */
    'people.join': { params: { ticket?: string; code?: string; name?: string }; result: AccessTicket };
    /** Tokenless long request (≤ 55 s): the owner's decision on the join request. */
    'people.awaitJoin': { params: { ticket: string }; result: AccessWait };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** A person was added, changed, joined or revoked (topic: org; people see the directory projection). */
    'person.upserted': Person;
  }
}
