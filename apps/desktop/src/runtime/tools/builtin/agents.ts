// Org tools: who is in the company, editing agents, delegation/handoff (hiring, templates and
// archiving: agents-org.ts).
// Owns: agents.list (each agent with its avatar kind and palette colour, B-044),
// agents.update (including the PC an agent works on, `device`, B-044 its home project – `home`, agent-home.ts –, who a report reports to, its space,
// its avatar colour, emoji or – B-044 – a portrait its own run made (rules: agent-avatar.ts), its speaking voice – MM3 – and a model pin checked against the
// catalog: exact id, bare provider model id or name, stored as the catalog id, a model several
// providers list as its available plan/local copy before an API key – RT4, resolved in agent-pin.ts), agents.delegate (to a colleague
// or a mode; B-050 group cost: the description says a colleague just written to needs no task for the same request,
// the result's note what the colleague already has from that chat – agents/handoff.ts), agents.handoff (a switch to a
// mode key passes modes/strategy.ts first – a hint when a colleague works in that mode; both descriptions carry the
// shared MODE_MOVES rule).
// Any agent updates any agent, itself included – hand-overs (managerId) too; OrgService refuses cycles.
// B-076: instructions without "# How I work" replace only the agent's own part of SYSTEM.md (org/system-parts.ts withOwnPart).
// B-078 (D15): SYSTEM.md is each agent's own – `instructions` are written for the calling agent itself; for another
// agent they are left out and the result says that I tell them in a chat (every other field stays open; the person
// edits everything in the app). A SYSTEM.md written here always keeps the team's standard head on top.
// Never: changes a photo the person chose or sets an image its own run did not make, points
// an agent at a revoked, unknown or non-PC device (resolveDevice decides, like for tool calls), or
// pin a model the catalog does not know or a specialist that cannot run an agent.

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import { resolveDevice } from '../registry.ts';
import type { Agent } from '../../../shared/model/org.ts';
import type { Effort } from '../../../shared/model/providers.ts';
import { delegate, handoff } from '../../agents/handoff.ts';
import { paletteIndex } from '../../org/avatar.ts';
import { hireValues, standingRuleValues, withStandardHead } from '../../org/hire.ts';
import { hasWorkStandard, withOwnPart } from '../../org/system-parts.ts';
import { renderTemplate, standardRuleValues } from '../../context/templates.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';

/** The longest SYSTEM.md an agent keeps (org/patch.ts cleanText). */
const MAX_SYSTEM = 20_000;

/** The rules in force (an own rules.md may head its "How I work" differently); undefined without the prompt service. */
export function rulesInForce(ctx: Pick<ToolContext, 'services'>): string | undefined {
  try { return ctx.services.prompts?.get('rules'); } catch { return undefined; }
}

/** B-078: the team's standard SYSTEM.md rendered for this agent (as at its hire); undefined without the prompt service. */
export function standardFor(ctx: Pick<ToolContext, 'services'>, agent: Agent): string | undefined {
  try {
    const prompts = ctx.services.prompts;
    if (!prompts) return undefined;
    const creator = agent.createdBy === HUMAN_ID ? undefined : ctx.services.org.get(agent.createdBy);
    const values = { ...standardRuleValues(standingRuleValues(ctx.services.settings.get())), ...hireValues({ creator, role: agent.role, name: agent.name }) };
    return renderTemplate(prompts.standardTemplate(), values);
  } catch { return undefined; }
}

/** B-078: the SYSTEM.md `text` makes for `agent` – its own part replaced, the standard head kept or put back on top. */
export function ownSystem(ctx: Pick<ToolContext, 'services'>, agent: Agent, text: string): string {
  const rules = rulesInForce(ctx);
  const merged = withOwnPart(agent.instructions, text, rules);
  return hasWorkStandard(merged, rules) ? merged : withStandardHead(merged, standardFor(ctx, agent));
}

