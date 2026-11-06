// The chat header's live line texts (ChatHeader.tsx, LiveLine.tsx): who works in this chat and what,
// B-075: from the chat's rows – its runs at work as the summary lists them (liveRuns: ConversationSummary.live, the
// rows in state 'streaming' with their meta.live), the same on every device (a bare tool name reads as what the agent does, format.ts workNote), in
// three lengths for the sub line's widths (chat.css) – the full line, a narrow window's line and a
// phone's line. A width picks the length, never a state, so a call starting never changes the text.
// B-048 E4.5: the line opens the working popover (WorkingPopover.tsx) – one row per member working
// here (workingRows: who, model · effort, live note, task; ordered by start like the live blocks) –
// and a live run's model line ("Opus 5.5 · High", modelLine – the short model name) is also the live block's byline.
// Owns: the texts. Never: markup, widths or a name or model the rows do not give.

import type { ConversationSummary } from '../../shared/model/chat.ts';
import type { Effort } from '../../shared/model/providers.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import { workNote } from '../lib/format.ts';

/** One activity entry: an agent running somewhere, with its live note (B-057: `split` on a split's run). */
export type LiveEntry = { agentId: string; conversationId?: string; note: string; split?: { groupId: string; of: number } };
type Chat = Pick<ConversationSummary, 'id' | 'working'>;
type NameOf = (id: string) => string | undefined;

/** B-075: the chat's runs at work as entries – from its rows (the summary's `live`: note, model · effort, task, start). */
export function liveRuns(chat: Pick<ConversationSummary, 'id' | 'live'>): AgentActivity[] {
  return (chat.live ?? []).map((run) => ({
    agentId: run.agentId, runId: run.runId, conversationId: chat.id, note: run.note ?? '', startedAt: run.startedAt,
    ...(run.model ? { modelName: run.model } : {}), ...(isEffort(run.effort) ? { effort: run.effort } : {}), ...(run.taskId ? { taskId: run.taskId } : {}),
  }));
}

/** A sentence's first letter in upper case ("running a command" → "Running a command"). */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** After a name and a colon a step reads on in lower case ("Running npm test" → "running npm test"; "PDF…" stays). */
const onward = (text: string) => text.replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase());

/** B-057: a split group's running parts as one note, "3 of 5 parts working" (splits/split-text.ts says the same). */
export function partsWorking(running: number, total: number): string {
  return `${running} of ${total} ${total === 1 ? 'part' : 'parts'} working`;
}

/** This chat's entries; a split group's runs are one entry (B-057: one line per group, never one per split). */
const here = (chat: Chat, entries: ReadonlyArray<LiveEntry>): LiveEntry[] => {
  const out: LiveEntry[] = [];
  const groups = new Map<string, { entry: LiveEntry; running: number }>();
  for (const entry of entries) {
    if (entry.conversationId !== chat.id) continue;
    if (!entry.split) { out.push(entry); continue; }
    const known = groups.get(entry.split.groupId);
    if (known) { known.running++; known.entry.note = partsWorking(known.running, entry.split.of); continue; }
    const folded: LiveEntry = { agentId: entry.agentId, conversationId: entry.conversationId, note: partsWorking(1, entry.split.of) };
    groups.set(entry.split.groupId, { entry: folded, running: 1 });
    out.push(folded);
  }
  return out;
};
/** Who works in this chat in the live line's order: its activity entries, then agents the chat's summary marks
 *  working without one – Home's "Chats that matter" names them the same way (C3 fix: one source for who works). */
export function workingIds(chat: Chat, entries: ReadonlyArray<LiveEntry>): string[] {
  return [...new Set([...here(chat, entries).map((entry) => entry.agentId), ...chat.working])];
}
/** "Ava, Mira +1" */
const names = (ids: readonly string[], nameOf: NameOf) => {
  const list = ids.map((id) => nameOf(id) ?? 'Agent');
  return list.slice(0, 2).join(', ') + (list.length > 2 ? ` +${list.length - 2}` : '');
};

/**
 * The full line: "Mira: cutting intro, Ava: running a command +1". In a 1:1 the avatar and the name
 * already say who: its agent's line is only what it does ("Running a command").
 */
export function liveStatus(chat: Chat, solo: string | undefined, entries: ReadonlyArray<LiveEntry>, nameOf: NameOf): string {
  const lines = here(chat, entries).map((entry) => {
    const doing = entry.note ? workNote(entry.note) : '';
    return entry.agentId === solo ? capital(doing || 'Working') : `${nameOf(entry.agentId) ?? 'Agent'}${doing ? `: ${onward(doing)}` : ''}`;
  });
  if (lines.length) return lines.slice(0, 2).join(', ') + (lines.length > 2 ? ` +${lines.length - 2}` : '');
  // Fallback: agents marked working on the summary without an activity note.
  if (solo && chat.working.includes(solo)) return 'Working';
  return chat.working.map((id) => nameOf(id)).filter(Boolean).join(', ');
}

/** A narrow sub line (a small window): one agent at work keeps its line ("Manager: running a command"); more agents, their names ("Ava, Mira +1"). */
export function liveShort(chat: Chat, solo: string | undefined, entries: ReadonlyArray<LiveEntry>, nameOf: NameOf): string {
  const ids = here(chat, entries).map((entry) => entry.agentId);
  return solo || ids.length < 2 ? liveStatus(chat, solo, entries, nameOf) : names(ids, nameOf);
}

