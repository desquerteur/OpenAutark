// Tasks for people (F-52), shared by TaskService (create, assign) so every path – the owner's window,
// a person's device, an agent's task tool – follows one rule: a task goes to a person only while
// the person is in the organisation and a member of the task's chat (the task lives in its chat;
// a person never receives work from a chat they cannot read – the owner and people use the 1:1
// chat with that person, people.directChat). A person's own to-dos are tasks with assigneeKind
// 'human' and assigneeId = their id; the owner's keep no assignee id.
// Owns: that check. Never: assigns, notifies or adds anyone to a chat.

import { WorkforceError } from '../../shared/errors.ts';
import type { Db } from '../db/database.ts';
import { membership } from './access.ts';
import { activePerson } from './repo.ts';

export function checkPersonAssignee(db: Db, personId: string, conversationId: string, name: string | undefined): void {
  if (!activePerson(db, personId)) throw new WorkforceError('not_found', 'This person is no longer in the organisation.', { details: { personId } });
  if (!membership(db, personId, conversationId)) {
    throw new WorkforceError('conflict', `${name ?? 'This person'} is not in this chat. Add them first, or give the task in a chat with them.`, { details: { personId, conversationId } });
  }
}
