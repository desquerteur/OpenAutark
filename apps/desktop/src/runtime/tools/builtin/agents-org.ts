// Org-building tools, open to every agent: agents.templates (what can be hired), agents.create (one hire or a team of
// up to six, results per hire) and agents.archive (any agent, itself included; with `successorId` the successor takes
// over the role, place, reports and open tasks – org/service.ts). So a manager can hire a successor, hand over and
// archive itself; at least one agent stays.
// Where a hire lands is placement(); OrgService decides the chain of command (a template that
// reports to the human – the secretary – stays outside every branch).
// The summary names every hire with its role, a changed mode and "own instructions"; B-059: a hire without a name
// reads "a new <template> (…, gets a first name)" – the name is picked only when the hire runs.
// B-047 (D9): a hire's name is a person's first name (a role, template or numbered label is refused per hire;
// without a name OrgService picks a free first name), the job goes in role. Every hire starts from the team's
// standard SYSTEM.md (org/hire.ts, prompts/agent-default.md – B-076: the team's "How I work", then the hire's role and
// "What I have here", nothing enforces it). B-078 (D15): the creator's `instructions` are the new agent's "who you are";
// the result returns the SYSTEM.md path and the hire's own part with one line: that part is the new agent's own from
// here, and I start them with a first line or task. A hire from the `head` template stands beside me – it reports to
// the person unless managerId names someone.
// `device` gives a hire its home PC (devices.list; default this PC) – like agents.update's device.
// Owns: those three tools. Never: hires a second secretary (the existing one is returned) or archives the last
// active agent.

import path from 'node:path';
import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import { areaKind } from '../../org/spaces.ts';
import { personNameProblem } from '../../org/first-names.ts';
import { ownPart } from '../../org/system-parts.ts';
import { rulesInForce } from './agents.ts';
import { SYSTEM_FILE } from '../../../shared/model/agent-core.ts';
import type { Agent } from '../../../shared/model/org.ts';
import '../../contracts/agent-core.ts';
import { resolveDevice } from '../registry.ts';
import { announceHire } from './hire-notice.ts'; // AF-017
import { clip, defineTool } from './util.ts';

export const MAX_HIRES = 6;

type Hire = { name?: string; template?: string; role?: string; instructions?: string; mode?: string; managerId?: string; spaceId?: string; device?: string };
type CreateArgs = Hire & { agents?: Hire[] };
type SystemFile = { path?: string; text: string; next?: string };
type HireResult = { ok: true; agentId: string; name: string; role: string; spaceId?: string; space?: string; worksOn?: string; existing?: true; note?: string; system?: SystemFile } | { ok: false; hire: string; error: string };

/** The SYSTEM.md text a hire result shows at most (a team call returns up to six). */
const SYSTEM_TEXT_MAX = 6000;
/** B-078: templates whose hires stand beside me and report to the person (a department head). */
const BESIDE: ReadonlySet<string> = new Set(['head']);

/** B-078: the line a hire result carries – the own part is the new agent's, and how I start them. */
export function startLine(name: string): string {
  return `This is ${name}'s own part of their SYSTEM.md, with the "who you are" I gave under "## My role"; the team's standard "How I work" stands above it. From here ${name} grows it themselves. I start ${name} now: a first line in our 1:1 (chat.direct) with what I found – the colleagues, folders and accounts of the work, an earlier piece that shows what good looks like – or a first real task there (tasks.create with assignee = ${name}'s agentId and chatId = our 1:1).`;
}

const HIRE_PROPS = {
  name: { type: 'string', maxLength: 60 }, // a person's first name: the description says so once for both levels
  template: { type: 'string' }, role: { type: 'string', maxLength: 120 },
  instructions: { type: 'string', maxLength: 8000 }, mode: { type: 'string' }, managerId: { type: 'string' }, spaceId: { type: 'string' },
  device: { type: 'string', minLength: 1, maxLength: 120 },
} as const;

/**
 * Where a hire lands: an explicit active space; else the template's area – the new manager's
 * space when it is of that kind (a second company keeps its own hires), otherwise the first
 * active space of that kind (created on demand; OrgService.create applies the same area rule);
 * without an area, the new manager's space (only this tool – a human hire without a space and
 * template stays space-less).
 */
function placement(args: Hire, ctx: ToolContext): { spaceId?: string; label?: string; error?: string } {
  const org = ctx.services.org;
  const spaces = org.spaces();
  const boss = org.get(args.managerId ?? ctx.agent.id);
  const home = spaces.find((space) => space.id === boss?.spaceId);
  const kind = areaKind(args.template ? org.templates().find((template) => template.key === args.template) : undefined);
  if (args.spaceId) {
    const space = spaces.find((entry) => entry.id === args.spaceId);
    if (!space) return { error: 'This space does not exist or is archived (spaces.list shows the active ones).' };
    return { spaceId: space.id, label: space.name };
  }
  if (!kind) return home ? { spaceId: home.id, label: home.name } : {};
  if (home?.kind === kind) return { spaceId: home.id, label: home.name };
  const area = spaces.find((space) => space.kind === kind);
  return { label: area?.name ?? (kind === 'custom' ? undefined : `a new ${kind} space`) };
}

