// Volatile deltas (B-049 F6). The volatile context (<workforce-context>: now, permissions, environment, this chat,
// tasks …) went in full in front of every turn of a resumed native session, and every earlier copy stays in that
// session's history, so it piled up. A resumed session now gets only the sections that changed since the last turn it
// finished (each section keeps its own "## " header), plus one line naming the sections that still hold unchanged and
// one naming those no longer current. A new, renewed or rebuilt session – and a stateless engine – gets every section.
// State: kv 'volatile-sent', key `<agentId>|<conversationId or ''>|<engine>`, value { ref, sections: { name: { hash,
// title } } } – what session `ref` held after its last finished ('done') turn; another ref counts as nothing sent.
// Forgotten (forgetSent) when the session's history stops holding it: a rebuild (a Codex revert keeps the ref but cuts
// the turns that carried it) or a compaction inside the engine (EngineTurnResult.compacted).
// Owns: the delta, its two summary lines and that state. Never: leaves out a changed section, or records a turn that
// did not finish (its sections count as unsent, so the next turn sends them again – more, never less).

import { createHash } from 'node:crypto';
import type { Db } from '../db/database.ts';
import type { EngineId } from '../../shared/model/providers.ts';
import { KvRepo } from '../store/kv.ts';
import type { VolatileSection } from '../context/prompt-volatile.ts';

export type { VolatileSection };
export const VOLATILE_SENT_NS = 'volatile-sent';

export interface SentSection { hash: string; title: string }
export type SentSections = Record<string, SentSection>;
export interface SentKey { agentId: string; conversationId: string; engine: EngineId }

interface Stored { ref: string; sections: SentSections }

const keyOf = (key: SentKey) => `${key.agentId}|${key.conversationId}|${key.engine}`;
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);

/** "## Pinned memory (notes that …)" → "Pinned memory"; the section name when it has no header. */
export function sectionTitle(section: VolatileSection): string {
  const first = section.text.split('\n', 1)[0] ?? '';
  return first.replace(/^#+\s*/, '').replace(/\s*\(.*$/, '').trim().slice(0, 60) || section.name;
}

/** What session `ref` held after its last finished turn; undefined for another ref, nothing recorded or an unreadable row. */
export function sentTo(db: Db, key: SentKey, ref: string): SentSections | undefined {
  try {
    const stored = new KvRepo(db).get<Stored>(VOLATILE_SENT_NS, keyOf(key));
    return stored && stored.ref === ref && stored.sections && typeof stored.sections === 'object' ? stored.sections : undefined;
  } catch { return undefined; }
}

/** After a finished turn of session `ref`: the sections it holds now. Never throws (without it the next turn sends all). */
export function recordSent(db: Db, key: SentKey, ref: string, sections: SentSections, at: number): void {
  try { new KvRepo(db).set(VOLATILE_SENT_NS, keyOf(key), { ref, sections }, at); } catch { /* bookkeeping only */ }
}

/**
 * Forgets what the session of `key` was sent: its history no longer holds it all – rebuilt (a Codex revert keeps the
 * ref but cuts turns) or compacted by the engine itself. The next turn on it sends every section. Never throws.
 */
export function forgetSent(db: Db, key: SentKey): void {
  try { new KvRepo(db).delete(VOLATILE_SENT_NS, keyOf(key)); } catch { /* bookkeeping only */ }
}

/**
 * The volatile text for this turn and what the session holds once it finishes. `sent` undefined (new, renewed or
 * rebuilt session, another ref, a stateless engine): every section. Else the changed sections in order,
 * then "Unchanged since my last turn: …" and "No longer current: …".
 */
export function volatileDelta(all: readonly VolatileSection[], sent: SentSections | undefined): { text: string; sections: SentSections } {
  const held: SentSections = {};
  // A section whose builder threw this turn keeps what the session last got of it – never "no longer current".
  for (const section of all) {
    const last = section.failed ? sent?.[section.name] : undefined;
    if (last) held[section.name] = last;
  }
  const sections = all.filter((section) => !section.failed);
  for (const section of sections) held[section.name] = { hash: hashOf(section.text), title: sectionTitle(section) };
  if (!sent) return { text: sections.map((section) => section.text).join('\n\n'), sections: held };
  const changed = sections.filter((section) => sent[section.name]?.hash !== held[section.name]?.hash);
  const unchanged = sections.filter((section) => sent[section.name]?.hash === held[section.name]?.hash).map(sectionTitle);
  const gone = Object.entries(sent).filter(([name]) => !Object.hasOwn(held, name)).map(([, entry]) => entry.title);
  const lines = [
    unchanged.length ? `Unchanged since my last turn: ${unchanged.join(', ')}.` : '',
    gone.length ? `No longer current: ${gone.join(', ')}.` : '',
  ].filter(Boolean).join('\n');
  return { text: [...changed.map((section) => section.text), lines].filter(Boolean).join('\n\n'), sections: held };
}
