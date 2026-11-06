// F-51: creating a team from a proposal (a team pattern, patterns/library.ts). One transaction: every included agent
// with its reporting line inside the proposal (roots report to the chosen manager, default the first manager; 'human'
// = to the person), a template when one is named, only skills and modes this app has, and task definitions as the
// agent's own untrusted procedure notes. All or nothing – also for listeners: agents announced inside a transaction
// that rolled back get 'agent.removed'.
// Owns: proposal validation (shape, limits, links, cycles) and that transaction.
// Never: trusts proposal text as an instruction to the runtime.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { Agent } from '../../shared/model/org.ts';
import { MAX_PROPOSAL_AGENTS, type ProposedAgent, type ProposedTask } from '../../shared/model/team-start.ts';
import type { RuntimeServices } from '../contracts.ts';
import { defaultManager, fit, freeName } from '../portability/agents.ts';
import { cleanName } from './validate.ts';
import '../contracts/team-start.ts';

const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const TASKS_MAX = 20;
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function bad(param: string, message: string): never {
  throw new WorkforceError('bad_request', message, { details: { param } });
}

function str(value: unknown, param: string, max: number, required = false): string {
  if (value === undefined || value === null) { if (required) bad(param, `${param} is required.`); return ''; }
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) bad(param, `${param} must be text of at most ${max} characters.`);
  return value;
}

function tasksOf(value: unknown, param: string): ProposedTask[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > TASKS_MAX) bad(param, `At most ${TASKS_MAX} tasks per agent.`);
  return value.map((task, index) => {
    if (!isPlain(task)) bad(`${param}.${index}`, 'A task has a title and a body.');
    return { title: str(task.title, `${param}.${index}.title`, 300, true), body: str(task.body, `${param}.${index}.body`, 4000) };
  });
}

/** The proposal as sent (untrusted): shape, sizes, unique keys, links to known keys. */
export function cleanProposal(value: unknown): ProposedAgent[] {
  if (!Array.isArray(value) || !value.length) bad('agents', 'Send at least one proposed agent.');
  if (value.length > MAX_PROPOSAL_AGENTS) bad('agents', `A proposal has at most ${MAX_PROPOSAL_AGENTS} agents.`);
  const out: ProposedAgent[] = value.map((item, index) => {
    const at = `agents.${index}`;
    if (!isPlain(item)) bad(at, 'Each proposed agent is an object.');
    const key = str(item.key, `${at}.key`, 40, true);
    if (!KEY.test(key)) bad(`${at}.key`, 'A key has letters, digits, - or _.');
    const skills = item.skills === undefined ? [] : item.skills;
    if (!Array.isArray(skills) || skills.length > 100 || skills.some((skill) => typeof skill !== 'string' || skill.length > 80)) bad(`${at}.skills`, 'Skills are names.');
    const reportsTo = item.reportsTo === undefined || item.reportsTo === null ? undefined : str(item.reportsTo, `${at}.reportsTo`, 40);
    const companionOf = item.companionOf === undefined || item.companionOf === null ? undefined : str(item.companionOf, `${at}.companionOf`, 40);
    const template = item.template === undefined || item.template === null ? undefined : str(item.template, `${at}.template`, 64);
    const tasks = tasksOf(item.tasks, `${at}.tasks`);
    return {
      key, name: str(item.name, `${at}.name`, 80, true), role: str(item.role, `${at}.role`, 80), instructions: str(item.instructions, `${at}.instructions`, 20_000),
      mode: str(item.mode ?? 'general', `${at}.mode`, 64), skills: skills as string[], include: item.include !== false,
      ...(template ? { template } : {}), ...(reportsTo ? { reportsTo } : {}), ...(companionOf ? { companionOf } : {}), ...(tasks ? { tasks } : {}),
    };
  });
  const keys = new Set<string>();
  for (const agent of out) {
    if (keys.has(agent.key)) bad('agents', `The key ${agent.key} is used twice.`);
    keys.add(agent.key);
  }
  for (const agent of out) if (agent.reportsTo && !keys.has(agent.reportsTo)) bad('agents', `${agent.name} reports to an unknown agent.`);
  for (const agent of out) if (agent.companionOf && (!keys.has(agent.companionOf) || agent.companionOf === agent.key)) bad('agents', `${agent.name} accompanies an unknown agent.`);
  if (!out.some((agent) => agent.include)) bad('agents', 'Choose at least one agent.');
  return out;
}

