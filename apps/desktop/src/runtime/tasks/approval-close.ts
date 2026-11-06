// B-078 D9 for existing data (owner 06.11.: "VPS Platte voll … was interessiert mich das"): once at start (kv
// marker), the approval-era to-dos agents left on the person's list – reason 'approval', or an old approve card that
// is not about their identity, secret or presence – are closed (cancelled, with a note in the task) and each asking
// agent gets one wake listing them with the same self-check note human.ask gives today: the decision is its own.
// The host's own access requests (bound to-dos, made by the system) stay.
// Owns: that one pass. Never: closes a to-do the person or the host made, one about identity, a secret or presence,
// or runs twice.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { isHostBoundTodo } from '../../shared/blocks/catalog.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { SELF_CHECK_NOTE } from '../tools/builtin/human.ts';
import { toTask } from './repo.ts';

type Deps = Pick<RuntimeServices, 'db' | 'tasks' | 'wakes' | 'clock' | 'log'>;

const MARKER = { ns: 'b078', key: 'approval-todos' };
/** The note in each closed to-do. */
export const CLOSED_NOTE = 'Closed at the update: this decision is the asking agent\'s own now';
/** Reasons an approve card can stand for that stay the person's (their identity, a secret, their presence). */
const THEIRS = new Set(['identity', 'credential', 'physical']);

/** Closes the agents' open approval to-dos once; returns how many. */
export function closeApprovalTodos(s: Deps): number {
  const kv = new KvRepo(s.db);
  if (kv.get(MARKER.ns, MARKER.key) !== undefined) return 0;
  const rows = s.db.all<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE assignee_kind = 'human' AND status NOT IN ('done', 'cancelled')
       AND (human_reason = 'approval' OR json_extract(widget, '$.type') = 'approve')`);
  const byAgent = new Map<string, string[]>();
  for (const task of rows.map(toTask)) {
    const maker = task.createdBy;
    if (!maker || maker === SYSTEM_ID || isHumanActor(maker) || isHostBoundTodo(task)) continue;
    if (task.humanReason !== 'approval' && THEIRS.has(String(task.humanReason))) continue;
    try {
      s.tasks.setStatus(task.id, 'cancelled', SYSTEM_ID, CLOSED_NOTE);
      byAgent.set(maker, [...(byAgent.get(maker) ?? []), excerpt(task.title, 100)]);
    } catch (error) {
      s.log.warn('an approval to-do stayed open', { taskId: task.id, error: String(error) });
    }
  }
  for (const [agentId, titles] of byAgent) {
    s.wakes.wake({
      agentId, reason: 'event', coalesceKey: `${MARKER.key}:${agentId}`,
      origin: { source: 'system', label: 'Update' },
      note: `At the update the app closed the questions I had left on the person's list for a yes: ${titles.map((title) => `"${title}"`).join(', ')}. ${SELF_CHECK_NOTE}`,
    });
  }
  const closed = [...byAgent.values()].reduce((sum, titles) => sum + titles.length, 0);
  kv.set(MARKER.ns, MARKER.key, { at: s.clock.now(), closed }, s.clock.now());
  return closed;
}
