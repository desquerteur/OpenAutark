// A person's browser (F-52) remembers that its token is a person's – and the name of the CEO, who
// invited them – so the screen of a removed person speaks to them, not to a phone owner: "Your access
// to this organisation was removed." and to ask the CEO for a new invite (its link or code), without
// the steps on the owner's PC. The owner's phones keep "This phone was removed." (AccessRequest.tsx).
// The mark ('wf.person' in localStorage) follows every session answer: a person's session writes it
// (with the CEO's name from the directory), an owner's or a phone's session removes it; joining as a
// person writes it before the page reloads (pwa/join.ts). It survives reloads like the revoked marker
// (lib/refusal.ts), so the right screen shows also when the PC refuses the token on the next start.
// Owns: the mark and the removed-person wording. Never: stores the token or anything that can stand in
// for it, or runs on the desktop.

import { effect } from '@preact/signals';
import type { SessionInfo } from '../../shared/api/methods.ts';
import { OWNER_ALIAS } from '../../shared/model/people.ts';
import type { MarkStorage } from '../lib/refusal.ts';
import { personName } from '../lib/people.ts';
import { session } from '../lib/session.ts';

export const PERSON_KEY = 'wf.person';

/** This page's token belongs to a person of an organisation; `owner`: the CEO's name when known. */
export interface PersonMark { owner?: string }

function pageStorage(): MarkStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readPersonMark(storage: MarkStorage | null = pageStorage()): PersonMark | null {
  try {
    const raw = storage?.getItem(PERSON_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { owner?: unknown } | null;
    if (!value || typeof value !== 'object') return null;
    return typeof value.owner === 'string' && value.owner.trim() ? { owner: value.owner.trim().slice(0, 80) } : {};
  } catch {
    return null;
  }
}

export function writePersonMark(mark: PersonMark | null, storage: MarkStorage | null = pageStorage()): void {
  try {
    if (!mark) storage?.removeItem(PERSON_KEY);
    else storage?.setItem(PERSON_KEY, JSON.stringify(mark.owner ? { owner: mark.owner } : {}));
  } catch { /* storage blocked: the phone wording shows */ }
}

/** One session answer: a person's writes the mark (keeping a known CEO name), any other kind removes it, none keeps it. */
export function notePersonSession(info: Pick<SessionInfo, 'kind'> | null, ownerName: string | undefined, storage: MarkStorage | null = pageStorage()): void {
  if (!info) return; // no answer (yet): the last one stands
  if (info.kind !== 'person') { if (readPersonMark(storage)) writePersonMark(null, storage); return; }
  const before = readPersonMark(storage);
  const owner = ownerName?.trim() || before?.owner;
  if (!before || before.owner !== owner) writePersonMark(owner ? { owner } : {}, storage);
}

/** The removed person's screen: what happened and what they can do (no owner-PC steps). */
export function removedPersonText(mark: PersonMark): { title: string; detail: string } {
  const who = !mark.owner ? 'the person who invited you' : mark.owner === 'CEO' ? 'the CEO' : `${mark.owner}, who invited you,`;
  return {
    title: 'Your access to this organisation was removed.',
    detail: `To work here again, ask ${who} for a new invite. Open its link, or enter its code here.`,
  };
}

/** Keeps the mark current with every session answer and the directory (called once from pwa/install.ts). */
export function watchPersonMark(): () => void {
  return effect(() => notePersonSession(session.value, session.value?.kind === 'person' ? personName(OWNER_ALIAS) : undefined));
}
