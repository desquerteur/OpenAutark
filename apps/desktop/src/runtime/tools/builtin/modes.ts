// Mode tools (CTX8): new kinds of work without an app update. Every agent reads the modes
// (modes.list; with a key the whole mode, its instructions included) and defines them
// (modes.save → <data>/modes/<key>.md, modes/service.ts). Saving under a built-in key
// replaces the built-in mode until the person deletes the copy in Settings › Knowledge & skills.
// 23.10.: the list marks
// the mode the caller works in now (current) and names up to three colleagues whose own mode it is
// (specialists, modes/strategy.ts) – what an agent needs to choose between switching and delegating.
// Owns: modes.list and modes.save (the result text).
// Never: deletes modes (the person only, RPC modes.delete) or validates the mode itself – ModeLibrary refuses bad fields.

import type { ModeSaveInput } from '../../../shared/model/knowledge.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { LIMITS, MODE_CATEGORIES, MODE_QUALIFIED_TIERS, MODE_TIERS, MODE_WORKSPACES } from '../../modes/service.ts';
import type { ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import { defineTool, internal } from './util.ts';
import { specialistsFor } from '../../modes/strategy.ts';

const KEY = { type: 'string', minLength: 1, maxLength: 64 } as const;
const NAMES = { type: 'array', items: KEY, maxItems: LIMITS.items } as const;

const listModes = defineTool<{ key?: string }>({
  name: 'modes.list',
  description: 'List the modes (key, name, what they are for, built-in or saved in this company, the one I work in now, colleagues who work in it). With key: that whole mode, its instructions, skills and tools included.',
  inputSchema: { type: 'object', properties: { key: KEY }, additionalProperties: false },
  category: 'read',
  describe: (args) => internal(args.key ? `Read mode ${args.key}` : 'List modes'),
  async run(args, ctx) {
    const modes = ctx.services.modes.list();
    if (!args.key) {
      return json(modes.map((mode) => {
        const specialists = specialistsFor(ctx.services, mode.key, ctx.agent.id);
        return {
          key: mode.key, name: mode.name, description: mode.description, source: mode.source ?? 'builtin', replacesBuiltin: mode.overrides || undefined,
          ...(mode.key === ctx.mode ? { current: true } : {}), ...(specialists.length ? { specialists } : {}),
        };
      }));
    }
    const mode = modes.find((entry) => entry.key === args.key);
    return mode ? json(mode) : failure(`Mode "${args.key}" not found. Modes: ${modes.map((entry) => entry.key).join(', ')}.`);
  },
});

const saveMode = defineTool<ModeSaveInput>({
  name: 'modes.save',
  description: 'Create or change a mode – key (lowercase-hyphen), name, description (what kind of work), instructions (the prompt section agents get in this mode), skills, tools (name patterns, "*" = all, "!shell.*" excludes), category (routing), workspace, verifier, minTier, qualifiedTier. Fields left out keep the current values; from: start from a copy of another mode. Saving a built-in key replaces that mode for the whole company. Skills that do not exist yet are saved and reported.',
  inputSchema: {
    type: 'object',
    properties: {
      key: KEY, from: KEY,
      name: { type: 'string', minLength: 1, maxLength: LIMITS.name },
      description: { type: 'string', minLength: 1, maxLength: LIMITS.description },
      instructions: { type: 'string', minLength: 1, maxLength: LIMITS.instructions },
      skills: NAMES, tools: NAMES,
      category: { type: 'string', enum: [...MODE_CATEGORIES] },
      workspace: { type: 'string', enum: ['', ...MODE_WORKSPACES] },
      verifier: { type: 'string', maxLength: LIMITS.verifier },
      minTier: { type: 'string', enum: [...MODE_TIERS] },
      qualifiedTier: { type: 'string', enum: ['', ...MODE_QUALIFIED_TIERS] },
    },
    required: ['key'], additionalProperties: false,
  },
  category: 'agents',
  describe: (args, ctx) => {
    const key = args.key.trim().toLowerCase();
    const current = ctx.services.modes.list().find((mode) => mode.key === key);
    const what = !current ? `Create mode "${args.name ?? key}"` : current.source === 'user' ? `Change mode "${current.name}"` : `Replace the built-in mode "${current.name}"`;
    return { summary: args.from ? `${what} from a copy of "${args.from}"` : what, resource: `modes/${key}.md`, reversible: true, external: false };
  },
  async run(args, ctx) {
    try {
      const { mode, unknownSkills } = ctx.services.modes.save(args);
      return json({
        ok: true, key: mode.key, name: mode.name,
        ...(mode.overrides ? { replacesBuiltin: true, note: `Deleting <data>/modes/${mode.key}.md brings the built-in mode back.` } : {}),
        ...(unknownSkills.length ? { unknownSkills, hint: 'No skill has these names yet – save them with skills.save or fix the names.' } : {}),
      });
    } catch (error) {
      if (error instanceof WorkforceError) return failure(`${error.message} Nothing was saved.`);
      throw error;
    }
  },
});

export const modeTools: ToolDef[] = [listModes, saveMode];
