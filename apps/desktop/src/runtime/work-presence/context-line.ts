// B-055 G (WORK-PRESENCE, Q11): the "## Working nearby" section of the volatile prompt (context/prompt-volatile.ts,
// section 'work-nearby'; a resumed session gets it only when it changed – agents/volatile-delta.ts). Only what concerns
// this agent, at most MAX_LINES lines and MAX_CHARS characters with the header, nothing when there is nothing:
//   - first the notes its finished turns left (ledger.ts): "Ada also changed src/app.ts while I worked on it – I check
//     before I continue." – each said once;
//   - then other agents' changes from the last 10 minutes or of a turn still running, of files this agent read or
//     changed (within the ledger's 2 h) or below the folder it works in (not through another task's worktree), one
//     line per agent, its newest two files: "Ada is editing src/app.ts (1 min ago, still working)." / "Ada edited
//     src/app.ts, src/b.ts +1 more (4 min ago)."
// Paths are shown relative to the agent's folder, else the workspace. The person's own edits are not seen here (no
// file watcher).
// Owns: the relevance filter, the wording and the caps, agoText. Never: reads files or says the same change twice.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { WorkEntry } from './ledger.ts';
import { folderKey, isUnder, shownPath } from './paths.ts';
import './contract.ts'; // RuntimeServices.workPresence

export const HEADER = '## Working nearby';
export const MAX_LINES = 3;
export const MAX_CHARS = 300;
const FILES_SHOWN = 2;

/** "just now", "4 min ago", "2 h ago". */
export function agoText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

/** The section for this agent's turn; '' when no one works near it. Takes its pending notes (said once). */
export function workNearbySection(services: RuntimeServices, input: { agent: Pick<Agent, 'id'>; taskId?: string }): string {
  const presence = services.workPresence;
  if (!presence) return '';
  const { ledger } = presence;
  const agentId = input.agent.id;
  const now = services.clock.now();
  const cwd = presence.realDir(presence.cwdFor(agentId, input.taskId)); // the keys' spelling (real folders)
  const bases = [cwd, presence.realDir(services.paths.workspace)];
  const lines: string[] = [];
  const said = new Set<string>();
  for (const note of ledger.takeNotes(agentId)) {
    said.add(`${note.byAgentId}|${note.key}`);
    lines.push(`${note.byName} also changed ${shownPath(note.file, bases)} while I worked on it – I check before I continue.`);
  }
  const mine = new Set(ledger.touchedBy(agentId).map((entry) => entry.key));
  const cwdKey = folderKey(cwd);
  const byAgent = new Map<string, WorkEntry[]>();
  for (const entry of ledger.recentChanges(agentId)) {
    if (said.has(`${entry.agentId}|${entry.key}`)) continue;
    if (!mine.has(entry.key) && !(cwdKey && isUnder(entry.key, cwdKey))) continue;
    const entries = byAgent.get(entry.agentId) ?? [];
    if (!entries.some((known) => known.key === entry.key)) entries.push(entry);
    byAgent.set(entry.agentId, entries);
  }
  for (const entries of byAgent.values()) lines.push(agentLine(entries, bases, now, ledger.isRunning(entries[0].runId)));
  return capped(lines);
}

/** One agent's line: its newest files (entries newest first), when, and whether that turn still runs. */
function agentLine(entries: WorkEntry[], bases: string[], now: number, running: boolean): string {
  const [newest] = entries;
  const files = entries.slice(0, FILES_SHOWN).map((entry) => shownPath(entry.file, bases)).join(', ');
  const more = entries.length > FILES_SHOWN ? ` +${entries.length - FILES_SHOWN} more` : '';
  const when = agoText(newest.at, now);
  return running ? `${newest.agentName} is editing ${files}${more} (${when}, still working).` : `${newest.agentName} edited ${files}${more} (${when}).`;
}

/** The header and the lines that fit MAX_LINES / MAX_CHARS; '' without a line. */
function capped(lines: string[]): string {
  const kept = [HEADER];
  let used = HEADER.length;
  for (const line of lines) {
    if (kept.length > MAX_LINES) break;
    if (used + 1 + line.length > MAX_CHARS) continue; // a shorter line further down may still fit
    kept.push(line);
    used += 1 + line.length;
  }
  return kept.length > 1 ? kept.join('\n') : '';
}