/** B-078: what agents.update says when I send another agent's instructions. */
export function notMineLine(name: string): string {
  return `SYSTEM.md is ${name}'s own – they write it themselves. I tell ${name} in a chat what I would change there (chat.direct, or the group we work in), and they take in what fits.`;
}
import { avatarPatch, portraitLine, type AvatarArgs } from './agent-avatar.ts';
import { HOME_ARG, HOME_HELP, applyHome, homeAction } from './agent-home.ts';
import { pinFor } from './agent-pin.ts';
import { clip, defineTool, internal } from './util.ts';
import { MODE_MOVES, checkModeSwitch } from '../../modes/strategy.ts';

const listAgents = defineTool<{ team?: string; includeArchived?: boolean }>({
  name: 'agents.list',
  description: 'List colleagues with id, name, role, team, manager, space (area), the PC they work on and current status.',
  inputSchema: { type: 'object', properties: { team: { type: 'string' }, includeArchived: { type: 'boolean' } }, additionalProperties: false },
  category: 'read',
  describe: () => internal('List agents'),
  async run(args, ctx) {
    const agents = ctx.services.org.list({ includeArchived: args.includeArchived }).filter((agent) => !args.team || agent.team === args.team);
    const spaceNames = new Map(ctx.services.org.spaces().map((space) => [space.id, space.name]));
    const local = agents.map((agent) => ({
      id: agent.id, name: agent.name, role: agent.role, team: agent.team, managerId: agent.managerId,
      spaceId: agent.spaceId, space: agent.spaceId ? spaceNames.get(agent.spaceId) : undefined,
      mode: agent.mode, status: agent.status, note: agent.statusNote, me: agent.id === ctx.agent.id || undefined,
      worksOn: agent.deviceId ? deviceName(ctx, agent.deviceId) : undefined,
      avatar: agent.avatar.kind, color: agent.avatar.color ?? paletteIndex(agent.id), // B-044: skill agent-portrait
    }));
    return json(local);
  },
});

type UpdateArgs = {
  agentId?: string; name?: string; role?: string; instructions?: string; mode?: string; skills?: string[]; team?: string; effort?: Effort; pin?: string; device?: string;
  managerId?: string; spaceId?: string; avatar?: AvatarArgs; voice?: string; home?: string; reason?: string;
};

/** Who an agent reports to and where it works. */
function placementPatch(args: UpdateArgs, ctx: ToolContext): Partial<Agent> | string {
  const org = ctx.services.org;
  const patch: Partial<Agent> = {};
  if (args.managerId !== undefined) patch.managerId = args.managerId || undefined; // '' = reports to the person; OrgService refuses cycles
  if (args.spaceId !== undefined) {
    const space = org.spaces().find((entry) => entry.id === args.spaceId);
    if (!space) return 'This space does not exist or is archived (spaces.list shows the active ones).';
    patch.spaceId = space.id;
  }
  return patch;
}

