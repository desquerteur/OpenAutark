// human.ask: the tool form of an ask block, for engines that cannot emit ```ui fences reliably. Creates a to-do for the
// person (a task owned by 'human' with a widget) – in the run's chat or chatId when the agent is in it (B-054
// util.ts chatIfAny), else chat-free on the owner's My day: a to-do needs no chat.
// Meeting 31.10.: what an agent cannot do itself because it needs hands or presence (reason 'physical', e.g. the
// dishwasher) – or anything asked with a time (`at`) – lands on My day and in the calendar at once
// (calendar.ts placeOnMyDay: at that time, else the first free slot today or tomorrow).
// B-059: the same open ask of the same agent at the same place (chat, parent task, person, reason, widget type) is
// returned, not added again – a daily routine does not pile up duplicates.
// B-076: its note says how the person's click comes back – as their line with what they picked, in a new turn.
// B-078 D9 (owner 06.11.: "eigentlich soll sich die KI ja immer darum selbst kümmern"): no 'approval' reason – a
// call with it gets SELF_CHECK_NOTE at once (no to-do): what is mine to decide I decide and report. An approve widget
// becomes a yes/no choice. `important` also shows it in the strip above the person's input field (priority >= 1).
// Owns: validation of the ask widget. Never: keeps a host-only prop (accessRequestId) an agent passed.

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import { ALIASES, ASK_TYPES, HOST_ONLY_PROPS, YES_NO, type BlockType, type UiBlock } from '../../../shared/blocks/catalog.ts';
import type { HumanReason } from '../../../shared/model/tasks.ts';
import { chatIfAny, clip, defineTool, internal, parseWhen } from './util.ts';
import { TIME, placeOnMyDay, toolTime } from './calendar.ts';
import { profileZone } from '../../calendar/service.ts';
import { askTarget } from '../../people/ask-target.ts';

const REASONS: HumanReason[] = ['physical', 'identity', 'credential', 'taste', 'review'];
/** Reasons that ask for a permission – none of them is the person's part (B-078 D9). */
const PERMISSION_REASONS = new Set(['approval', 'consent', 'permission', 'confirmation']);
/** The tool result for a permission ask: the agent's own self-check, said in its voice. */
export const SELF_CHECK_NOTE = 'This is mine to decide: I check what it touches, then go ahead or choose another way, and say what I did in my report (tasks.complete alsoHandled). The person\'s hands, presence, identity, secrets and taste are theirs – a signature or a purchase in their name is their identity or taste (reason "identity" or "taste").';
interface AskAt { conversationId?: string; parentId?: string; assigneeId?: string; reason: HumanReason; type: string }

/** This agent's still open to-do asking the same thing at the same place (see the header). */
function openAsk(ctx: ToolContext, title: string, at: AskAt): string | undefined {
  const wanted = title.trim().toLowerCase();
  const rows = ctx.services.db.all<{ id: string; title: string; assignee_id: string | null; human_reason: string | null; type: string | null }>(
    `SELECT id, title, assignee_id, human_reason, json_extract(widget, '$.type') AS type FROM tasks
      WHERE created_by = ? AND assignee_kind = 'human' AND status NOT IN ('done', 'cancelled')
        AND conversation_id IS ? AND parent_id IS ? ORDER BY created_at DESC LIMIT 50`,
    [ctx.agent.id, at.conversationId ?? null, at.parentId ?? null],
  );
  const person = (id: string | null | undefined) => (id && id !== 'human' ? id : undefined);
  return rows.find((row) => row.title.trim().toLowerCase() === wanted && person(row.assignee_id) === person(at.assigneeId)
    && row.human_reason === at.reason && row.type === at.type)?.id;
}

export function normalizeAskWidget(widget: Record<string, unknown>): UiBlock | string {
  const raw = String(widget.type ?? '').toLowerCase();
  const type = (raw === 'approve' ? 'choice' : ALIASES[raw] ?? raw) as BlockType; // B-078: a yes/no is a choice
  if (!ASK_TYPES.has(type) || type === 'approve') return `widget.type must be one of: ${[...ASK_TYPES].filter((name) => name !== 'approve').join(', ')}`;
  // Host-only props: only the host's own to-dos carry them.
  const rest: Record<string, unknown> = { ...widget };
  for (const key of HOST_ONLY_PROPS) delete rest[key];
  if (type === 'choice' && type !== raw && rest.options === undefined) {
    rest.options = [...YES_NO];
    rest.question ??= rest.action;
  }
  return { ...rest, type } as UiBlock;
}

