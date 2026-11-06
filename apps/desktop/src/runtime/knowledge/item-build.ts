// A new knowledge item from what a caller gives: texts redacted, scope and kind checked, the reserved tags kept honest.
// Owns: that check and the item's defaults. Never: stores anything.

import { WorkforceError } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import type { KnowledgeItem } from '../../shared/model/knowledge.ts';
import { normalizeReservedTags } from './reserved.ts';
import { normalScopeId, scopeIdHint } from './scope-id.ts';

const SCOPES: ReadonlySet<string> = new Set(['global', 'space', 'agent', 'conversation', 'website', 'app', 'mode', 'reference']);
export const KINDS: ReadonlySet<string> = new Set(['fact', 'preference', 'experience', 'procedure', 'plan', 'observation', 'note', 'reference']);

export type SaveInput = Partial<KnowledgeItem> & { title: string; body: string; scope: KnowledgeItem['scope']; createdBy: string };

export function buildItem(input: SaveInput, env: { now: number; redact: (text: string) => string }): KnowledgeItem {
  const title = env.redact(input.title.trim());
  const body = env.redact(input.body.trim());
  if (!title || !body) throw new WorkforceError('bad_request', 'Knowledge needs a title and a body.');
  if (!SCOPES.has(input.scope)) throw new WorkforceError('bad_request', `Unknown knowledge scope: ${input.scope}.`);
  const kind = input.kind ?? 'note';
  if (!KINDS.has(kind)) throw new WorkforceError('bad_request', `Unknown knowledge kind: ${kind}.`);
  const scopeId = input.scope === 'global' ? undefined : normalScopeId(input.scope, input.scopeId) ?? (input.supersedes ? input.scopeId : undefined); // a correction keeps an older id
  if (input.scope !== 'global' && !scopeId) throw new WorkforceError('bad_request', `Scope '${input.scope}' needs a scopeId${input.scope === 'website' || input.scope === 'app' ? `: ${scopeIdHint(input.scope)}` : ''}.`);
  const human = input.createdBy === 'human';
  const source = input.source ?? { kind: human ? 'user' : 'agent', trusted: true };
  return {
    id: input.id ?? newId('kn', env.now),
    scope: input.scope,
    scopeId,
    kind,
    title,
    body,
    // Only a real runtime summary keeps the reserved compaction tag (reserved.ts).
    tags: normalizeReservedTags({ kind, scope: input.scope, scopeId, source, tags: [...new Set(input.tags ?? [])] }),
    source: source.ref ? { ...source, ref: env.redact(source.ref) } : source,
    confidence: Math.max(0, Math.min(1, input.confidence ?? 0.7)),
    pinned: input.pinned ?? false,
    validFrom: input.validFrom,
    validTo: input.validTo,
    recordedAt: env.now,
    supersedes: input.supersedes,
    createdBy: input.createdBy,
    uses: input.uses ?? 0,
    lastUsedAt: input.lastUsedAt,
  };
}
