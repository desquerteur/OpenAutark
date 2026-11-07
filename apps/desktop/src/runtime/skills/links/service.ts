// Skills from a link (AF-007): preview → install into one place → later check and apply an update. A preview holds the
// bytes the person saw (at most MAX_PREVIEWS for PREVIEW_MS), so the install writes exactly those; the places are the
// existing skill routes (shared library, an agent's own skills via SkillService.folderFor, an agent's home project's
// .claude/skills – Claude Code's project skills, found by skills.find through the home project). Every installed skill
// keeps its source in `.autark-source.json`; skills.linked finds them again in the library and in the agents' home
// projects, and an update is only offered for a folder found that way (never for a path a client names).
// Owns: the previews, the places and the install/update flow. Never: runs a file of a skill, writes outside the chosen
// place or reads a private source (no tokens are sent).

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Clock, FileStore, SkillService } from '../../contracts.ts';
import type { Agent } from '../../../shared/model/org.ts';
import type { SkillInfo } from '../../../shared/model/knowledge.ts';
import type { LinkedSkill, SkillInstallTarget, SkillLinkPreview, SkillLinkRecord, SkillLinkSource, SkillLinkTarget, SkillUpdatePreview } from '../../../shared/model/skill-links.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { parseFrontMatter } from '../frontmatter.ts';
import { oneLine } from '../skill-file.ts';
import { readText } from '../discover.ts';
import { LINK_LIMITS } from './archive.ts';
import { findSkills, type FoundSkill } from './candidates.ts';
import type { LinkFetch } from './fetch.ts';
import { diffSkill, readRecord, replaceSkill, writeSkill, type SkillDiff } from './install.ts';
import { loadLink, loadUpload, reloadSource, type LoadedSource } from './source.ts';
import { parseSkillLink } from './url.ts';

export const PREVIEW_MS = 15 * 60_000;
export const MAX_PREVIEWS = 4;
/** Claude Code's project skills folder inside a home project. */
export const PROJECT_SKILLS = ['.claude', 'skills'] as const;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkillLinksDeps {
  fetch: LinkFetch;
  clock: Clock;
  skills: Pick<SkillService, 'list' | 'every' | 'folderFor'>;
  files?: Pick<FileStore, 'get' | 'read'>;
  /** The agents a skill can go to (archived ones left out). */
  agents: () => Array<Pick<Agent, 'id' | 'name'>>;
  /** An agent's usable home project folder (undefined: none). */
  home?: (agentId: string) => string | undefined;
  /** After an install or update: the library reads again, listeners hear it. */
  changed?: (event: { name: string; target: SkillInstallTarget; path: string }) => void;
  id?: () => string;
}

interface Preview { id: string; source: SkillLinkSource; found: FoundSkill[]; commit?: string; expiresAt: number }
interface Update { id: string; linked: LinkedSkill; record: SkillLinkRecord; skill: FoundSkill; diff: SkillDiff; source: SkillLinkSource; commit?: string; expiresAt: number }

const fold = (dir: string): string => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));
const imported = (dir: string): boolean => /[\\/]\.(?:claude|codex)[\\/]skills[\\/][^\\/]+$/.test(dir);

export class SkillLinks {
  private readonly deps: SkillLinksDeps;
  private readonly previews = new Map<string, Preview>();
  private readonly updates = new Map<string, Update>();

  constructor(deps: SkillLinksDeps) {
    this.deps = deps;
  }

  /** Reads a link or an uploaded file and lists its skills (nothing is written). */
  async preview(input: { url?: string; fileId?: string }): Promise<SkillLinkPreview> {
    const loaded = await this.load(input);
    const found = await findSkills(loaded.view, loaded.fallbackName);
    if (!found.skills.length && !found.problems.length) throw new WorkforceError('not_found', 'This link holds no skill (no folder with a SKILL.md).');
    const preview: Preview = { id: this.newId(), source: loaded.source, found: found.skills, ...(loaded.view.commit ? { commit: loaded.view.commit } : {}), expiresAt: this.deps.clock.now() + PREVIEW_MS };
    this.keep(this.previews, preview);
    return { id: preview.id, source: preview.source, skills: found.skills.map((skill) => skill.info), problems: found.problems, ...(found.truncated ? { truncated: true as const } : {}), expiresAt: preview.expiresAt };
  }