const updateAgent = defineTool<UpdateArgs>({
  name: 'agents.update',
  description: `Change an agent or myself. instructions: my own SYSTEM.md (each agent writes its own; to a colleague I say in a chat what I would change) – a text without "# How I work" replaces my own part from "## My role" on (role, what I have here) and the team's standard above stays; a text with "# How I work" replaces the whole file. mode: its default mode; pin: a model id ('' = automatic); device: the PC its computer, browser and phone tools default to (devices.list; 'this' = this PC); managerId: who it reports to ('' = the person) – hand my team over this way. avatar: emoji ('' = initials) or fileId of a portrait my own run made – a photo the person chose stays. voice: for media.speak ('' = default). ${HOME_HELP} reason: why (shown in the summary).`,
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 60 }, role: { type: 'string', maxLength: 120 },
      instructions: { type: 'string', maxLength: 20000 }, mode: { type: 'string' }, skills: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      team: { type: 'string' }, effort: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }, pin: { type: 'string' },
      device: { type: 'string', minLength: 1, maxLength: 120 }, managerId: { type: 'string' }, spaceId: { type: 'string' },
      avatar: { type: 'object', properties: { color: { type: 'integer', minimum: 0, maximum: 5 }, emoji: { type: 'string', maxLength: 16 }, fileId: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, additionalProperties: false },
      voice: { type: 'string', maxLength: 40 }, home: HOME_ARG, reason: { type: 'string', maxLength: 300 },
    },
    additionalProperties: false,
  },
  category: 'agents',
  describe: (args, ctx) => {
    const id = args.agentId ?? ctx.agent.id;
    const reason = args.reason?.trim();
    const name = ctx.services.org.get(id)?.name ?? id;
    const home = args.home === undefined ? undefined : homeAction(ctx, args.home);
    const parts = [
      args.mode === undefined ? '' : `mode ${args.mode}`,
      args.device === undefined ? '' : `works on ${worksOnLabel(ctx, args.device)}`,
      args.managerId === undefined ? '' : `reports to ${ctx.services.org.get(args.managerId)?.name ?? args.managerId}`,
      args.spaceId === undefined ? '' : `moves to ${ctx.services.org.spaces().find((space) => space.id === args.spaceId)?.name ?? args.spaceId}`,
      home?.part ?? '',
    ].filter(Boolean);
    return {
      summary: `Update agent ${name}${parts.length ? `: ${parts.join(', ')}` : ''}${reason ? ` (${clip(reason, 160)})` : ''}`,
      resource: home?.resource ?? id, reversible: true, external: false,
    };
  },
  async run(args, ctx) {
    const targetId = args.agentId ?? ctx.agent.id;
    const target = ctx.services.org.get(targetId);
    if (!target) return failure('Agent not found.');
    const patch: Partial<Agent> = {};
    if (args.device !== undefined) {
      const pc = resolveDevice(ctx.services, args.device);
      if ('error' in pc) return failure(pc.error);
      patch.deviceId = pc.self ? undefined : pc.id; // this PC is the default (no deviceId)
    }
    const placed = placementPatch(args, ctx);
    if (typeof placed === 'string') return failure(placed);
    Object.assign(patch, placed);
    if (args.avatar !== undefined) {
      const avatar = await avatarPatch(ctx, target, args.avatar); // B-059: may shrink an oversized PNG portrait
      if (typeof avatar === 'string') return failure(avatar);
      patch.avatar = avatar;
    }
    if (args.name !== undefined) patch.name = args.name;
    if (args.role !== undefined) patch.role = args.role;
    const notMine = args.instructions !== undefined && targetId !== ctx.agent.id ? notMineLine(target.name) : undefined;
    if (args.instructions !== undefined && !notMine) {
      const merged = ownSystem(ctx, target, args.instructions);
      // Review fix: the standard above the own part counts too – say what fits instead of a bare length error.
      if (merged.length > MAX_SYSTEM) {
        const standard = merged.length - args.instructions.trim().length;
        return failure(`SYSTEM.md would be ${merged.length} characters (at most ${MAX_SYSTEM}); the team's standard above my part takes about ${standard}, so my own part fits in about ${Math.max(0, MAX_SYSTEM - standard)}.`);
      }
      patch.instructions = merged;
    }
    if (args.mode !== undefined) patch.mode = args.mode;
    if (args.skills !== undefined) patch.skills = args.skills;
    if (args.team !== undefined) patch.team = args.team;
    if (args.voice !== undefined) patch.voice = args.voice.trim() || undefined; // OrgService validates the name
    let pin: { pin?: string; note?: string } | undefined;
    if (args.effort !== undefined || args.pin !== undefined) {
      const checked = args.pin === undefined ? undefined : await pinFor(ctx, args.pin);
      if (checked && 'error' in checked) return failure(checked.error);
      pin = checked;
      patch.modelPolicy = { ...target.modelPolicy, ...(args.effort ? { effort: args.effort } : {}), ...(pin ? { pin: pin.pin } : {}) };
    }
    if (notMine && !Object.keys(patch).length && args.home === undefined) return failure(`Nothing written. ${notMine}`);
    const updated = args.home !== undefined && !Object.keys(patch).length ? target : ctx.services.org.update(targetId, patch, { by: ctx.agent.id, runId: ctx.runId, reason: args.reason }); // B-044: home alone = agent.json only
    if (args.avatar?.fileId !== undefined && target.avatar.value !== updated.avatar.value) portraitLine(ctx, updated);
    return json({
      ok: true, agentId: updated.id, ...(args.device !== undefined ? { worksOn: deviceName(ctx, updated.deviceId) } : {}),
      ...(pin?.pin ? { pin: pin.pin } : {}), ...(pin?.note ? { note: pin.note } : {}), ...(notMine ? { instructions: `Left as it is. ${notMine}` } : {}),
      ...(args.home === undefined ? {} : applyHome(ctx, targetId, args.home)),
    });
  },
});

