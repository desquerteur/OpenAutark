// AF-006: an agent's own personality – <data>/agents/<id>/personality.json beside its SYSTEM.md, a plain JSON object
// with only the fields it overrides ({ "tone": "casual", "emoji": "off" }); a missing field follows the global one
// (settings.json `personality`). Read fresh for every turn's prompt (personality/prompt.ts) – an edit by the page, the
// AI or by hand applies at the next answer, no restart, no watcher. An unreadable or invalid file counts as empty, an
// invalid field is dropped (shared/model/personality.ts cleanPersonality). Saving nothing removes the file.
// Owns: the file's name, its read limit and its text form. Never: follows a link, reads anything else of the folder.

import { rmSync } from 'node:fs';
import path from 'node:path';
import { agentFolder, isCoreFolderName } from '../agent-core/layout.ts';
import { readText, statFile, writeAtomic } from '../root/text-doc.ts';
import { cleanPersonality, type AgentPersonality } from '../../shared/model/personality.ts';

export const PERSONALITY_FILE = 'personality.json';
const LIMITS = { maxBytes: 16 * 1024, maxChars: 16 * 1024 } as const;

/** The file of `agentId` (undefined: no data folder, or an id that is no folder name). */
export function personalityFile(dataDir: string | undefined, agentId: string): string | undefined {
  if (!dataDir || !isCoreFolderName(agentId)) return undefined;
  return path.join(agentFolder(dataDir, agentId), PERSONALITY_FILE);
}

/** The agent's own values ({} without a file, or with one that is not a JSON object). Never throws. */
export function readAgentPersonality(dataDir: string | undefined, agentId: string): AgentPersonality {
  const file = personalityFile(dataDir, agentId);
  if (!file) return {};
  try {
    const read = readText(file, LIMITS);
    if (read.kind !== 'ok') return {};
    return cleanPersonality(JSON.parse(read.text));
  } catch {
    return {};
  }
}

/** Writes the valid fields of `value` (nothing left: the file goes); returns what is stored now. */
export function writeAgentPersonality(dataDir: string | undefined, agentId: string, value: AgentPersonality): AgentPersonality {
  const file = personalityFile(dataDir, agentId);
  if (!file) throw new Error('This agent has no agent folder.');
  const clean = cleanPersonality(value);
  if (!Object.keys(clean).length) {
    if (statFile(file)?.isFile()) rmSync(file, { force: true });
    return {};
  }
  writeAtomic(file, `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}
