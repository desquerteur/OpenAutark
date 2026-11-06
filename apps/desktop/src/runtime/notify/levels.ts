// Per-chat notification levels (C3, Chat details › Notifications): which notification kinds a
// chat's level lets through, when "All messages" pushes past the global pushFor list, and whether
// the in-window toast shows. Approvals reach the person as human to-dos (kind 'todo').
//  * 'off'      – only what blocks work: human to-dos and approvals.
//  * 'mentions' – "Mentions and tasks": also important messages and @mentions of the person
//                 (delivery sends both as 'important') and blocked tasks.
//  * 'all'      – everything; replies and results push although the global pushFor leaves them out.
//  * 'default' / unset – everything, the global settings decide.
// Owns: these pure rules. Never: reads settings, looks up chats or pushes (notify/service.ts does).

import type { NotificationLevel } from '../../shared/model/chat.ts';
import type { NotificationInput } from '../contracts.ts';

type Kind = NotificationInput['kind'];

const OFF: ReadonlySet<Kind> = new Set<Kind>(['todo']);
const MENTIONS: ReadonlySet<Kind> = new Set<Kind>(['todo', 'blocker', 'important']);

/** May a notification of `kind` reach the person at all (push or toast) in a chat with `level`? */
export function levelAllows(level: NotificationLevel | undefined, kind: Kind): boolean {
  if (level === 'off') return OFF.has(kind);
  if (level === 'mentions') return MENTIONS.has(kind);
  return true;
}

/** "All messages": this chat's replies and results push even when the global pushFor leaves them out. */
export function levelForcesPush(level: NotificationLevel | undefined, kind: Kind): boolean {
  return level === 'all' && (kind === 'reply' || kind === 'done');
}

/**
 * The in-window toast: never for 'info'; replies only in "All messages" chats (otherwise the chat
 * list's unread count is enough); everything else when the level allows it.
 */
export function toastFor(level: NotificationLevel | undefined, kind: Kind): boolean {
  if (kind === 'info' || !levelAllows(level, kind)) return false;
  return kind !== 'reply' || level === 'all';
}