/** The hires of a call: the `agents` list, else the single hire in the top-level fields. */
function hiresOf(args: CreateArgs): Hire[] {
  if (args.agents?.length) return args.agents;
  const { agents: _list, ...single } = args;
  return [single];
}

/**
 * "Vic (Video editor, mode video, own instructions) into Company" – what the call's summary shows of one
 * hire. The person's own assistant keeps her template's role, mode and instructions (OrgService).
 * B-059: without a name the hire gets a free first name only when it runs (org/hire.ts, seeded by the new id) –
 * "a new Researcher (gets a first name)", so the person never matches the card to a template name.
 */
function hireLabel(hire: Hire, ctx: ToolContext): string {
  const template = hire.template ? ctx.services.org.templates().find((entry) => entry.key === hire.template) : undefined;
  const own = template?.reportsTo === 'human' ? undefined : hire;
  const kind = template?.name ?? 'agent';
  const who = hire.name ?? `a new ${kind}`;
  const role = own?.role ?? template?.role;
  const extras = [
    role && role !== (hire.name ?? kind) ? role : '',
    hire.name === undefined ? 'gets a first name' : '',
    own?.mode && own.mode !== template?.mode ? `mode ${own.mode}` : '',
    own?.instructions?.trim() ? 'own instructions' : '',
  ].filter(Boolean);
  const into = placement(hire, ctx).label;
  return `${who}${extras.length ? ` (${extras.join(', ')})` : ''}${into ? ` into ${into}` : ''}`;
}

/** Words that make a name a role: every template's key, name and role, every mode's key and name. */
function roleWords(ctx: ToolContext): string[] {
  const words = ctx.services.org.templates().flatMap((template) => [template.key, template.name, template.role ?? '']);
  try { words.push(...ctx.services.modes.list().flatMap((mode) => [mode.key, mode.name])); } catch { /* no modes service: templates only */ }
  return words;
}

/** B-047: the new agent's SYSTEM.md (path when the agent core is wired) and how I start them (B-078). */
function systemFile(agent: Agent, ctx: ToolContext): SystemFile {
  let folder: string | undefined;
  try { folder = ctx.services.agentCore?.folder(agent.id); } catch { folder = undefined; }
  const own = ownPart(agent.instructions, rulesInForce(ctx)); // B-076: the hire's own part; the standard above it stays as it is
  const text = own.length > SYSTEM_TEXT_MAX ? `${own.slice(0, SYSTEM_TEXT_MAX - 1)}…` : own;
  return { ...(folder ? { path: path.join(folder, SYSTEM_FILE) } : {}), text, next: startLine(agent.name) };
}

/** One hire; a refused one is a result, not an error, so the others still happen. */
function hire(args: Hire, ctx: ToolContext): HireResult {
  const org = ctx.services.org;
  const label = args.name ?? args.template ?? args.role ?? 'agent';
  const problem = args.name === undefined ? undefined : personNameProblem(args.name, roleWords(ctx));
  if (problem) return { ok: false, hire: label, error: `"${clip(args.name ?? '', 60)}" is not a person's first name: ${problem}. Give the hire a first name such as "Mara".` };
  const template = args.template ? org.templates().find((entry) => entry.key === args.template) : undefined;
  if (template?.reportsTo === 'human') {
    // Agents never hire a second secretary: the one there is works for the person.
    const existing = org.list().find((agent) => agent.template === template.key);
    if (existing) {
      return { ok: true, agentId: existing.id, name: existing.name, role: existing.role, spaceId: existing.spaceId, existing: true, note: `${existing.name} already works for the person; I talk to them instead of hiring another.` };
    }
  }
  const managerId = args.managerId ?? (template && BESIDE.has(template.key) ? '' : ctx.agent.id); // '' = reports to the person
  const place = placement(args, ctx);
  if (place.error) return { ok: false, hire: label, error: place.error };
  const { device, ...fields } = args;
  const pc = device === undefined ? undefined : resolveDevice(ctx.services, device);
  if (pc && 'error' in pc) return { ok: false, hire: label, error: pc.error };
  try {
    let agent = org.create({ ...fields, managerId, spaceId: place.spaceId, createdBy: ctx.agent.id });
    if (pc && !pc.self) agent = org.update(agent.id, { deviceId: pc.id }, { by: ctx.agent.id, runId: ctx.runId, reason: 'home device' }); // this PC is the default (no deviceId)
    const space = agent.spaceId ? org.spaces().find((entry) => entry.id === agent.spaceId)?.name : undefined;
    const ignored = template?.reportsTo === 'human' && (args.role || args.mode || args.instructions);
    const note = ignored ? `${agent.name} works for the person, so role, mode and instructions come from the template. I say anything else in a chat.` : undefined;
    const system = systemFile(agent, ctx);
    announceHire(ctx, agent, space); // AF-017: the card in this chat and the person's notification
    return { ok: true, agentId: agent.id, name: agent.name, role: agent.role, spaceId: agent.spaceId, space, ...(pc ? { worksOn: pc.name } : {}), ...(note ? { note } : {}), system };
  } catch (error) {
    return { ok: false, hire: label, error: error instanceof Error ? error.message : String(error) };
  }
}

