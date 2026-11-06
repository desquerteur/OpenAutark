// OrgService: agents and the chain of command (the human is CEO; agents report to a manager agent or directly to the
// human), plus the space methods (delegated to org/spaces.ts).
// Owns: agent CRUD (hiring: org/hire.ts; an edit's checks: org/patch.ts), archive – with an optional successor that
// takes over the archived agent's role, mode, place (manager, space, team), its reports and (tasks/owners.ts) its open
// tasks; an agent may archive itself; at least one agent stays – and restore (O6: back under the old manager while
// active, else the person – org/restore.ts), the seed Manager, org tree, management rights, live status, and the
// avatar image file ids agents use (references for blob clean-up – org/avatar-files.ts).
// Wave 3: the agent's SYSTEM.md (agent-core/service.ts) is written before an edit that changes the
// instructions is saved, and a hire gets its folder (setCoreFiles; absent in tests = DB only).
// Emits 'agent.upserted', 'agent.removed', 'agent.activity' ('space.upserted' via spaces.ts).
// Never: runs agents, or gives the seed Manager a space – it spans all areas; spaces appear when the first agent of an
// area is hired.

import type { Bus } from '../bus.ts';
import type { Clock, Logger, OrgService } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { Agent, AgentTemplate, OrgNode, Space } from '../../shared/model/org.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import { AgentRepo } from '../store/agents.ts';
import { avatarFiles } from './avatar-files.ts';
import { hiredAgent, type CreateInput } from './hire.ts';
import { patchedAgent, STATUSES } from './patch.ts';
import { restoredAgent } from './restore.ts';
import { loadTemplates } from './templates.ts';
import { Spaces } from './spaces.ts';
import { buildTree } from './tree.ts';
import { cleanText } from './validate.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { activePerson, personManagerId } from '../people/repo.ts';
import { reportsUpTo } from '../people/manager.ts';
import { rememberAgentDefault } from './prompt-updates.ts';

export interface OrgDeps {
  db: Db;
  bus: Bus;
  clock: Clock;
  templatesDir: string; // <resources>/agents
  /** Live activity source (the dispatcher). Default: derived from agents with status 'working'. */
  activity?: () => AgentActivity[];
  /**
   * B-044/B-047: the standard SYSTEM.md above every new agent's instructions (org/hire.ts; compose/services.ts renders
   * prompts/agent-default.md with the person's name plus `values`: the hire's creator and role).
   */
  standingRules?: (values?: Readonly<Record<string, string>>) => string | undefined;
  /** The unrendered standard a hire starts with, remembered for future app updates. */
  standingTemplate?: () => string;
  /** B-047: where a hire reports what it had to leave out (absent: nowhere). */
  log?: Pick<Logger, 'warn'>;
  /** The person's company name (settings.json profile.company) – the company space's name; absent: "Company". */
  companyName?: () => string | undefined;
}

const MAX_AGENTS = 300;

/** Who changes an agent ('human' or an agent id, its run and reason) – callers pass it; nothing records it any more. */
export interface ChangeBy {
  by: string;
  runId?: string;
  reason?: string;
  /** Part of a hire (copying skills, model, avatar after create), not an edit. */
  hire?: boolean;
}

/** archive(): `successorId` – the agent that takes over the archived one's role, place, reports and open tasks. */
export interface ArchiveOptions extends Partial<ChangeBy> {
  successorId?: string;
}

declare module '../contracts.ts' {
  interface OrgService {
    update(id: string, patch: Partial<Agent>, by?: ChangeBy): Agent;
    archive(id: string, options?: ArchiveOptions): void;
    restore(id: string, by?: ChangeBy): Agent;
  }
}

/** Wave 3: the agent core folder (agent-core/service.ts) as the org sees it. */
export interface CoreFiles {
  /** Before an edit is saved; throws to refuse it (SYSTEM.md not writable, changed outside meanwhile). */
  beforeSave(before: Agent, next: Agent): void;
  /** After a hire was saved (never throws). */
  created(agent: Agent): void;
}

export class Org implements OrgService {
  private readonly deps: OrgDeps;
  private readonly agents: AgentRepo;
  private readonly spaceBook: Spaces;
  private templateCache: AgentTemplate[] | undefined;
  private coreFiles: CoreFiles | undefined;

  constructor(deps: OrgDeps) {
    this.deps = deps;
    this.agents = new AgentRepo(deps.db);
    this.spaceBook = new Spaces(deps);
  }

  /** Wave 3: SYSTEM.md is the agents' instructions (compose/agent-core.ts). */
  setCoreFiles(files: CoreFiles | undefined): void {
    this.coreFiles = files;
  }

  /** Lets the composition root plug in the dispatcher after both exist. */
  setActivitySource(source: () => AgentActivity[]): void {
    this.deps.activity = source;
  }

  // ---------------------------------------------------------------- spaces (org/spaces.ts)

  spaces(): Space[] {
    return this.spaceBook.list();
  }

  saveSpace(input: Partial<Space> & { name: string }): Space {
    return this.spaceBook.save(input);
  }

