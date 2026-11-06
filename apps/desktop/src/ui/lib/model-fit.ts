// Which models the UI offers for chat work, mirroring runtime routing/score.ts: specialists (a media
// function, or a chat prior at or below NEVER) are never offered as chat models.
// Owns: this pure check. Never: calls the runtime or decides a route.

import type { ModelInfo } from '../../shared/model/providers.ts';

/** Strength at or below this means "never" for a category (runtime routing/score.ts NEVER). */
export const NEVER = -0.95;

/** A general model for conversation: no media function, not a specialist that is never used for chat. */
export function isChatModel(model: ModelInfo): boolean {
  return !model.functions?.length && (model.strengths?.chat ?? 0) > NEVER;
}
