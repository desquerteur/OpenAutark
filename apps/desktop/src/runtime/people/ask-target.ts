// Who an agent's ask goes to in a chat with people (F-52): an ask block (choice, form, record …) or
// a mini-app to-do of an agent's message lands on the For you of the human who wrote last before
// it – a person of the organisation who is still a member, or the owner. Asks only the owner can
// answer – approvals, credentials (a form with a password or key) and identity – always go to the
// owner: a colleague never approves, hands over secrets or proves identity for the organisation.
// In chats without people nothing changes (the owner). The task stays in its chat; agents never
// pick the person themselves.
// Owns: that choice (SQL reads only). Never: creates or assigns tasks.

import type { Db } from '../db/database.ts';
import type { HumanReason } from '../../shared/model/tasks.ts';
import { isPersonId } from '../../shared/model/people.ts';

/** Reasons only the owner of the organisation answers (never a person of it). */
export const OWNER_REASONS: ReadonlySet<HumanReason> = new Set(['approval', 'credential', 'identity']);

/** The person an agent's ask at `seq` goes to, or undefined for the owner. */
export function askTarget(db: Db, conversationId: string, seq: number, reason?: HumanReason): string | undefined {
  if (reason && OWNER_REASONS.has(reason)) return undefined;
  try {
    const row = db.get<{ author_id: string }>(
      `SELECT author_id FROM messages WHERE conversation_id = ? AND seq < ? AND author_kind = 'human' AND kind IN ('text', 'task', 'answer') ORDER BY seq DESC LIMIT 1`,
      [conversationId, seq],
    );
    const active = db.all<{ member_id: string; left_at: number | null }>(
      `SELECT member_id, left_at FROM members WHERE conversation_id = ? AND left_at IS NULL ORDER BY joined_at, member_id`, [conversationId],
    ).map((member) => ({ memberId: String(member.member_id), leftAt: undefined }));
    if (row && isPersonId(row.author_id) && active.some((member) => member.memberId === row.author_id)) return row.author_id;
    return undefined; // the owner reads every chat and answers there
  } catch {
    return undefined;
  }
}