  archiveSpace(id: string): void {
    this.spaceBook.archive(id);
  }

  // ---------------------------------------------------------------- agents

  list(options: { includeArchived?: boolean } = {}): Agent[] {
    return this.agents.list(options.includeArchived ?? false);
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  require(id: string): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new WorkforceError('not_found', 'This agent no longer exists.', { details: { id } });
    return agent;
  }

  templates(): AgentTemplate[] {
    this.templateCache ??= loadTemplates(this.deps.templatesDir);
    return this.templateCache.map((template) => structuredClone(template));
  }

  template(key: string): AgentTemplate | undefined {
    return this.templates().find((template) => template.key === key);
  }

  create(input: CreateInput): Agent {
    const agent = hiredAgent(input, {
      template: (key) => this.template(key),
      checkRoom: () => this.checkRoom(),
      requireActive: (agentId) => this.requireActive(agentId),
      nameTaken: (name) => this.nameTaken(name),
      uniqueName: (base) => this.uniqueName(base),
      space: (spaceId) => this.spaceBook.get(spaceId),
      spaceForKind: (kind, near) => this.spaceBook.forKind(kind, near),
      now: () => this.deps.clock.now(),
      standingRules: (values) => this.deps.standingRules?.(values),
      warn: (message, details) => this.deps.log?.warn(message, details),
    });
    this.deps.db.tx(() => {
      this.agents.save(agent);
      const standard = this.deps.standingTemplate?.();
      if (standard) rememberAgentDefault(this.deps.db, agent.id, standard, agent.instructions, this.deps.clock.now());
    });
    const saved = this.require(agent.id);
    this.coreFiles?.created(saved);
    this.deps.bus.emit('agent.upserted', saved);
    return saved;
  }

  update(id: string, patch: Partial<Agent>, _by?: ChangeBy): Agent {
    return this.edit(this.require(id), patch);
  }

  /**
   * Archives an agent (itself too). Its reports move to the successor when one is named (else up to its manager or
   * the person); the successor takes the archived agent's role, mode, manager, space and team, and the archived row
   * points at it as its manager, so its open tasks move there (tasks/owners.ts handOver). At least one agent stays.
   */
  archive(id: string, options: ArchiveOptions = {}): void {
    const agent = this.require(id);
    if (agent.archivedAt) return;
    if (this.agents.list().length <= 1) throw new WorkforceError('conflict', 'Keep at least one agent.');
    const successor = options.successorId ? this.requireActive(options.successorId) : undefined;
    if (successor?.id === id) throw new WorkforceError('bad_request', 'The successor must be another agent.');
    const now = this.deps.clock.now();
    const moved = this.agents.reports(id).filter((report) => report.id !== successor?.id);
    const archived: Agent = { ...agent, ...(successor ? { managerId: successor.id } : {}), archivedAt: now, status: 'idle', statusNote: undefined, updatedAt: now };
    // A successor from above (one of its managers) only takes the reports and the work; anyone else steps into its place.
    const above = successor !== undefined && this.managers(id).some((boss) => boss.id === successor.id);
    this.deps.db.tx(() => {
      if (successor && !above) {
        const { managerId, spaceId, team } = agent;
        this.agents.save({ ...successor, role: agent.role, mode: agent.mode, managerId, spaceId, team, updatedAt: now });
      }
      // Reports move to the successor, else up to the archived agent's manager (or the human) – never orphaned.
      for (const report of moved) this.agents.save({ ...report, managerId: successor?.id ?? agent.managerId, updatedAt: now });
      this.agents.save(archived);
    });
    for (const report of moved) this.deps.bus.emit('agent.upserted', this.require(report.id));
    if (successor) this.deps.bus.emit('agent.upserted', this.require(successor.id));
    this.deps.bus.emit('agent.upserted', this.require(id));
    // The task service listens: open tasks move to the successor / the manager chain (tasks/owners.ts).
    this.deps.bus.emit('agent.removed', { id });
    this.emitActivity();
  }

  /**
   * Brings an archived agent back (idempotent for an active one): under its old manager while that
   * one is active, else under the person; its space while active; its name unless another active
   * agent has it now (then "Name 2"). Its former reports stay where they are.
   */
  restore(id: string, _by?: ChangeBy): Agent {
    const agent = this.require(id);
    if (!agent.archivedAt) return agent;
    this.checkRoom();
    const manager = agent.managerId ? this.agents.get(agent.managerId) : undefined;
    const space = agent.spaceId ? this.spaceBook.get(agent.spaceId) : undefined;
    const name = this.nameTaken(agent.name, id) ? this.uniqueName(agent.name) : agent.name;
    const next = restoredAgent(agent, { manager, space, name, now: this.deps.clock.now() });
    this.agents.save(next);
    const saved = this.require(id);
    this.deps.bus.emit('agent.upserted', saved);
    return saved;
  }

  /** File ids of image avatars (archived agents too: they can be restored) – references for blob clean-up. */
  avatarFileIds(): string[] {
    return avatarFiles(this.agents.list(true));
  }