/** The PC name for a device id (undefined = this PC); unknown ids stay as they are. */
function deviceName(ctx: ToolContext, deviceId: string | undefined): string {
  try {
    const self = ctx.services.devices.self();
    if (!deviceId || deviceId === self.id) return self.name;
    return ctx.services.devices.list().find((device) => device.id === deviceId)?.name ?? deviceId;
  } catch {
    return deviceId ?? 'this PC';
  }
}

/** The summary text for a `device` value: the resolved PC's name, else the value as given. */
function worksOnLabel(ctx: ToolContext, value: string): string {
  const pc = resolveDevice(ctx.services, value);
  return 'error' in pc ? value.slice(0, 60) : pc.name;
}

const delegateTool = defineTool<{ to: string; title: string; goal?: string; notes?: string; next?: string; doneWhen?: string; constraints?: string[]; mode?: string; chatId?: string }>({
  name: 'agents.delegate',
  description: `Give a bounded subtask to a colleague (agent id; they join this run's chat if it has one – tasks need no chat) or a mode specialist of myself (mode key). They get a checkpoint, not my whole context. My task waits; the result wakes me when it is done or blocked, and I continue after the last open one. A colleague I just wrote to already has that request: no task needed. ${MODE_MOVES}`,
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' }, title: { type: 'string', minLength: 1, maxLength: 300 }, goal: { type: 'string' }, notes: { type: 'string' },
      next: { type: 'string' }, doneWhen: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, mode: { type: 'string' }, chatId: { type: 'string' },
    },
    required: ['to', 'title'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Delegate "${clip(args.title, 60)}" to ${args.to}`, args.to),
  async run(args, ctx) {
    return json({ ok: true, ...delegate(ctx, args) });
  },
});

const handoffTool = defineTool<{ to: string; next?: string; note?: string }>({
  name: 'agents.handoff',
  description: `Hand the current task to another agent or switch it to another mode (e.g. "computer"); the receiver continues from a checkpoint. ${MODE_MOVES}`,
  inputSchema: { type: 'object', properties: { to: { type: 'string' }, next: { type: 'string' }, note: { type: 'string' } }, required: ['to'], additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal(`Hand off task ${ctx.taskId ?? ''} to ${args.to}`, args.to),
  async run(args, ctx) {
    const modeOnly = !ctx.services.org.get(args.to) && ctx.services.modes.list().some((mode) => mode.key === args.to);
    const check = modeOnly ? checkModeSwitch(ctx.services, { agentId: ctx.agent.id, mode: ctx.mode, taskId: ctx.taskId, to: args.to }) : {};
    if (check.refuse) return failure(`${check.refuse} Nothing was changed.`);
    const result = handoff(ctx, args);
    return json({ ok: true, ...result, ...(check.advice ? { advice: check.advice } : {}) });
  },
});

export const agentTools: ToolDef[] = [listAgents, updateAgent, delegateTool, handoffTool];
