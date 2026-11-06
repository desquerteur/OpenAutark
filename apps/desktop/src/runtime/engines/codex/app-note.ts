// H1 (01.11.2026): the one app note a Codex agent thread gets about this app's team tools. Codex puts its own
// <multi_agent_role>/<multi_agent_mode> developer notes into a thread's context AFTER this app's instructions ("Any earlier
// instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user …
// explicitly asks …") – again when it forks a thread and in the history it rebuilds when it compacts. Live G1: a Codex
// Manager took agents.create / agents.delegate / tasks.create for that sub-agent spawning and never hired on a broad
// request (12 runs); Claude, without such a note, hired at once. A line in the instructions stands before Codex's note,
// so this note is a text item of the turn input – after Codex's – and only on the first turn of a thread this server
// process opened (start, resume, fork) and the first one after Codex compacted it (engine.ts keeps which threads are
// due): ~65 tokens once per thread life, not per turn.
// Owns: the note's text and its input item. Never: anything about a request's topic, or a note for a turn without a team tool.

import type { EngineTurnInput } from '../types.ts';

/** This app's team tools the note names (those the turn offers), in this order. */
export const TEAM_TOOLS: readonly string[] = ['agents.create', 'agents.delegate', 'tasks.create'];

/** The note for a turn whose tools include a team tool; '' otherwise. */
export function appNote(tools: EngineTurnInput['tools']): string {
  const offered = new Set(tools.map((tool) => tool.name));
  const names = TEAM_TOOLS.filter((name) => offered.has(name));
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const are = names.length === 1 ? 'is this app\'s own tool' : 'are this app\'s own tools';
  return `App note: ${list} ${are} for the person's team of lasting colleagues, not Codex sub-agents. The multi-agent note above is only about Codex's own spawn_agent tools – I use this app's tools whenever the work calls for them.`;
}

/** The note as a Codex input item (none for an empty note). */
export function appNoteItem(note: string | undefined): Array<Record<string, unknown>> {
  return note ? [{ type: 'text', text: note, text_elements: [] }] : [];
}
