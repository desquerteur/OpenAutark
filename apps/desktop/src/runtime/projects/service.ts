// AF-018: the Projects tab's runtime – the folders the person codes in. A project is a folder the person added (kept in
// kv namespace 'projects', keyed by the project id) or one that follows from an agent's home project (AF-014). Each
// shows its git state (git-state.ts, cached up to 60 s per folder), the agents whose home it is and their chats as the
// project's sessions. A new session is a new chat with a project agent – hired from the folder (folder-agents) when
// the project has none – whose first message is the person's prompt, so the agent starts at once.
// Owns: the project records, ids, the list's order and the session start. Never: writes into a project folder, and
// "remove" never touches the folder, its agents or its chats.

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import type { Project, ProjectGit, ProjectSession, StartSessionInput } from '../../shared/model/project.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/agent-core.ts';
import '../contracts/access.ts';
import { KvRepo } from '../store/kv.ts';
import { gitOf } from '../git/exec.ts';
import { folderAbout } from '../folder-agents/analyze.ts';
import { createFolderAgent, resolveFolder } from '../folder-agents/create.ts';
import { readGit } from './git-state.ts';

export const PROJECTS_NS = 'projects';
export const GIT_CACHE_MS = 60_000;
const MAX_SESSIONS = 30;
const TITLE_MAX = 60;

/** What the kv row keeps of a project. `added: false` – a record only for a name or pin of an agent's project; `hidden` – taken off the list. */
export interface ProjectRecord { folder: string; name?: string; pinned?: boolean; addedAt: number; added: boolean; hidden?: boolean }

export type ProjectServices = Pick<RuntimeServices, 'org' | 'chats' | 'db' | 'clock' | 'bus' | 'paths' | 'log'> & Partial<Pick<RuntimeServices, 'agentCore' | 'access'>>;

const win = (): boolean => process.platform === 'win32';

/** The folder as compared: absolute, no trailing separator, case-folded on Windows. */
export function folderKey(folder: string): string {
  let dir = path.resolve(folder);
  while (dir.length > 1 && /[\\/]$/.test(dir) && !/^[A-Za-z]:[\\/]$/.test(dir)) dir = dir.slice(0, -1);
  return win() ? dir.toLowerCase() : dir;
}

/** Stable id of a folder: the same folder always gives the same id. */
export function projectId(folder: string): string {
  return `prj_${createHash('sha256').update(folderKey(folder)).digest('hex').slice(0, 16)}`;
}

/** A session title from the prompt's first line. */
export function titleFrom(prompt: string): string {
  const line = prompt.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

/** Pinned first, then the newest activity, then by name. */
export function sortProjects(projects: Project[]): Project[] {
  return projects.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActiveAt - a.lastActiveAt || a.name.localeCompare(b.name));
}

const isDir = (dir: string): boolean => { try { return statSync(dir).isDirectory(); } catch { return false; } };

export class ProjectService {
  private readonly s: ProjectServices;
  private readonly cache = new Map<string, { at: number; git?: ProjectGit; about: string }>();

  constructor(services: ProjectServices) { this.s = services; }

  private kv(): KvRepo { return new KvRepo(this.s.db); }
  private records(): ProjectRecord[] { return this.kv().list<ProjectRecord>(PROJECTS_NS).map((row) => row.value).filter((value) => value && typeof value.folder === 'string'); }
  private record(id: string): ProjectRecord | undefined { return this.kv().get<ProjectRecord>(PROJECTS_NS, id); }
  private save(id: string, record: ProjectRecord): void { this.kv().set(PROJECTS_NS, id, record, this.s.clock.now()); }

  /** Folder of each agent's home project (agents without one left out). */
  private homes(): Array<{ folder: string; agent: { id: string; name: string } }> {
    const homes = this.s.agentCore?.homes;
    if (!homes) return [];
    return this.s.org.list().flatMap((agent) => {
      let folder: string | undefined;
      try { folder = homes.stored(agent.id); } catch { folder = undefined; }
      return folder ? [{ folder, agent: { id: agent.id, name: agent.name } }] : [];
    });
  }