/** Included agents, managers before their reports; a link to a left-out agent goes to the root. Throws on a cycle. */
export function creationOrder(agents: readonly ProposedAgent[]): ProposedAgent[] {
  const included = new Map(agents.filter((agent) => agent.include).map((agent) => [agent.key, agent]));
  const parent = (agent: ProposedAgent) => (agent.reportsTo && included.has(agent.reportsTo) ? agent.reportsTo : undefined);
  const out: ProposedAgent[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (agent: ProposedAgent) => {
    const seen = state.get(agent.key);
    if (seen === 'done') return;
    if (seen === 'visiting') bad('agents', `The reporting lines around ${agent.name} form a circle.`);
    state.set(agent.key, 'visiting');
    const up = parent(agent);
    if (up) visit(included.get(up)!);
    state.set(agent.key, 'done');
    out.push(agent);
  };
  for (const agent of included.values()) visit(agent);
  return out;
}

function modeKey(s: RuntimeServices, mode: string): string {
  try { return s.modes.get(mode).key; } catch { return 'general'; }
}

export interface CreateTeamOptions {
  /** An active agent id, 'human' (report to the person) or absent (the first manager, else the person). */
  managerId?: string;
  /** Where it came from, for the notes' source ('pattern:<id>'). */
  ref: string;
}

/** Creates the included agents of `agents` (cleanProposal first); returns them in creation order. */
export function createTeam(s: RuntimeServices, agents: readonly ProposedAgent[], options: CreateTeamOptions): Agent[] {
  const order = creationOrder(agents);
  let root: string | undefined;
  if (options.managerId === HUMAN_ID) root = undefined;
  else if (options.managerId) {
    const manager = s.org.get(options.managerId);
    if (!manager || manager.archivedAt) throw new WorkforceError('not_found', 'The chosen manager is not on the team.');
    root = manager.id;
  } else root = defaultManager(s);
  const templates = new Set(s.org.templates().map((template) => template.key));
  const known = new Set((s.skills?.list() ?? []).map((skill) => skill.name));
  // Org emits agent.upserted inside the transaction: remember them to take them back on a rollback.
  const announced = new Set<string>();
  const off = s.bus.on('agent.upserted', (agent) => { announced.add(agent.id); });
  try {
    const created = s.db.tx(() => {
      const ids = new Map<string, string>();
      const out: Agent[] = [];
      for (const proposed of order) {
        const managerId = proposed.reportsTo && ids.has(proposed.reportsTo) ? ids.get(proposed.reportsTo) : root;
        const wanted = cleanName(proposed.name);
        let agent: Agent;
        {
          const name = freeName(s, (index) => (index === 1 ? wanted : fit(wanted, ` ${index}`)));
          const template = proposed.template && templates.has(proposed.template) ? proposed.template : undefined;
          const made = s.org.create({
            name, ...(template ? { template } : {}), role: proposed.role.trim() || wanted, instructions: proposed.instructions,
            mode: modeKey(s, proposed.mode), ...(managerId ? { managerId } : {}), createdBy: HUMAN_ID,
          });
          const skills = proposed.skills.filter((skill) => known.has(skill));
          agent = skills.length ? s.org.update(made.id, { skills: [...new Set([...made.skills, ...skills])] }, { by: HUMAN_ID, hire: true }) : made;
        }
        for (const task of proposed.tasks ?? []) {
          s.knowledge.save({
            scope: 'agent', scopeId: agent.id, kind: 'procedure', title: task.title, body: task.body, tags: ['imported-task'],
            confidence: 0.5, source: { kind: 'import', ref: options.ref, trusted: false }, createdBy: HUMAN_ID,
          });
        }
        ids.set(proposed.key, agent.id);
        out.push(agent);
      }
      return out;
    });
    s.log.info('team created from a proposal', { agents: created.length, ref: options.ref.slice(0, 80) });
    return created;
  } catch (error) {
    // Clients and listeners already heard of agents the rollback took back: no phantom agents until reload.
    for (const id of announced) if (!s.org.get(id)) s.bus.emit('agent.removed', { id });
    throw error;
  } finally {
    off();
  }
}
