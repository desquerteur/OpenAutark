// References: the person's own words, reasons and corrections that agents use to write and decide the
// way the person (the CEO) would. Each one is a memory file in references/<whose>/ ('human' or a person per_…; knowledge
// scope 'reference', kind 'reference'), titled by what it is ("Example: …", "Reason: …"). Every agent of
// the team reads them (knowledge.recall, references.find). "Remember why…" turns an own message and the typed
// reason into an example and a reason; repeating it on the same message replaces the earlier pair.
// Owns: those rules. Never: rights, grants, exports or proposals – a reference is just a note everyone may use.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { KnowledgeHit, KnowledgeItem } from '../../shared/model/knowledge.ts';
import type { ChatService, KnowledgeService } from '../contracts.ts';

export const REFERENCE_KINDS = ['example', 'reason', 'goal', 'exception', 'style', 'correction'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

const TITLE: Record<ReferenceKind, string> = {
  example: 'Example', reason: 'Reason', goal: 'Goal', exception: 'Exception', style: 'Style', correction: 'Correction',
};

/** "Reason: <situation for audience>" or, without them, the first words of the text. */
export function referenceTitle(kind: ReferenceKind, text: string, situation?: string, audience?: string): string {
  const head = [situation?.trim(), audience?.trim() ? `for ${audience.trim()}` : undefined].filter(Boolean).join(' ');
  return `${TITLE[kind]}: ${head || text.replace(/\s+/g, ' ').trim().slice(0, 80)}`.slice(0, 200);
}

export interface CaptureInput {
  kind: ReferenceKind;
  text: string;
  /** Whose words: 'human' (the owner) or a person per_…. */
  subject?: string;
  situation?: string;
  audience?: string;
  /** The message it comes from. */
  messageId?: string;
  by: string;
}

/** Saves one reference (a new memory file). */
export function captureReference(knowledge: KnowledgeService, input: CaptureInput): KnowledgeItem {
  const text = input.text.trim();
  if (!text) throw new WorkforceError('bad_request', 'A reference needs text.');
  return knowledge.save({
    scope: 'reference', scopeId: input.subject ?? HUMAN_ID, kind: 'reference',
    title: referenceTitle(input.kind, text, input.situation, input.audience), body: text,
    source: { kind: input.messageId ? 'message' : input.by === HUMAN_ID ? 'user' : 'agent', ...(input.messageId ? { ref: input.messageId } : {}), trusted: true },
    createdBy: input.by,
  });
}

export interface RememberInput {
  messageId: string;
  why?: string;
  whyKind?: Exclude<ReferenceKind, 'example' | 'correction'>;
  keepExample?: boolean;
  situation?: string;
  audience?: string;
}

/**
 * "Remember why…" on the caller's own finished text message: the message as an example (unless keepExample
 * is false) and the typed reason. Earlier references of the same message and kind are replaced.
 */
export async function rememberWhy(deps: { chats: Pick<ChatService, 'message'>; knowledge: KnowledgeService }, input: RememberInput, callerId: string): Promise<KnowledgeItem[]> {
  const message = deps.chats.message(input.messageId);
  if (!message) throw new WorkforceError('not_found', 'Message not found.', { details: { messageId: input.messageId } });
  if (message.authorKind !== 'human' || message.authorId !== callerId || message.kind !== 'text' || !message.body.trim()) {
    throw new WorkforceError('bad_request', 'Only your own text messages can be remembered.');
  }
  const why = input.why?.trim();
  if (!why && input.keepExample === false) throw new WorkforceError('bad_request', 'Say why, or keep the message as an example.');
  const parts: Array<{ kind: ReferenceKind; text: string }> = [];
  if (input.keepExample !== false) parts.push({ kind: 'example', text: message.body });
  if (why) parts.push({ kind: input.whyKind ?? 'reason', text: why });
  const saved: KnowledgeItem[] = [];
  for (const part of parts) {
    const title = TITLE[part.kind];
    const earlier = (await deps.knowledge.list({ scope: 'reference', scopeId: callerId, limit: 500 }))
      .find((item) => item.source.ref === message.id && item.title.startsWith(`${title}:`));
    if (earlier) saved.push(deps.knowledge.correct(earlier.id, { title: referenceTitle(part.kind, part.text, input.situation, input.audience), body: part.text }, callerId));
    else saved.push(captureReference(deps.knowledge, { ...part, subject: callerId, situation: input.situation, audience: input.audience, messageId: message.id, by: callerId }));
  }
  return saved;
}

/** The references that fit `text` (any subject unless one is named), best first. */
export function findReferences(knowledge: KnowledgeService, input: { text: string; subject?: string; limit?: number }): Promise<KnowledgeHit[]> {
  return knowledge.search({ text: input.text, scopes: ['reference'], limit: (input.limit ?? 8) * (input.subject ? 3 : 1) })
    .then((hits) => (input.subject ? hits.filter((hit) => hit.item.scopeId === input.subject) : hits).slice(0, input.limit ?? 8));
}
