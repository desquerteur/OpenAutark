// The one-time passes that bring data from before B-078 to its rules, run at start after the seed and the owner's
// 1:1s (runtime/main.ts). Each pass keeps its own kv marker and runs once; one that fails is logged and tried again
// at the next start. Order: the people from before count as welcomed first, then 1:1s go back to two, then the
// approval-era to-dos close, then the personal manager gets its one look at the team.
// Owns: calling them in that order. Never: does the work itself (chat/direct-repair.ts, tasks/approval-close.ts,
// org/member-welcome.ts, org/org-review.ts).

import type { RuntimeServices } from '../contracts.ts';
import { repairDirectChats } from '../chat/direct-repair.ts';
import { closeApprovalTodos } from '../tasks/approval-close.ts';
import { markExistingMembers } from '../org/member-welcome.ts';
import { wakeOrgReview } from '../org/org-review.ts';

export function runB078Repairs(s: RuntimeServices): void {
  const passes: Array<[string, () => unknown]> = [
    ['members welcomed', () => markExistingMembers(s)],
    ['1:1s back to two', () => repairDirectChats(s)],
    ['approval to-dos closed', () => closeApprovalTodos(s)],
    ['org review', () => wakeOrgReview(s)],
  ];
  for (const [name, pass] of passes) {
    try {
      const result = pass();
      if (result) s.log.info('B-078 repair', { pass: name, result: typeof result === 'number' ? result : true });
    } catch (error) {
      s.log.warn('B-078 repair failed', { pass: name, error: String((error as Error)?.message ?? error) });
    }
  }
}
