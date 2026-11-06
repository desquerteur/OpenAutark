// My day › "Chats that matter" names who works in a chat as the chat header's live line does (ui/day/DayOverview.tsx
// workingOf, ui/chat/ChatHeader.tsx): the chat's live rows (liveRuns) and its running split groups (liveGroupsOf) – a
// split run has no live row, so an agent whose work runs only as a split group is named through its group. The
// component's wiring is checked in its source (a .tsx file does not load here); the group's part runs on the real store.
// Owns: these assertions only. Never: the DOM or rpc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SplitGroupView } from '../../../src/shared/model/splits.ts';
import { liveRuns, workingIds } from '../../../src/ui/chat/live-text.ts';
import { applyGroups, liveGroupsOf } from '../../../src/ui/splits/split-model.ts';

const source = (file: string) => readFileSync(new URL(`../../../src/ui/${file}`, import.meta.url), 'utf8');

test('Home builds its working entries from the chat header\'s two sources', () => {
  const home = source('day/DayOverview.tsx');
  assert.match(home, /\.\.\.liveRuns\(chat\), \.\.\.liveGroupsOf\(chat\.id\)\.map\(/, 'live rows, then running split groups');
  assert.match(home, /workingOf,\n/, 'importantChats gets that helper');
});

test('an agent working only in a split group is named through its group', () => {
  const group: SplitGroupView = {
    id: 'sg_home', agentId: 'ag_mira', parentRunId: 'run_p', conversationId: 'c_home', thread: 'c_home', goal: 'Review', ultra: false,
    status: 'running', parts: 2, createdAt: 1,
    splits: [{ id: 'sp_1', groupId: 'sg_home', agentId: 'ag_mira', idx: 1, of: 2, title: 'Part 1', brief: 'Do it', context: 'fork', after: [], worktree: false, status: 'running', attempts: 0, createdAt: 1, runs: 1 }],
  };
  applyGroups([group]);
  const chat = { id: 'c_home', working: [] as string[] };
  assert.deepEqual(workingIds(chat, liveRuns(chat)), [], 'its rows name nobody');
  const entries = [...liveRuns(chat), ...liveGroupsOf(chat.id).map((live) => ({ agentId: live.agentId, conversationId: chat.id, note: '' }))];
  assert.deepEqual(workingIds(chat, entries), ['ag_mira']);
});