  /** The places a skill can go: shared, each agent's own skills, each agent's home project. */
  targets(): SkillLinkTarget[] {
    const out: SkillLinkTarget[] = [{ target: { kind: 'shared' }, label: 'Shared – every agent', hint: 'The shared skill library', folder: this.base({ kind: 'shared' }) }];
    const agents = [...this.deps.agents()].sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of agents) {
      try { out.push({ target: { kind: 'agent', agentId: agent.id }, label: `${agent.name} – own skills`, hint: `Only ${agent.name} and the team below`, folder: this.base({ kind: 'agent', agentId: agent.id }) }); } catch { /* no folder for this agent */ }
    }
    for (const agent of agents) {
      const home = this.deps.home?.(agent.id);
      if (home) out.push({ target: { kind: 'project', agentId: agent.id }, label: `${agent.name}'s project`, hint: home, folder: path.join(home, ...PROJECT_SKILLS) });
    }
    return out;
  }

  /** Installs the chosen skills of a preview into one place; a taken name there refuses the whole install. */
  async install(input: { previewId: string; routes: readonly string[]; target: SkillInstallTarget }): Promise<{ installed: LinkedSkill[] }> {
    const preview = this.live(this.previews, input.previewId);
    if (!input.routes.length) throw new WorkforceError('bad_request', 'Choose at least one skill.');
    const chosen = [...new Set(input.routes)].map((route) => preview.found.find((skill) => skill.info.route === route) ?? this.missing(route));
    const dirs = chosen.map((skill) => ({ skill, dir: this.folder(input.target, skill.info.name) }));
    const taken = dirs.filter((entry) => existsSync(entry.dir)).map((entry) => entry.skill.info.name);
    if (taken.length) throw new WorkforceError('conflict', `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already installed in that place. Delete ${taken.length === 1 ? 'it' : 'them'} first or choose another place.`);
    const installed: LinkedSkill[] = [];
    for (const { skill, dir } of dirs) {
      const record = await writeSkill({ dir, skill, source: preview.source, ...(preview.commit ? { commit: preview.commit } : {}), now: this.deps.clock.now() });
      const linked = this.linkedOf(dir, record, input.target, skill.info.description);
      installed.push(linked);
      this.deps.changed?.({ name: skill.info.name, target: input.target, path: dir });
    }
    return { installed };
  }

  /** Every skill installed from a link: in the skill library and in the agents' home projects. */
  linked(): LinkedSkill[] {
    const out = new Map<string, LinkedSkill>();
    let library: SkillInfo[] = [];
    try { library = this.deps.skills.every?.() ?? this.deps.skills.list(); } catch { library = []; }
    for (const info of library) {
      if (info.source === 'builtin' || imported(info.path)) continue;
      const record = readRecord(info.path);
      if (!record) continue;
      const target: SkillInstallTarget = info.source === 'agent' && info.ownerAgentId ? { kind: 'agent', agentId: info.ownerAgentId } : { kind: 'shared' };
      out.set(fold(info.path), this.linkedOf(info.path, record, target, info.description));
    }
    for (const agent of this.deps.agents()) {
      const home = this.deps.home?.(agent.id);
      if (!home) continue;
      const base = path.join(home, ...PROJECT_SKILLS);
      for (const name of folders(base)) {
        const dir = path.join(base, name);
        if (out.has(fold(dir))) continue;
        const record = readRecord(dir);
        if (record) out.set(fold(dir), this.linkedOf(dir, record, { kind: 'project', agentId: agent.id }, descriptionIn(dir)));
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.place.localeCompare(b.place));
  }

  /** Reads an installed skill's source again and lists what an update changes (`fileId`: the new file of an upload). */
  async checkUpdate(input: { path: string; fileId?: string }): Promise<SkillUpdatePreview> {
    const linked = this.linked().find((skill) => fold(skill.path) === fold(input.path));
    if (!linked) throw new WorkforceError('not_found', 'No skill installed from a link is in that folder.');
    const record = readRecord(linked.path);
    if (!record) throw new WorkforceError('not_found', 'The skill\'s source record is gone.');
    const upload = record.source.kind === 'upload';
    if (upload && !input.fileId) throw new WorkforceError('bad_request', 'This skill came from a file. Choose its new ZIP to update it.');
    if (!upload && input.fileId) throw new WorkforceError('bad_request', 'This skill came from a link; it is updated from there.');
    const loaded = upload ? await this.load({ fileId: input.fileId }) : await reloadSource(this.deps.fetch, record.source);
    const found = await findSkills(loaded.view, loaded.fallbackName);
    const skill = found.skills.find((entry) => entry.info.route === record.route) ?? found.skills.find((entry) => entry.info.name === record.name)
      ?? (found.skills.length === 1 ? found.skills[0] : undefined);
    if (!skill) throw new WorkforceError('not_found', `The source no longer holds the skill ${record.name}.`);
    if (skill.info.name !== record.name) throw new WorkforceError('conflict', `The source names this skill ${skill.info.name} now. Install it again under that name.`);
    const diff = await diffSkill(linked.path, record, skill);
    const source = upload ? loaded.source : record.source;
    const update: Update = { id: this.newId(), linked, record, skill, diff, source, ...(loaded.view.commit ? { commit: loaded.view.commit } : {}), expiresAt: this.deps.clock.now() + PREVIEW_MS };
    this.keep(this.updates, update);
    const scripts = diff.changes.filter((change) => change.script && change.change !== 'removed').map((change) => change.path);
    const before = linked.description;
    const after = skill.info.description;
    return {
      id: update.id, path: linked.path, name: linked.name, source, changes: diff.changes, unchanged: diff.unchanged, scripts,
      ...(before !== after ? { description: { before, after } } : {}),
      ...(record.commit || update.commit ? { commit: { ...(record.commit ? { before: record.commit } : {}), ...(update.commit ? { after: update.commit } : {}) } } : {}),
      expiresAt: update.expiresAt,
    };
  }

  /** Applies a checked update in one swap. */
  applyUpdate(input: { previewId: string }): LinkedSkill {
    const update = this.live(this.updates, input.previewId);
    const record = replaceSkill({ dir: update.linked.path, record: update.record, diff: update.diff, skill: update.skill, source: update.source, ...(update.commit ? { commit: update.commit } : {}), now: this.deps.clock.now() });
    this.updates.delete(update.id);
    this.deps.changed?.({ name: record.name, target: update.linked.target, path: update.linked.path });
    return this.linkedOf(update.linked.path, record, update.linked.target, update.skill.info.description);
  }

  // ---------------------------------------------------------------- helpers

  private async load(input: { url?: string; fileId?: string }): Promise<LoadedSource> {
    const url = input.url?.trim();
    if (url && input.fileId) throw new WorkforceError('bad_request', 'Give a link or a file, not both.');
    if (url) return loadLink(this.deps.fetch, parseSkillLink(url));
    if (!input.fileId) throw new WorkforceError('bad_request', 'Paste a link or choose a ZIP.');
    const files = this.deps.files;
    const ref = files?.get(input.fileId);
    if (!files || !ref) throw new WorkforceError('not_found', 'The chosen file is not here (upload it again).');
    if (ref.size > LINK_LIMITS.archiveBytes) throw new WorkforceError('bad_request', 'This ZIP is larger than 64 MB.');
    return loadUpload(ref.name, Buffer.from(await files.read(input.fileId)));
  }

  private base(target: SkillInstallTarget): string {
    return path.dirname(this.folder(target, 'placeholder'));
  }

  /** The folder a skill of this name gets in `target`. */
  private folder(target: SkillInstallTarget, name: string): string {
    if (!SKILL_NAME.test(name)) throw new WorkforceError('bad_request', `${name} is not a skill name.`);
    if (target.kind === 'project') {
      const home = this.agentOf(target.agentId) && this.deps.home?.(target.agentId);
      if (!home) throw new WorkforceError('bad_request', 'This agent has no home project on this PC.');
      return path.join(home, ...PROJECT_SKILLS, name);
    }
    if (target.kind === 'agent' && !this.agentOf(target.agentId)) throw new WorkforceError('not_found', 'There is no such agent.');
    const folderFor = this.deps.skills.folderFor;
    if (!folderFor) throw new WorkforceError('unavailable', 'Skills cannot be installed here.');
    return folderFor.call(this.deps.skills, name, target.kind === 'agent' ? target.agentId : undefined);
  }

  private agentOf(agentId: string): Pick<Agent, 'id' | 'name'> | undefined {
    return this.deps.agents().find((agent) => agent.id === agentId);
  }

  private placeOf(target: SkillInstallTarget): string {
    if (target.kind === 'shared') return 'Shared';
    const name = this.agentOf(target.agentId)?.name ?? target.agentId;
    return target.kind === 'agent' ? `Own · ${name}` : `Project · ${name}`;
  }

  private linkedOf(dir: string, record: SkillLinkRecord, target: SkillInstallTarget, description: string): LinkedSkill {
    return {
      name: record.name, description, path: dir, target, place: this.placeOf(target), source: record.source, route: record.route,
      installedAt: record.installedAt, updatedAt: record.updatedAt, ...(record.commit ? { commit: record.commit } : {}),
    };
  }

  private missing(route: string): never {
    throw new WorkforceError('bad_request', `The preview has no skill in ${route || 'its root'}.`);
  }

  private newId(): string {
    return this.deps.id?.() ?? randomUUID();
  }

  /** Keeps a preview; expired ones go, and beyond MAX_PREVIEWS the oldest. */
  private keep<T extends { id: string; expiresAt: number }>(map: Map<string, T>, item: T): void {
    const now = this.deps.clock.now();
    for (const [id, entry] of map) if (entry.expiresAt <= now) map.delete(id);
    while (map.size >= MAX_PREVIEWS) map.delete(map.keys().next().value!);
    map.set(item.id, item);
  }

  private live<T extends { expiresAt: number }>(map: Map<string, T>, id: string): T {
    const item = map.get(id);
    if (!item || item.expiresAt <= this.deps.clock.now()) {
      map.delete(id);
      throw new WorkforceError('not_found', 'This preview has expired. Read the link again.');
    }
    return item;
  }
}

/** The plain folders in `dir` (no links). */
function folders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** The description in a skill folder's SKILL.md ('' when there is none). */
function descriptionIn(dir: string): string {
  const read = readText(path.join(dir, 'SKILL.md'), LINK_LIMITS.skillFileBytes);
  if (typeof read === 'string') return '';
  const { data } = parseFrontMatter(read.text.replace(/\r\n?/g, '\n'));
  return typeof data.description === 'string' ? oneLine(data.description).slice(0, 1024) : '';
}