const askHuman = defineTool<{ title: string; reason: string; widget: Record<string, unknown>; why?: string; chatId?: string; dueAt?: string; at?: string; minutes?: number; priority?: number; important?: boolean; taskId?: string }>({
  name: 'human.ask',
  description: 'I put one item on the person\'s "My day" list with the right widget (choice, form, checklist, timer, record, upload, confirm, review). I hand the person only what needs their hands or presence (reason "physical": it also goes into their calendar at `at`, else the first free slot today), their identity, a secret only they hold ("credential"), their taste, or their look at a result ("review"). A full disk, a failed job, a renewal or a yes I can give myself is mine: I handle it and put it into my report (tasks.complete alsoHandled). important: true also shows it above their input field. Without a chat it goes on the owner\'s My day; in a chat with colleagues to the person who wrote last.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      reason: { type: 'string', description: REASONS.join(' | ') },
      widget: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] },
      why: { type: 'string', maxLength: 300 }, chatId: { type: 'string' }, dueAt: { type: 'string' },
      at: { ...TIME, description: 'When the person should do it (puts it into their calendar). ISO datetime in their local time, or relative ("+2h").' },
      minutes: { type: 'integer', minimum: 5, maximum: 720 },
      priority: { type: 'integer', minimum: 0, maximum: 2 }, important: { type: 'boolean' }, taskId: { type: 'string' },
    },
    required: ['title', 'reason', 'widget'], additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => internal(`Ask the human: ${clip(args.title, 80)}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const given = String(args.reason ?? '').trim().toLowerCase();
    if (PERMISSION_REASONS.has(given)) return json({ ok: true, todo: false, note: SELF_CHECK_NOTE }); // B-078 D9: my own self-check
    if (!REASONS.includes(given as HumanReason)) return failure(`reason must be one of: ${REASONS.join(', ')}`);
    const reason = given as HumanReason;
    const conversationId = chatIfAny(ctx, args.chatId); // B-054: undefined = a chat-free to-do on the owner's My day
    const widget = normalizeAskWidget(args.widget);
    if (typeof widget === 'string') return failure(widget);
    if (widget.type === 'choice' && !widget.question) widget.question = args.title;
    if (args.important) widget.important = true;
    if (args.why) widget.why = args.why;
    // C4-live: a confirm that names no steps of its own shows what the to-do says (why, else its title).
    if (widget.type === 'confirm' && !widget.instructions) widget.instructions = args.why ?? args.title;
    const now = ctx.services.clock.now();
    const at = args.at === undefined ? undefined : toolTime(args.at, now, profileZone(ctx.services));
    if (args.at !== undefined && at === undefined) return failure('Give `at` as a time ("2026-10-25T17:00" or "+2h").');
    // F-52: in a chat with colleagues the ask goes to the person who wrote last (people/ask-target.ts), else the owner.
    const asked = conversationId ? askTarget(ctx.services.db, conversationId, (ctx.services.chats.get(conversationId)?.lastSeq ?? 0) + 1, reason) : undefined;
    const same = openAsk(ctx, args.title, { conversationId, parentId: args.taskId, assigneeId: asked, reason, type: widget.type });
    if (same) return json({ ok: true, todoId: same, already: true, note: 'The person already has this to-do from me, so it was not added again. Their click or entry reaches me in a new turn as their line with what they picked; I continue other work meanwhile.' });
    const task = ctx.services.tasks.create({
      ...(conversationId ? { conversationId } : {}), ...(ctx.origin ? { origin: ctx.origin } : {}), title: args.title, assigneeKind: 'human', ...(asked ? { assigneeId: asked } : {}), widget, humanReason: reason,
      dueAt: parseWhen(args.dueAt, now) ?? at, priority: Math.max(args.priority ?? 0, args.important ? 1 : 0) as 0 | 1 | 2,
      parentId: args.taskId, createdBy: ctx.agent.id, ...(args.minutes ? { estimateMin: args.minutes, estimateSource: 'model' as const } : {}),
    });
    // The owner's own to-do that needs presence (or has a time) goes into their calendar now, not at the next morning plan.
    const placed = !asked && (at !== undefined || reason === 'physical') ? placeOnMyDay(ctx, task.id, at, args.minutes) : undefined;
    return json({ ok: true, todoId: task.id, ...(placed?.when ? { calendar: placed.when } : {}), ...(placed?.note ? { calendarNote: placed.note } : {}), note: 'Their click or entry reaches me in a new turn as their line with what they picked; I continue other work meanwhile.' });
  },
});

export const humanTools: ToolDef[] = [askHuman];
