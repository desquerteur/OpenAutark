// Skill tools: progressive disclosure of skills (skills.find lists them, the full text on demand). A skill is a plain
// folder with SKILL.md (skills/service.ts): an agent may also write or change one like any file.
// Owns: skills.load (any skill by name as the agent's route resolves it; home: true reads a skill of the agent's home
// project, agent-core/home-read.ts; in: a skill in any folder on the PC), skills.save (with the skill's modes; main: true
// writes one of the agent's own Main Skills; a built-in name becomes an own copy), loadedSkillText (a library skill's text,
// also the subconscious's skills.load) and the list of skill tools (skills.find: skills-find.ts).
// Never: lets skills grant tool rights or writes into the built-in folder.

import type { ToolContext, ToolDef } from '../types.ts';
import type { SkillInfo } from '../../../shared/model/knowledge.ts';
import { isCoreFolderName } from '../../agent-core/layout.ts';
import '../../contracts/agent-core.ts';
import { failure, json, text } from '../types.ts';
import { defineTool, internal } from './util.ts';
import { foreignSkillBody, skillFindTools } from './skills-find.ts';
import { loadHomeSkill } from '../../agent-core/home-read.ts';
import { fallbackDescription } from '../../../shared/text/external.ts';
import { catalogChanged } from '../../knowledge/catalog.ts';

const loadSkill = defineTool<{ name: string; home?: boolean; file?: string; in?: string }>({
  name: 'skills.load',
  description: 'Load the full instructions of a skill. home: true – a skill of my home project (listed under "Home project"); with file, one file of its folder instead. in: a folder on this PC – a skill skills.find listed there.',
  inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 }, home: { type: 'boolean' }, file: { type: 'string', minLength: 1, maxLength: 512 }, in: { type: 'string', minLength: 1, maxLength: 1024 } }, required: ['name'], additionalProperties: false },
  category: 'read',
  describe: (args) => internal(`Load ${args.home ? 'home project ' : ''}skill ${args.name}${args.file ? ` (${args.file})` : ''}${args.in ? ` from ${args.in}` : ''}`),
  async run(args, ctx) {
    if (args.in) {
      const read = foreignSkillBody(args.name, args.in, ctx.services.paths.workspace);
      return 'error' in read ? failure(read.error) : text(read.text);
    }
    if (args.home || args.file !== undefined) {
      const homes = ctx.services.agentCore?.homes;
      if (!args.home) return failure('file: only with home: true – a skill of the app loads whole.');
      if (!homes) return failure('Home projects are not available in this runtime.');
      const read = loadHomeSkill(homes, ctx.agent.id, args.name, args.file);
      return 'error' in read ? failure(read.error) : text(read.text);
    }
    const skill = ctx.services.skills.get(args.name, ctx.agent.id);
    if (!skill) return failure(`Skill "${args.name}" not found. Use skills.find.`);
    return text(loadedSkillText(skill));
  },
});

/** A library skill's text as skills.load gives it – the main AI's tool and the subconscious's (subconscious/tools.ts). */
export function loadedSkillText(skill: { info: SkillInfo; body: string }): string {
  return `# Skill: ${skill.info.name}\n(folder: ${skill.info.path})\n\n${skill.body}`;
}

const saveSkill = defineTool<{ name: string; description?: string; body: string; modes?: string[]; main?: boolean }>({
  name: 'skills.save',
  description: 'Save a reusable way of working as my own skill (agentskills format: lowercase-hyphen name, markdown body; a description of what + when is mine to give or the app writes one); the skill writing-skills shows what makes one steer well. The same name updates mine; a manager\'s, colleague\'s or built-in skill of that name gets my own adapted copy, which everyone below me sees too. A skill I write from public ones names them in its front matter (derived-from) and keeps only what holds up. modes: the modes whose skill list shows it ([] = every mode; leave it out to keep the current ones). main: true saves a new one as one of my main skills – kept in my agent folder and always listed in my prompt.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 64 }, description: { type: 'string', maxLength: 1024 }, body: { type: 'string', minLength: 1, maxLength: 60_000 },
      modes: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, maxItems: 30 }, main: { type: 'boolean' },
    },
    required: ['name', 'body'], additionalProperties: false,
  },
  category: 'write_local',
  describe: (args) => internal(`Save ${args.main ? 'main ' : ''}skill ${args.name}`, args.name),
  async run(args, ctx) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name)) return failure('name must be lowercase words joined by hyphens.');
    const existing = ctx.services.skills.get(args.name, ctx.agent.id);
    if (args.modes) {
      const known = ctx.services.modes.list().map((mode) => mode.key);
      const unknown = args.modes.filter((key) => !known.includes(key));
      if (unknown.length) return failure(`Unknown mode${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. Modes: ${known.join(', ')}.`);
    }
    const ownerAgentId = ctx.agent.id; // skills/service.ts saves in place when it is the agent's own or the shared one, else as an own copy
    const mainProblem = args.main ? mainSaveProblem(ctx, ownerAgentId, existing?.info) : undefined;
    if (mainProblem) return failure(mainProblem);
    // B-078: no description given – the one written before stays; a stand-in from the old body gives way to the new body's.
    const kept = existing && existing.info.description !== fallbackDescription(existing.body) ? existing.info.description : '';
    const info = ctx.services.skills.save({ name: args.name, description: args.description?.trim() || kept, body: args.body, ownerAgentId, modes: args.modes, ...(args.main ? { main: true } : {}) });
    catalogChanged(ctx.services);
    return json({ ok: true, name: info.name, modes: info.modes, folder: info.path });
  },
});

/** Why skills.save cannot write a main skill (undefined = it can). */
function mainSaveProblem(ctx: ToolContext, ownerAgentId: string, existing: SkillInfo | undefined): string | undefined {
  if (!ctx.services.agentCore) return 'Agent folders are not available here, so main skills cannot be saved.';
  if (!isCoreFolderName(ownerAgentId)) return 'This agent has no agent folder, so it cannot have main skills.';
  if (ctx.services.org.get(ownerAgentId)?.archivedAt !== undefined) return 'This agent is archived.';
  if (existing && existing.source === 'agent' && existing.ownerAgentId === ownerAgentId && existing.main !== true) return `The name "${existing.name}" is taken by another skill of mine. Choose another name for the main skill.`;
  return undefined;
}

export const skillTools: ToolDef[] = [loadSkill, saveSkill, ...skillFindTools];
