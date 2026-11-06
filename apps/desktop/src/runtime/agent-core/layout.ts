// Agent core folder layout and file rules (wave 3, shared/model/agent-core.ts): <data>/agents/<agentId>/
// with agent.json, SYSTEM.md and skills/<name>/SKILL.md. The folder is named by the agent's id (stable:
// a rename never moves it, names may collide or hold characters no file system takes); agent.json
// carries the readable name. SYSTEM.md is plain Markdown – the whole file is the agent's instructions,
// one to one (a UTF-8 BOM, CR line ends and trailing white space do not count as a change).
// Owns: paths, SYSTEM.md's limits and text form, the manifest text and the Main Skills folder's change
// signature. Reading, validating and writing the files (bounded, no link followed, atomic) and the text
// comparison rules (canonical, staleBase) are the data folder's text documents (runtime/root/text-doc.ts).
// Never: follows another agent's folder, reads anything else of the data folder, or decides what wins
// (agent-core/service.ts).

import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import { AGENT_CORE_DIR, CORE_MANIFEST, MAIN_SKILLS_DIR, SYSTEM_FILE, SYSTEM_MAX_BYTES, SYSTEM_MAX_CHARS } from '../../shared/model/agent-core.ts';
import type { Agent } from '../../shared/model/org.ts';
import { canonical, signature, type TextLimits, type TextRead } from '../root/text-doc.ts';

/** Agent ids as folder names: letters, digits, '_', '-', '.', no '..' (ids are newId() values). */
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
export const CORE_FORMAT = 'workforce-agent-core';

export const coreRoot = (dataDir: string): string => path.join(dataDir, AGENT_CORE_DIR);

export function isCoreFolderName(name: string): boolean {
  return FOLDER.test(name) && !name.includes('..');
}

export function agentFolder(dataDir: string, agentId: string): string {
  if (!isCoreFolderName(agentId)) throw new WorkforceError('bad_request', 'Invalid agent folder.');
  return path.join(coreRoot(dataDir), agentId);
}

export const systemFile = (dataDir: string, agentId: string): string => path.join(agentFolder(dataDir, agentId), SYSTEM_FILE);
export const manifestFile = (dataDir: string, agentId: string): string => path.join(agentFolder(dataDir, agentId), CORE_MANIFEST);
export const mainSkillsDir = (dataDir: string, agentId: string): string => path.join(agentFolder(dataDir, agentId), MAIN_SKILLS_DIR);

/** The Main Skills folders of the agents `known` accepts (SkillLibrary mainRoots); folders of unknown ids are left alone. */
export function mainSkillRoots(dataDir: string, known: (agentId: string) => boolean): Array<{ dir: string; ownerAgentId: string }> {
  let names: string[];
  try {
    names = readdirSync(coreRoot(dataDir), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
  return names.filter((name) => isCoreFolderName(name) && known(name)).map((name) => ({ dir: path.join(coreRoot(dataDir), name, MAIN_SKILLS_DIR), ownerAgentId: name }));
}

/** Names, times and sizes of an agent's Main Skill files (a change on disk changes it; '' = none). */
export function mainSkillsSignature(dataDir: string, agentId: string): string {
  let dir: string;
  let names: string[];
  try {
    dir = mainSkillsDir(dataDir, agentId);
    names = readdirSync(dir).sort();
  } catch {
    return '';
  }
  return names.map((name) => {
    try { return `${name}@${signature(statSync(path.join(dir, name, 'SKILL.md')))}`; } catch { return name; }
  }).join('|');
}

/** SYSTEM.md's content for `instructions`: empty, or the text with one final line end. */
export function systemText(instructions: string): string {
  const text = canonical(instructions);
  return text ? `${text}\n` : '';
}

/** What SYSTEM.md holds right now (runtime/root/text-doc.ts). */
export type SystemRead = TextRead;

/** SYSTEM.md's read limits: the instructions' character cap, larger files not read at all. */
export const SYSTEM_LIMITS: TextLimits = { maxBytes: SYSTEM_MAX_BYTES, maxChars: SYSTEM_MAX_CHARS };

/** agent.json as it is on disk (undefined: none, a link, or unreadable) – to tell whether a rename must rewrite it. */
export function readManifest(file: string): string | undefined {
  try {
    const info = lstatSync(file);
    return info.isFile() && info.size <= 64 * 1024 ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** agent.json: a readable label for people and scripts looking at the folder, and (B-044) the agent's home project (agent-core/home.ts). */
export function manifestText(agent: Pick<Agent, 'id' | 'name' | 'role'>, home?: string): string {
  return `${JSON.stringify({ format: CORE_FORMAT, version: 1, id: agent.id, name: agent.name, role: agent.role, ...(home ? { home } : {}) }, null, 2)}\n`;
}
