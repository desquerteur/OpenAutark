// The next run of the schedule mode's rule, asked from the runtime (schedules.preview – its own calculation, the one the
// scheduler arms with) a short moment after the last change. A rule that repeats gets its next time or the reason it
// cannot run ("Invalid cron expression."); a one-off says its time itself and asks nothing. The composer reads the
// answer for the line in the settings block and to keep Schedule off while the runtime refuses the rule.
// Owns: that one question. Never: builds specs (schedule-form.ts) or renders.

import { useEffect, useState } from 'preact/hooks';
import type { ScheduleSpec } from '../../../shared/model/tasks.ts';
import { errorText, rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { repeats } from './schedule-rule.ts';

export interface NextRun { at?: number; error?: string }

const WAIT_MS = 250;

export function useNextRun(spec: ScheduleSpec | null): NextRun {
  const key = spec ? JSON.stringify(spec) : '';
  const asks = repeats(spec);
  const [answer, setAnswer] = useState<NextRun & { key: string }>({ key: '' });
  useEffect(() => {
    if (!spec || !asks || !can('schedules.preview')) return;
    let alive = true;
    const timer = setTimeout(() => {
      rpc.call('schedules.preview', { spec, count: 1 }).then(
        ({ times }) => { if (alive) setAnswer({ key, at: times[0], error: times.length ? undefined : 'This schedule never runs.' }); },
        (error) => { if (alive) setAnswer({ key, error: errorText(error) }); },
      );
    }, WAIT_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [key]);
  return asks && answer.key === key ? answer : {};
}