  /**
   * First run: exactly one agent, the person's personal manager (B-078 D15: their right hand and head of staff). It
   * spans all areas, so no space. "Manager" is its name until it picks a human first name itself (B-047 D9,
   * resources/agents/manager.md; agents.update).
   */
  ensureSeed(): Agent | undefined {
    if (this.agents.count() > 0) return undefined;
    const template = this.template('manager');
    return this.create({
      template: template ? 'manager' : undefined,
      name: 'Manager',
      role: 'Personal manager',
      mode: template ? undefined : 'manager',
      createdBy: HUMAN_ID,
    });
  }

  tree(): OrgNode[] {
    return buildTree(this.agents.list());
  }

  managers(id: string): Agent[] {
    const chain: Agent[] = [];
    const seen = new Set([id]);
    let current = this.agents.get(id);
    while (current?.managerId && !seen.has(current.managerId)) {
      seen.add(current.managerId);
      const boss = this.agents.get(current.managerId);
      if (!boss || boss.archivedAt) break;
      chain.push(boss);
      current = boss;
    }
    return chain;
  }

  /** Human manages everyone; an agent manages its direct and indirect reports (not itself). */
  canManage(viewerId: string, targetId: string): boolean {
    const target = this.agents.get(targetId);
    if (!target) return false;
    if (viewerId === HUMAN_ID) return true;
    if (viewerId === targetId) return false;
    return this.managers(targetId).some((boss) => boss.id === viewerId);
  }

  setStatus(id: string, status: Agent['status'], note?: string): void {
    if (!STATUSES.includes(status)) throw new WorkforceError('bad_request', 'Invalid agent status.');
    const clean = note === undefined ? undefined : cleanText(note, 'status', 200).slice(0, 200) || undefined;
    if (!this.agents.setStatus(id, status, clean, this.deps.clock.now())) throw new WorkforceError('not_found', 'This agent no longer exists.');
    this.deps.bus.emit('agent.upserted', this.require(id));
    this.emitActivity();
  }

  // ---------------------------------------------------------------- helpers

  /** Validates and saves an edit (org/patch.ts). */
  private edit(agent: Agent, patch: Partial<Agent>): Agent {
    const id = agent.id;
    const next = patchedAgent(agent, patch, {
      nameTaken: (name) => this.nameTaken(name, id),
      spaceExists: (spaceId) => this.spaceBook.get(spaceId) !== undefined,
      checkManager: (managerId) => {
        // F-52: a person of the organisation may manage an agent (one org chart; runtime/people).
        if (isPersonId(managerId)) {
          if (!activePerson(this.deps.db, managerId)) throw new WorkforceError('not_found', 'This person is no longer in the organisation.');
        } else {
          this.requireActive(managerId);
        }
        // No cycles: the new manager must not be the agent itself or one of its reports – across people and agents.
        const managerOf = (node: string) => (isPersonId(node) || node === HUMAN_ID ? personManagerId(this.deps.db, node) : this.agents.get(node)?.managerId);
        if (managerId === id || this.managers(managerId).some((boss) => boss.id === id) || reportsUpTo(managerOf, managerId, id)) {
          throw new WorkforceError('bad_request', 'An agent cannot report to itself or to one of its reports.');
        }
      },
    });
    next.updatedAt = this.deps.clock.now();
    this.coreFiles?.beforeSave(agent, next); // wave 3: SYSTEM.md first – a refused write saves nothing
    this.agents.save(next);
    const saved = this.require(id);
    this.deps.bus.emit('agent.upserted', saved);
    if (Object.hasOwn(patch, 'status') || Object.hasOwn(patch, 'statusNote')) this.emitActivity();
    return saved;
  }

  private checkRoom(): void {
    if (this.agents.list().length >= MAX_AGENTS) throw new WorkforceError('conflict', `An organization can have at most ${MAX_AGENTS} active agents.`);
  }

  private emitActivity(): void {
    const active = this.deps.activity
      ? this.deps.activity()
      : this.agents.list().filter((agent) => agent.status === 'working').map((agent) => ({
        agentId: agent.id, runId: '', note: agent.statusNote ?? '', startedAt: agent.updatedAt,
      }));
    this.deps.bus.emit('agent.activity', { active });
  }

  private requireActive(id: string): Agent {
    const agent = this.require(id);
    if (agent.archivedAt) throw new WorkforceError('conflict', 'This agent is archived.', { details: { id } });
    return agent;
  }

  private nameTaken(name: string, exceptId?: string): boolean {
    const lower = name.toLocaleLowerCase();
    return this.agents.list().some((agent) => agent.id !== exceptId && agent.name.toLocaleLowerCase() === lower);
  }

  private uniqueName(base: string): string {
    for (let index = 2; index < 1000; index++) {
      const candidate = `${base} ${index}`;
      if (!this.nameTaken(candidate)) return candidate;
    }
    throw new WorkforceError('conflict', 'Choose a different agent name.');
  }
}