const listTemplates = defineTool<Record<string, never>>({
  name: 'agents.templates',
  description: 'The agent templates I can hire from, and whether a hire reports to the person instead of me.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  category: 'read',
  describe: () => ({ summary: 'List agent templates', reversible: true, external: false }),
  async run(_args, ctx) {
    return json(ctx.services.org.templates().map((template) => ({
      key: template.key, name: template.name, role: template.role, description: template.description, mode: template.mode,
      area: template.spaceKind, reportsTo: template.reportsTo,
    })));
  },
});

const createAgent = defineTool<CreateArgs>({
  name: 'agents.create',
  description: 'Hire one agent (from a template or a role) or a team in "agents"; each reports to me unless managerId is given (a head from template "head" stands beside me and reports to the person; managerId "" = the person). name: a person\'s first name; the job goes in role. instructions: who they are, in a few lines – they go under "## My role" in the team\'s standard SYSTEM.md, and from there the agent grows it. Without spaceId it lands in the template\'s area or its manager\'s space; into a private space only from inside it. device: its home PC – its turns, terminal and computer use run there, and I reach it in the shared chats (devices.list; default this PC).',
  inputSchema: {
    type: 'object',
    properties: {
      ...HIRE_PROPS,
      agents: { type: 'array', items: { type: 'object', properties: HIRE_PROPS, additionalProperties: false }, minItems: 1, maxItems: MAX_HIRES },
    },
    additionalProperties: false,
  },
  category: 'agents',
  describe: (args, ctx) => {
    const hires = hiresOf(args);
    const labels = hires.map((item) => hireLabel(item, ctx));
    const summary = hires.length === 1 ? `Hire ${hires[0].name === undefined ? '' : 'agent '}${labels[0]}` : `Hire ${hires.length} agents: ${labels.join(', ')}`;
    return { summary: clip(summary, 1500), reversible: true, external: false };
  },
  async run(args, ctx) {
    const { agents: list, ...single } = args;
    if (list?.length && Object.values(single).some((value) => value !== undefined)) {
      return failure('Give either one hire in the top-level fields or a team in "agents", not both.');
    }
    const results = hiresOf(args).map((item) => hire(item, ctx));
    if (!list?.length) {
      const [only] = results;
      return only.ok ? json({ ...only }) : failure(only.error);
    }
    return json({ ok: results.every((result) => result.ok), results });
  },
});

const archiveAgent = defineTool<{ agentId?: string; successorId?: string; reason: string }>({
  name: 'agents.archive',
  description: 'Archive an agent, or myself. successorId: the colleague who takes over – its role, place in the org, reports and open tasks (hire one first if needed); without it the reports move up to the manager and the open tasks to the next manager. Give the reason.',
  inputSchema: {
    type: 'object',
    properties: { agentId: { type: 'string' }, successorId: { type: 'string' }, reason: { type: 'string', minLength: 3, maxLength: 300 } },
    required: ['reason'], additionalProperties: false,
  },
  category: 'agents',
  describe: (args, ctx) => {
    const id = args.agentId ?? ctx.agent.id;
    const name = ctx.services.org.get(id)?.name ?? id;
    const successor = args.successorId ? ` (successor ${ctx.services.org.get(args.successorId)?.name ?? args.successorId})` : '';
    return { summary: `Archive agent ${name}${successor}: ${clip(args.reason, 160)}`, resource: id, reversible: true, external: false };
  },
  async run(args, ctx) {
    const org = ctx.services.org;
    const targetId = args.agentId ?? ctx.agent.id;
    const target = org.get(targetId);
    if (!target || target.archivedAt) return failure('Agent not found.');
    const active = org.list();
    if (active.length <= 1) return failure('The last agent stays.');
    const successor = args.successorId ? org.get(args.successorId) : undefined;
    if (args.successorId && (!successor || successor.archivedAt)) return failure('Successor not found.');
    const reports = active.filter((agent) => agent.managerId === targetId && agent.id !== successor?.id).map((agent) => agent.name);
    org.archive(targetId, { by: ctx.agent.id, runId: ctx.runId, reason: args.reason, ...(successor ? { successorId: successor.id } : {}) });
    return json({ ok: true, agentId: targetId, ...(successor ? { successor: successor.name, reportsMovedTo: successor.name } : {}), reportsMoved: reports, reason: args.reason });
  },
});

export const agentOrgTools: ToolDef[] = [listTemplates, createAgent, archiveAgent];
