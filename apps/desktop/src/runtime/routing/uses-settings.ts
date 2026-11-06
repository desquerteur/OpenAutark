// settings.json's Models section (key "routing"): the check of its values after a merge (runtime/settings/validate.ts)
// and the one-time move of the older keys into the uses when the file is read (runtime/settings/read.ts –
// shared/model/models-uses.ts migrateRouting; voice.realtimeModel becomes the Voice use). A use is "auto", a model
// id "<connection or provider>:<model>" (a bare model name from an older client is accepted too), for Work also a plan's provider
// id, for the media uses and embeddings also "off", for tts and embeddings also "local", for images also "codex".
// Owns: these two rules. Never: checks that a chosen model is connected (an unavailable choice falls back at routing
// time, models/functions.ts and routing/router.ts) or writes settings.

import type { RoutingSettings } from '../../shared/model/system.ts';
import { MODEL_USES, OFFABLE_USES, USE_AUTO, USE_OFF, migrateRouting } from '../../shared/model/models-uses.ts';

type Bad = (path: string, expected: string) => never;
type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);

const COST_MODES: readonly string[] = ['economy', 'balanced', 'best'];
/** A model id, a plan's provider id or "auto"/"off": no white space or control characters. */
const VALUE = /^[^\s\u0000-\u001f]{1,200}$/;

/** Checks the Models section of a complete Settings object. */
export function validateRouting(routing: RoutingSettings, bad: Bad): void {
  if (!COST_MODES.includes(routing.costMode)) bad('routing.costMode', COST_MODES.join(' | '));
  if (typeof routing.allowPaidFallback !== 'boolean') bad('routing.allowPaidFallback', 'true or false');
  for (const use of MODEL_USES) {
    const value: unknown = routing[use];
    const expected = `"${USE_AUTO}"${OFFABLE_USES.has(use) ? `, "${USE_OFF}"` : ''} or a model "<connection>:<model>"`;
    if (typeof value !== 'string' || !VALUE.test(value)) bad(`routing.${use}`, expected);
    if (value === USE_OFF && !OFFABLE_USES.has(use)) bad(`routing.${use}`, expected);
  }
}

/**
 * The file's sections with the Models section's older keys moved into the uses (voice.realtimeModel included); the
 * same object when there was nothing to move. Read once per file read – the next write holds only the uses.
 */
export function migrateModelSettings(data: Plain): Plain {
  const voice = isPlain(data.voice) ? data.voice : undefined;
  const realtime = voice?.realtimeModel;
  if (realtime === undefined && !isPlain(data.routing)) return data;
  const routing = migrateRouting(data.routing, realtime);
  if (routing === data.routing && realtime === undefined) return data;
  const out: Plain = { ...data, routing };
  if (voice && 'realtimeModel' in voice) {
    const rest = { ...voice };
    delete rest.realtimeModel;
    out.voice = rest;
  }
  return out;
}
