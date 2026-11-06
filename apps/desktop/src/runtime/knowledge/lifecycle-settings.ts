// Validation of Settings › lifecycle: the retention of derived data (tool traces of finished runs,
// corrected knowledge versions), in whole days. B-044: the review rules (`lifecycle.reviews`) were
// removed – a stored list is no longer a known key (migration 069 strips it).
// Owns: that validation. Never: applies retention (privacy/retention.ts) or stores settings.

import { WorkforceError } from '../../shared/errors.ts';
import { MAX_RETENTION_DAYS } from '../../shared/model/lifecycle.ts';

function bad(path: string, expected: string): never {
  throw new WorkforceError('bad_request', `Invalid setting ${path}: expected ${expected}.`, { details: { path } });
}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates Settings › lifecycle (settings/validate.ts calls it for a stored or patched section). */
export function validateLifecycle(value: unknown): void {
  if (!plain(value)) bad('lifecycle', 'an object');
  for (const key of Object.keys(value)) if (key !== 'retention') bad(`lifecycle.${key}`, 'a known key');
  if (value.retention === undefined) return;
  if (!plain(value.retention)) bad('lifecycle.retention', 'an object');
  for (const [key, entry] of Object.entries(value.retention)) {
    if (key !== 'traceDays' && key !== 'historyDays') bad(`lifecycle.retention.${key}`, 'traceDays or historyDays');
    if (!Number.isInteger(entry) || (entry as number) < 0 || (entry as number) > MAX_RETENTION_DAYS) bad(`lifecycle.retention.${key}`, `whole days 0..${MAX_RETENTION_DAYS}`);
  }
}
