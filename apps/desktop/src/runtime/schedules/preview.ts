// Next-run preview for the schedule dialog (schedules.preview, T11) and the agents' schedule tools
// (B-044: each result echoes the next runs): the next few fire times of a spec as the scheduler
// would take them – a past one-off `at` still fires once, late (like Scheduler.firstFire); `until`,
// excluded dates, weekdays (`days`), clock `times` and the daily window apply through nextFire,
// exactly as the scheduler arms them; `maxRuns` counts the runs a schedule already made (editing).
// Owns: that read-only calculation. Never: stores, arms or fires anything.

import { WorkforceError } from '../../shared/errors.ts';
import type { ScheduleSpec } from '../../shared/model/tasks.ts';
import { isOneOff, nextFire, validateSpec } from './spec.ts';

export const PREVIEW_COUNT = 3;
export const PREVIEW_MAX = 10;

export function previewTimes(spec: ScheduleSpec, now: number, options: { count?: number; runs?: number } = {}): number[] {
  const error = validateSpec(spec);
  if (error) throw new WorkforceError('bad_request', error, { details: { param: 'spec' } });
  let count = Math.min(Math.max(1, Math.floor(options.count ?? PREVIEW_COUNT)), PREVIEW_MAX);
  if (spec.maxRuns !== undefined) count = Math.min(count, Math.max(0, spec.maxRuns - (options.runs ?? 0)));
  if (count === 0) return [];
  if (isOneOff(spec) && spec.at! <= now) {
    return spec.until !== undefined && spec.at! > spec.until ? [] : [spec.at!];
  }
  const times: number[] = [];
  let cursor = now;
  while (times.length < count) {
    const next = nextFire(spec, cursor);
    if (next === undefined) break;
    times.push(next);
    cursor = next;
  }
  return times;
}
