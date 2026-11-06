// The task fields My day adds (B-041, shared/model/tasks.ts – migration 068): the keys TaskService.update may
// change for them (joined into tasks/service.ts PATCHABLE) and the copy of them from a CreateTaskInput (for
// tasks/create.ts). They are written through day.* and todos.prepare (the RPC tasks.update keeps its own keys).
// Owns: this key list and that copy. Never: checks of the values (the day service and the tools validate them).

import type { CreateTaskInput, Task } from '../../shared/model/tasks.ts';

export const DAY_PATCH_FIELDS = ['estimateMin', 'estimateSource', 'spentMs', 'timerStartedAt', 'window', 'prep', 'private'] as const satisfies ReadonlyArray<keyof Task>;
export type DayPatchField = (typeof DAY_PATCH_FIELDS)[number];

/** The My-day fields set on `input` (none when it sets none). */
export function dayFieldsOf(input: Pick<CreateTaskInput, DayPatchField>): Partial<Pick<Task, DayPatchField>> {
  const out: Partial<Record<DayPatchField, unknown>> = {};
  for (const key of DAY_PATCH_FIELDS) if (input[key] !== undefined) out[key] = input[key];
  if (out.private === false) delete out.private; // false is the default (no key on compact rows)
  return out as Partial<Pick<Task, DayPatchField>>;
}
