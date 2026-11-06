// Reference tools, open to every agent: references.find (the person's own examples, reasons and corrections
// that fit a draft or decision – write and decide the way they would) and references.capture (keep the person's
// own words or stated reason as a reference). References are memory files (references/references.ts).
// `person`: whose references – the owner by default, or a colleague of the organisation by name or id.
// Owns: the tool wording and argument shapes. Never: storage rules (references/references.ts).

import type { RuntimeServices } from '../../contracts.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { isPersonId } from '../../../shared/model/people.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { REFERENCE_KINDS, captureReference, findReferences, type ReferenceKind } from '../../references/references.ts';
import type { ToolDef } from '../types.ts';
import { failure, json, text } from '../types.ts';
import { clip, defineTool, internal } from './util.ts';

const PERSON = { type: 'string', maxLength: 120, description: "Whose references: leave out for the owner (CEO); a colleague's name or id (per_…)." } as const;

/** The subject a tool call names – the owner by default, else a person still in the organisation (by id or exact name). */
export function subjectOf(services: RuntimeServices, person: string | undefined): string {
  const value = person?.trim();
  if (!value || value === HUMAN_ID) return HUMAN_ID;
  if (isPersonId(value)) return value;
  let rows: Array<{ id: string }> = [];
  try { rows = services.db.all<{ id: string }>("SELECT id FROM people WHERE status <> 'revoked' AND lower(name) = lower(?) AND id <> ?", [value, HUMAN_ID]); } catch { /* no people here */ }
  if (rows.length !== 1) throw new WorkforceError('not_found', rows.length ? `More than one colleague is called "${clip(value, 60)}" – use their id.` : `No colleague called "${clip(value, 60)}".`);
  return rows[0].id;
}

const find = defineTool<{ text: string; person?: string; limit?: number }>({
  name: 'references.find',
  description: "The person's own examples, reasons, goals, exceptions, style notes and corrections that fit what I am about to write or decide for them – so I answer, write and prioritise the way they would. Corrections outrank older examples.",
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1, maxLength: 2000 }, person: PERSON, limit: { type: 'integer', minimum: 1, maximum: 20 } },
    required: ['text'], additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Find references for "${clip(args.text, 60)}"`),
  async run(args, ctx) {
    try {
      const hits = await findReferences(ctx.services.knowledge, { text: args.text, subject: subjectOf(ctx.services, args.person), limit: args.limit });
      if (!hits.length) return text('No reference fits: I do not know how they would decide – I say so or ask them.');
      return text(hits.map((hit) => `- [${hit.item.id}] ${hit.item.title}: ${clip(hit.item.body, 500)} — ${hit.why}`).join('\n'));
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

const capture = defineTool<{ kind: ReferenceKind; text: string; situation?: string; audience?: string; messageId?: string; person?: string }>({
  name: 'references.capture',
  description: "Keep the person's own words as a reference: example (text they wrote), reason / goal / exception (why they decided), style (how they write) or correction (their feedback on a draft). Their words only – not anyone else's. situation and audience help later drafts.",
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...REFERENCE_KINDS] }, text: { type: 'string', minLength: 1, maxLength: 8000 },
      situation: { type: 'string', maxLength: 300 }, audience: { type: 'string', maxLength: 120 }, messageId: { type: 'string' }, person: PERSON,
    },
    required: ['kind', 'text'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Keep a reference: ${clip(args.text, 60)}`),
  async run(args, ctx) {
    try {
      const item = captureReference(ctx.services.knowledge, { ...args, subject: subjectOf(ctx.services, args.person), by: ctx.agent.id });
      return json({ ok: true, id: item.id, title: item.title });
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

export const referenceTools: ToolDef[] = [find, capture];
