// B-078 D7 for existing data (live analysis 06.11.: 5 agents added into 3 of the owner's 1:1s, e.g. Konrad in Mara's):
// once at start (kv marker), every marked default 1:1 with its pair (settings.directPair) loses the agents outside
// the pair. An open task such an agent owns in that chat moves first into its own 1:1 with the one who gave it
// (assigned by, else created by; the system or the agent itself: the pair's owner side) – the same room
// tasks/owners.ts routeOwner picks today – so no work loses its room. The chat keeps the "Removed …" line
// setMembers writes and, when work moved, one quiet line saying where it went on.
// Owns: that one pass. Never: removes a member of the pair, a person or a bridged contact ('ext:…'), runs twice, or
// touches a group chat.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { moveTaskChat } from '../tasks/owners.ts';
import { findOrCreateDirect } from './direct.ts';

type Deps = Pick<RuntimeServices, 'db' | 'chats' | 'tasks' | 'bus' | 'clock' | 'log'> & Partial<Pick<RuntimeServices, 'org' | 'people' | 'settings'>>;

const MARKER = { ns: 'b078', key: 'direct-two' };

/** Removes the extra agents of the owner's and everyone's marked 1:1s once; returns how many left. */
export function repairDirectChats(s: Deps): number {
  const kv = new KvRepo(s.db);
  if (kv.get(MARKER.ns, MARKER.key) !== undefined) return 0;
  const rows = s.db.all<{ id: string; pair: string }>(
    `SELECT c.id AS id, json_extract(c.settings, '$.directPair') AS pair FROM conversations c
      WHERE json_extract(c.settings, '$.direct') = 1 AND json_array_length(json_extract(c.settings, '$.directPair')) = 2`);
  let removed = 0;
  for (const row of rows) {
    let pair: string[];
    try { pair = JSON.parse(row.pair) as string[]; } catch { continue; }
    const extra = s.chats.members(row.id).filter((member) => member.leftAt === undefined && member.kind === 'agent' && !pair.includes(member.memberId));
    for (const member of extra) {
      try {
        const moved = moveWork(s, row.id, member.memberId, pair);
        s.chats.setMembers(row.id, { remove: [member.memberId] }, SYSTEM_ID);
        removed++;
        if (moved) {
          const name = s.org?.get(member.memberId)?.name ?? 'This colleague';
          s.chats.status(row.id, { type: 'note', text: `${name} continues ${moved === 1 ? 'one task' : `${moved} tasks`} from here in a 1:1 of its own` });
        }
      } catch (error) {
        s.log.warn('a third member of a 1:1 stayed', { conversationId: row.id, memberId: member.memberId, error: String(error) });
      }
    }
  }
  kv.set(MARKER.ns, MARKER.key, { at: s.clock.now(), removed }, s.clock.now());
  return removed;
}

/** Moves `agentId`'s open tasks of `chatId` into its 1:1 with their giver; returns how many moved. */
function moveWork(s: Deps, chatId: string, agentId: string, pair: readonly string[]): number {
  const tasks = s.db.all<{ id: string; assigned_by: string | null; created_by: string }>(
    `SELECT id, assigned_by, created_by FROM tasks WHERE conversation_id = ? AND assignee_kind = 'agent' AND assignee_id = ?
       AND parent_id IS NULL AND status NOT IN ('done', 'cancelled')`, [chatId, agentId]);
  const fallback = pair.includes(HUMAN_ID) ? HUMAN_ID : pair.find((id) => isPersonId(id)) ?? pair[0];
  for (const task of tasks) {
    const given = task.assigned_by ?? task.created_by;
    const giver = !given || given === SYSTEM_ID || given === agentId ? fallback : given;
    const room = findOrCreateDirect(s, giver, agentId, { createdBy: giver });
    if (room === chatId) continue;
    moveTaskChat(s, task.id, room);
    const view = s.tasks.get(task.id);
    if (view) s.bus.emit('task.upserted', view);
  }
  return tasks.length;
}
