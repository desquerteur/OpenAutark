// The chat list's sections and the archive confirmation (C2, ui/chat/archive.ts): archived chats of
// either section go under "Archived", system chats into no section; the confirmation counts the
// open tasks whose work goes on.
// Owns: these assertions only. Never: the DOM or the runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, Member } from '../../../src/shared/model/chat.ts';
import { archiveNote, listSection } from '../../../src/ui/chat/archive.ts';

const member = (memberId: string, kind: Member['kind'], leftAt?: number): Member => ({ conversationId: 'ch_1', memberId, kind, role: 'member', readSeq: 0, joinedAt: 0, ...(leftAt ? { leftAt } : {}) });
const chat = (members: Member[], settings: ConversationSummary['settings'] = {}, archivedAt?: number) => ({ members, settings, ...(archivedAt ? { archivedAt } : {}) });

test('listSection: main and team as before, archived chats of either under Archived, system chats nowhere', () => {
  const human = member('human', 'human');
  const ava = member('ag_ava', 'agent');
  assert.equal(listSection(chat([human, ava])), 'main');
  assert.equal(listSection(chat([ava])), 'team');
  assert.equal(listSection(chat([human, ava], {}, 5)), 'archived');
  assert.equal(listSection(chat([ava], { hiddenFromList: true }, 5)), 'archived');
  assert.equal(listSection(chat([human], { hiddenFromList: true, system: 'todo' })), undefined);
  assert.equal(listSection(chat([human], { system: 'customize' }, 5)), undefined, 'an archived system chat is in no list either');
});

test('archiveNote counts the open tasks whose work goes on', () => {
  assert.equal(archiveNote(0), 'It leaves your chat list. Its agents keep working there, and it comes back when something needs you.');
  assert.equal(archiveNote(1), 'It leaves your chat list. Work on its open task goes on, and it comes back when something needs you.');
  assert.match(archiveNote(3), /Work on its 3 open tasks goes on/);
});