  private resolve(given: string): string {
    if (this.s.agentCore) return resolveFolder(this.s as Parameters<typeof resolveFolder>[0], given);
    const dir = given.trim() ? path.resolve(given.trim()) : '';
    if (!dir || !isDir(dir)) throw new WorkforceError('bad_request', 'folder: choose a folder.');
    return dir;
  }

  private async details(folder: string, fresh: boolean): Promise<{ git?: ProjectGit; about: string; missing: boolean }> {
    if (!isDir(folder)) { this.cache.delete(folderKey(folder)); return { about: '', missing: true }; }
    const key = folderKey(folder);
    const now = this.s.clock.now();
    const hit = this.cache.get(key);
    if (hit && !fresh && now - hit.at < GIT_CACHE_MS) return { ...hit, missing: false };
    let git: ProjectGit | undefined;
    try { git = await readGit(gitOf(this.s), folder); } catch (error) { this.s.log.warn('project git state failed', { error: String(error) }); }
    let about = '';
    try { about = folderAbout(folder); } catch { about = ''; }
    const entry = { at: now, ...(git ? { git } : {}), about };
    this.cache.set(key, entry);
    return { ...entry, missing: false };
  }

  /** The person's chats with the project's agents, newest first. */
  private sessions(agentIds: ReadonlySet<string>, chats: ConversationSummary[]): ProjectSession[] {
    if (!agentIds.size) return [];
    return chats.flatMap((chat) => {
      if (chat.archivedAt) return [];
      const ids = chat.members.filter((member) => member.kind === 'agent' && !member.leftAt && agentIds.has(member.memberId)).map((member) => member.memberId);
      if (!ids.length) return [];
      return [{ conversationId: chat.id, title: chat.title, agentIds: ids, lastAt: chat.lastMessageAt ?? chat.updatedAt, working: chat.working.some((agentId) => ids.includes(agentId)) }];
    }).sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_SESSIONS);
  }

  /** Every project's folder with its record and agents (hidden ones left out unless `withHidden`). */
  private entries(withHidden = false): Map<string, { folder: string; record?: ProjectRecord; agents: Array<{ id: string; name: string }> }> {
    const map = new Map<string, { folder: string; record?: ProjectRecord; agents: Array<{ id: string; name: string }> }>();
    for (const record of this.records()) map.set(projectId(record.folder), { folder: record.folder, record, agents: [] });
    for (const { folder, agent } of this.homes()) {
      const id = projectId(folder);
      const entry = map.get(id) ?? { folder, agents: [] };
      entry.agents.push(agent);
      map.set(id, entry);
    }
    for (const [id, entry] of map) {
      const shown = entry.record ? (entry.record.added || entry.agents.length > 0) && !entry.record.hidden : entry.agents.length > 0;
      if (!shown && !withHidden) map.delete(id);
    }
    return map;
  }

  private async build(id: string, entry: { folder: string; record?: ProjectRecord; agents: Array<{ id: string; name: string }> }, chats: ConversationSummary[], fresh: boolean): Promise<Project> {
    const { git, about, missing } = await this.details(entry.folder, fresh);
    const sessions = this.sessions(new Set(entry.agents.map((agent) => agent.id)), chats);
    const lastActiveAt = Math.max(0, sessions[0]?.lastAt ?? 0, git?.lastCommit?.at ?? 0);
    return {
      id,
      folder: entry.folder,
      name: entry.record?.name?.trim() || path.basename(entry.folder) || entry.folder,
      source: entry.record?.added ? 'added' : 'agent',
      pinned: entry.record?.pinned === true,
      addedAt: entry.record?.addedAt ?? 0,
      lastActiveAt,
      ...(missing ? { missing: true } : {}),
      ...(git ? { git } : {}),
      agents: [...entry.agents].sort((a, b) => a.name.localeCompare(b.name)),
      sessions,
      about,
    };
  }

  private chats(): ConversationSummary[] {
    try { return this.s.chats.list(); } catch (error) { this.s.log.warn('project sessions failed', { error: String(error) }); return []; }
  }

  async list(): Promise<Project[]> {
    const chats = this.chats();
    const projects = await Promise.all([...this.entries()].map(([id, entry]) => this.build(id, entry, chats, false)));
    return sortProjects(projects);
  }

  async get(id: string, fresh = true): Promise<Project> {
    const entry = this.entries().get(id);
    if (!entry) throw new WorkforceError('not_found', 'No such project.', { details: { id } });
    return this.build(id, entry, this.chats(), fresh);
  }

  private async announce(id: string): Promise<Project> {
    const project = await this.get(id);
    this.s.bus.emit('project.upserted', project);
    return project;
  }

  async add(folder: string, name?: string): Promise<Project> {
    const dir = this.resolve(folder);
    const id = projectId(dir);
    const before = this.record(id);
    const record: ProjectRecord = { ...before, folder: before?.folder ?? dir, added: true, addedAt: before?.added ? before.addedAt : this.s.clock.now() };
    delete record.hidden;
    if (name !== undefined && name.trim()) record.name = name.trim();
    this.save(id, record);
    return this.announce(id);
  }

  async update(id: string, patch: { name?: string; pinned?: boolean }): Promise<Project> {
    const entry = this.entries().get(id);
    if (!entry) throw new WorkforceError('not_found', 'No such project.', { details: { id } });
    const record: ProjectRecord = entry.record ?? { folder: entry.folder, added: false, addedAt: this.s.clock.now() };
    if (patch.name !== undefined) { if (patch.name.trim()) record.name = patch.name.trim(); else delete record.name; }
    if (patch.pinned !== undefined) record.pinned = patch.pinned;
    this.save(id, record);
    return this.announce(id);
  }

  remove(id: string): { ok: true } {
    const entry = this.entries().get(id);
    if (!entry) throw new WorkforceError('not_found', 'No such project.', { details: { id } });
    if (entry.agents.length) this.save(id, { ...(entry.record ?? { folder: entry.folder, addedAt: this.s.clock.now() }), added: false, hidden: true }); // it follows from an agent's home – stays off until added again
    else this.kv().delete(PROJECTS_NS, id);
    this.cache.delete(folderKey(entry.folder));
    this.s.bus.emit('project.removed', { id });
    return { ok: true };
  }

  async startSession(input: StartSessionInput): Promise<{ project: Project; conversation: ConversationSummary; agentCreated: boolean }> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new WorkforceError('bad_request', 'prompt: say what should happen.');
    const entry = this.entries().get(input.projectId);
    if (!entry) throw new WorkforceError('not_found', 'No such project.', { details: { id: input.projectId } });
    if (!isDir(entry.folder)) throw new WorkforceError('conflict', 'The project folder no longer exists.');
    let agentId = input.agentId;
    let agentCreated = false;
    if (agentId) {
      if (!entry.agents.some((agent) => agent.id === agentId)) throw new WorkforceError('bad_request', 'agentId: an agent working in this project.');
    } else if (entry.agents.length) {
      agentId = [...entry.agents].sort((a, b) => a.name.localeCompare(b.name))[0]!.id;
    } else {
      const { agent } = createFolderAgent(this.s as Parameters<typeof createFolderAgent>[0], { folder: entry.folder, name: '', role: '' });
      agentId = agent.id;
      agentCreated = true;
    }
    const title = input.title?.trim() || titleFrom(prompt);
    const conversation = this.s.chats.create({ title, agentIds: [agentId], createdBy: HUMAN_ID });
    this.s.chats.send({ conversationId: conversation.id, body: prompt, authorId: HUMAN_ID, authorKind: 'human' });
    const project = await this.announce(input.projectId);
    return { project, conversation: this.s.chats.summary(conversation.id), agentCreated };
  }
}

const services = new WeakMap<object, ProjectService>();

/** The ProjectService of a services object (created on first use, so its git cache lives as long as the runtime). */
export function projectsOf(s: ProjectServices): ProjectService {
  let service = services.get(s);
  if (!service) { service = new ProjectService(s); services.set(s, service); }
  return service;
}