/** A phone's sub line: a group's "Manager is working" or "Ava, Mira +1"; a 1:1 keeps its line ("Running a command"). */
export function liveNames(chat: Chat, solo: string | undefined, entries: ReadonlyArray<LiveEntry>, nameOf: NameOf): string {
  const ids = here(chat, entries).map((entry) => entry.agentId);
  if (solo || !ids.length) return liveStatus(chat, solo, entries, nameOf);
  return ids.length === 1 ? `${nameOf(ids[0]) ?? 'Agent'} is working` : names(ids, nameOf);
}

// ---------------------------------------------------------------- B-048 E4.5: the working popover and the model line

/** Effort as the person reads it (the composer's model menu uses the same words). */
export const EFFORT_LABEL: Record<Effort, string> = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Max' };

const isEffort = (value: unknown): value is Effort => typeof value === 'string' && Object.prototype.hasOwnProperty.call(EFFORT_LABEL, value);
const VENDOR = /^(?:Claude|Anthropic|OpenAI|Google)\s+(?=\S)/i;

/** A model's short name: its display name without the vendor word ("Claude Opus 5.5" → "Opus 5.5"). */
export function shortModelName(name: string): string {
  return name.trim().replace(VENDOR, '');
}

/** "claude:claude-opus-5-5" → "claude-opus-5-5" (only when the run reports no display name). */
const bareId = (id: string) => id.slice(id.indexOf(':') + 1);

/**
 * What a live run runs on: "Opus 5.5 · High" from its live values (B-075 meta.live: the runtime sets them at route
 * time and after a failover or rebuild); without them, its message's meta (model display name, effort); '' while it routes.
 */
export function modelLine(route: { model?: string; modelName?: string; effort?: string } | undefined, meta?: { model?: unknown; effort?: unknown }): string {
  const own = route?.modelName?.trim() || (route?.model ? bareId(route.model) : '');
  const name = own || (typeof meta?.model === 'string' ? meta.model.trim() : '');
  const effort = own ? route?.effort : meta?.effort;
  if (!name) return '';
  const short = shortModelName(name);
  return isEffort(effort) ? `${short} · ${EFFORT_LABEL[effort]}` : short;
}

/** A row's live note: what the agent does ("bash" → "Running a command", "waiting for approval" → "Waiting for approval"), else "Working". */
export function noteText(note: string | undefined): string {
  const doing = note?.trim() ? workNote(note) : '';
  return capital(doing || 'Working');
}

/** One member working in this chat, as the popover's row shows it. */
export interface WorkingRow {
  /** The run's id; `agent:<id>` for an agent the summary marks working without an activity entry. */
  key: string;
  agentId: string;
  runId?: string;
  name: string;
  /** modelLine; '' while routing (the slot stays). B-057: a split group row's goal (its parts run on several models). */
  model: string;
  note: string;
  taskId?: string;
  /** B-057: the row of a running split group (key `split:<groupId>`): it opens to the group's split rows. */
  groupId?: string;
}

/** B-057: a running split group of this chat as the popover lists it (splits/split-model.ts liveGroupsOf). */
export interface WorkingGroup { id: string; agentId: string; startedAt: number; note: string; goal?: string }

/**
 * The popover's rows: every run of this chat in start order (like the live blocks, so nothing
 * reorders), then agents the chat summary marks working without an entry yet. `metaOf` gives a run's
 * streaming message meta for its model before the activity has it. B-057: one row per running split
 * group (`groups`, and groups whose split runs report this chat) – never one per split.
 */
export function workingRows(chat: Chat, entries: ReadonlyArray<AgentActivity>, nameOf: NameOf, metaOf?: (runId: string) => { model?: unknown; effort?: unknown } | undefined, groups: ReadonlyArray<WorkingGroup> = []): WorkingRow[] {
  const mine = entries.filter((entry) => entry.conversationId === chat.id);
  const runs = mine.filter((entry) => !entry.split);
  const listed = new Map(groups.map((group) => [group.id, group]));
  for (const entry of mine) {
    if (!entry.split || listed.has(entry.split.groupId)) continue;
    const parts = mine.filter((other) => other.split?.groupId === entry.split!.groupId);
    listed.set(entry.split.groupId, { id: entry.split.groupId, agentId: entry.agentId, startedAt: Math.min(...parts.map((part) => part.startedAt)), note: partsWorking(parts.length, entry.split.of) });
  }
  const timed: Array<{ at: number; row: WorkingRow }> = [
    ...runs.map((entry) => ({ at: entry.startedAt, row: {
      key: entry.runId, agentId: entry.agentId, runId: entry.runId, name: nameOf(entry.agentId) ?? 'Agent',
      model: modelLine(entry, metaOf?.(entry.runId)), note: noteText(entry.note), ...(entry.taskId ? { taskId: entry.taskId } : {}),
    } })),
    ...[...listed.values()].map((group) => ({ at: group.startedAt, row: {
      key: `split:${group.id}`, agentId: group.agentId, groupId: group.id, name: nameOf(group.agentId) ?? 'Agent', model: group.goal ?? '', note: group.note,
    } })),
  ];
  const rows: WorkingRow[] = timed.sort((a, b) => a.at - b.at).map((entry) => entry.row);
  const shown = new Set(rows.map((row) => row.agentId));
  for (const id of chat.working) {
    if (shown.has(id)) continue;
    shown.add(id);
    rows.push({ key: `agent:${id}`, agentId: id, name: nameOf(id) ?? 'Agent', model: '', note: 'Working' });
  }
  return rows;
}
