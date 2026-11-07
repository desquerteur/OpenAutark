// AF-014: "Agent from folder" – hires an agent for a folder the person chose (dialog, drag & drop or the Explorer's
// right-click menu): the folder becomes its home project (agent-core setHome: its turns start there, the prompt's "Home
// project" carries the folder's instruction files and skills), its own part of SYSTEM.md says it follows those files and
// uses those skills, and it starts in the access mode 'project' (AF-013: changes inside this folder by itself, asks for
// anything outside). Several agents per folder are fine; one that fails half-way is archived again.
// Owns: these steps and the agent's starting text. Never: writes into the folder.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { FOLDER_AGENT_MODE } from '../../shared/model/access.ts';
import type { FolderAgentInput, FolderFinding } from '../../shared/model/folder-agent.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/agent-core.ts';
import '../contracts/access.ts';
import { analyzeFolder } from './analyze.ts';

const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const list = (items: readonly string[], max = 12): string => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

type Services = Pick<RuntimeServices, 'org' | 'agentCore' | 'access'>;

function core(services: Services) {
  if (!services.agentCore) throw new WorkforceError('unavailable', 'Agent folders are not available in this runtime.');
  return services.agentCore;
}

/** The absolute folder `given` names, checked like a home project (bad_request with the reason). */
export function resolveFolder(services: Services, given: string): string {
  const dir = core(services).homes.resolve(given);
  if (!dir) throw new WorkforceError('bad_request', 'folder: choose a folder.');
  return dir;
}

/** The agents (not archived) whose home project is `dir`. */
export function agentsIn(services: Services, dir: string): Array<{ id: string; name: string }> {
  const homes = core(services).homes;
  return services.org.list().filter((agent) => { try { const home = homes.stored(agent.id); return home !== undefined && same(home, dir); } catch { return false; } })
    .map((agent) => ({ id: agent.id, name: agent.name }));
}

export function findFolder(services: Services, given: string): FolderFinding {
  const dir = resolveFolder(services, given);
  return analyzeFolder(dir, agentsIn(services, dir));
}

/** The agent's own part of SYSTEM.md (under "## My role"): its folder, the files it follows and the skills it uses. */
export function folderAgentText(finding: FolderFinding): string {
  const lines = [
    `I work on the project in ${finding.folder} – my home project: my turns start there. My access mode decides what I change by myself; anything it does not cover I ask the person first.`,
  ];
  if (finding.about) lines.push(`About the project: ${finding.about}`);
  if (finding.instructions.length) lines.push(`I follow the project's own instructions for all work in this folder: ${list(finding.instructions)}. They stand under "Home project" in every turn; a long one I read in the folder before work it covers.`);
  if (finding.skills.length) lines.push(`The project's skills are mine to use: ${list(finding.skills)}. Before that kind of work I read its SKILL.md in the folder.`);
  if (finding.configs.length) lines.push(`Settings the project keeps for other tools (${list(finding.configs, 6)}) I read as information; they change nothing about how this app runs me.`);
  return lines.join('\n\n');
}

export function createFolderAgent(services: Services, input: FolderAgentInput): { agent: Agent; finding: FolderFinding } {
  const finding = findFolder(services, input.folder);
  const name = input.name.trim() || finding.name;
  const role = input.role.trim() || finding.role;
  const created = services.org.create({ name, role, instructions: folderAgentText(finding), createdBy: HUMAN_ID });
  try {
    core(services).setHome(created.id, finding.folder);
    services.access?.set(created.id, { mode: input.mode ?? FOLDER_AGENT_MODE });
  } catch (error) {
    try { services.org.archive(created.id); } catch { /* the error below says what went wrong */ }
    throw error;
  }
  return { agent: services.org.require(created.id), finding };
}
