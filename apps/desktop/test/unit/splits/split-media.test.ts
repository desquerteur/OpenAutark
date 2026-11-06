// B-057 S15 × F-52 – media of a split: a split has no chat of its own, so the media it generates belong to the chat it was
// split in (tools/builtin/media-generate-flow.ts readChat) – linked and described there, so the owner's library leaves
// out what a split of a people's own chat made, as it does for that chat's own turns – and media it reads by id are judged
// by its parent chat's reach (media-common.ts mayRead), never by the owner's eyes of a turn without a chat.
// Owns: these checks. Never: a real provider or the network beyond 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaLibrary } from '../../../src/runtime/media/library.ts';
import { MediaRepo } from '../../../src/runtime/media/repo.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';
import { png } from '../media/fixtures.ts';
import { account, call, listen, textOf, tool, toolSetup } from '../media/generate-fixture.ts';

const ANNA = 'per_anna000000';
const BEN = 'per_benn000000';

/** The media harness plus Anna's own chat, Anna and Ben's own chat and the owner's chat with Anna – Ada is in all three. */
function scene(base: string) {
  const t = toolSetup([account('acc_local', 'local', base)]);
  for (const [id, name] of [[ANNA, 'Anna Berg'], [BEN, 'Ben Kurz']]) {
    t.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', 0, 0)`, [id, name]);
  }
  const chats = {
    anna: t.h.chats.create({ title: 'Salary', agentIds: ['ag_ada'], people: [ANNA], humans: false, createdBy: ANNA }).id,
    ab: t.h.chats.create({ title: 'Offsite', agentIds: ['ag_ada'], people: [ANNA, BEN], humans: false, createdBy: ANNA }).id,
    mixed: t.h.chats.create({ title: 'Budget', agentIds: ['ag_ada'], people: [ANNA], createdBy: 'human' }).id,
  };
  /** A split of a turn in `chat` (no chat of its own), or – `asSplit` false – that turn itself. */
  const ctx = (chat: string, asSplit = true): ToolContext => {
    const rest: ToolContext = { ...t.ctx('ag_ada') };
    delete rest.conversationId;
    const split: SplitTurn = {
      splitId: 'spl_media', groupId: 'sgr_media', idx: 1, of: 2, title: 'Make the picture', parentRunId: 'run_parent',
      parentThread: chat, parentConversationId: chat, context: 'fork', firstTurn: true,
    };
    return asSplit ? { ...rest, runId: 'run_split', split } : { ...rest, conversationId: chat };
  };
  return { ...t, chats, ctx };
}

let made = 0;
/** A new picture per call (identical bytes would be one stored file). */
const answer = () => ({ type: 'application/json', body: JSON.stringify({ data: [{ b64_json: Buffer.from(png(48 + made++, 24)).toString('base64') }] }) });

