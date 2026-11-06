// The see-through prompt (B-066, the owner's question "wird da irgendwas verschwiegen?"): every turn of the agent's main
// lane (B-076: not a split's parts, which run beside it) the assembled system prompt lands in
// <data>/agents/<id>/last-prompt.md, so the person and any agent can read what is really sent.
// B-076 (owner 05.11.: he asked for "den kompletten letzten Runtime-Ding … wo die ganzen Daten noch dazu sind"): the head
// says SYSTEM.md is the main part and where the turn's full history (messages, tool calls, results) lives – the run log.
// Already secret-redacted by the caller; overwritten each turn; never fails a turn; never creates the agent's folder.
// Owns: this file's name and text form. Never: reads it back or lets it influence a prompt.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentFolder, isCoreFolderName } from '../agent-core/layout.ts';

export const LAST_PROMPT_FILE = 'last-prompt.md';

/** The file's text: what it is, then the stable and the volatile part as sent. */
export function lastPromptText(parts: { stable: string; volatile: string }): string {
  return [
    '<!-- My whole system prompt as the app sent it on my last turn, secrets replaced by their handles; the app writes this file again each turn, so editing it changes nothing. Its main part is my SYSTEM.md (the team\'s "How I work", my role, what I have here) – that file is what changes me. Around it the app adds who I am, my environment and the live facts (now, this chat, team, tasks); the engine (Claude Code, Codex) adds its tool descriptions, and a new session gets a recap of my latest answers. What I did on my last turn – its input, each tool call and its result, my final text – is in last-run.md beside it; earlier turns are in my run log: Team › Runs in the app, or wf call agents.runs \'{"id":"<my id>"}\' and then wf call runs.items \'{"runId":"<run id>"}\' (the JSON quoted for the shell). -->',
    '',
    parts.stable,
    '',
    parts.volatile,
    '',
  ].join('\n');
}

/** Writes the file when the agent has its folder; any failure is only a debug line. */
export function writeLastPrompt(dataDir: string | undefined, agentId: string, parts: { stable: string; volatile: string }, debug?: (message: string, data: Record<string, unknown>) => void): void {
  if (!dataDir || !isCoreFolderName(agentId)) return;
  try {
    writeFileSync(path.join(agentFolder(dataDir, agentId), LAST_PROMPT_FILE), lastPromptText(parts), 'utf8');
  } catch (error) {
    debug?.('last prompt not written', { agentId, error: String(error) });
  }
}
