// F-51 local team pattern library: built-in patterns (resources/patterns/*.md, read once), the
// person's saved patterns (from the current org) and imported ones (an https URL or a picked file,
// with provenance: URL or file name, sha256, time, previous hash after an update, version from the
// front matter). Applying is a proposal the person edits (propose → patterns.apply →
// org/team-proposal.ts); agents read the library through patterns.find / patterns.load (tools.ts).
// Decision (F-51 item 20): no public library service run by us – a public source is any URL or file
// the person chooses; its text is scrubbed of secrets, never trusted as an instruction and grants nothing.
// Stored rows are parsed once per version (id + updated_at, dropped on refresh/remove) and only
// the requested row is read for get/text – list, patterns.find and patterns.load do not re-parse.
// Owns: the library (rows in team_patterns), proposals from patterns and their reports.
// Never: fetches on its own (only the person's import/refresh), stores secrets or local paths, or
// removes built-in patterns.

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { PatternProvenance, PatternSource, PatternSummary, ProposedAgent, TeamPattern } from '../../shared/model/team-start.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/team-start.ts';
import { guessMode, importedMode, modeTiers } from '../importers/modes.ts';
import { defaultManager } from '../portability/agents.ts';
import { coreInstructions } from '../agent-core/prompt.ts';
import { parsePattern, patternFromAgents, storedText, type ParsedPattern } from './format.ts';
import { fetchPattern, type FetchText } from './fetch.ts';

interface Row { id: string; name: string; version: string; source: string; body: string; provenance: string; created_at: number; updated_at: number }
/** A library entry; `text` is kept for built-ins only (stored rows read their body on demand). */
interface Entry { id: string; source: PatternSource; text?: string; parsed: ParsedPattern; provenance?: PatternProvenance; updatedAt: number }
interface Meta { id: string; updated_at: number }

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const MAX_ROWS = 200;

export interface PatternLibraryDeps {
  services: () => RuntimeServices;
  /** resources/patterns */
  dir: string;
  fetch?: FetchText;
}

export class PatternLibrary {
  private readonly deps: PatternLibraryDeps;
  private builtins: Entry[] | undefined;
  /** Stored patterns parsed once per version (id → updated_at; undefined entry: unreadable). */
  private readonly parsed = new Map<string, { updatedAt: number; entry?: Entry }>();

  constructor(deps: PatternLibraryDeps) { this.deps = deps; }

  list(): PatternSummary[] {
    return this.entries().map((entry) => summary(entry));
  }

  get(id: string): TeamPattern {
    const entry = this.entry(id);
    const { agents, dropped, mapped } = this.propose(entry.parsed, entry.source);
    return { ...summary(entry), guide: entry.parsed.guide, agents, report: { mapped, dropped: [...entry.parsed.dropped, ...dropped] } };
  }

  /** The pattern's text for an agent (patterns.load), bounded. */
  text(id: string): { entry: PatternSummary; text: string } {
    const entry = this.entry(id);
    const body = entry.text ?? this.deps.services().db.get<{ body: string }>('SELECT body FROM team_patterns WHERE id = ?', [id])?.body ?? '';
    return { entry: summary(entry), text: body.slice(0, 20_000) };
  }

  saveFromOrg(input: { name: string; description?: string; rootId?: string }): PatternSummary {
    const s = this.deps.services();
    const active = s.org.list().filter((agent) => !agent.archivedAt);
    // The whole team leaves out the first manager: every installation has its own; its reports become top roles.
    const first = input.rootId ? undefined : defaultManager(s);
    let agents = active.filter((agent) => agent.id !== first);
    if (input.rootId) {
      const ids = new Set([input.rootId]);
      for (let grew = true; grew;) {
        grew = false;
        for (const agent of active) if (agent.managerId && ids.has(agent.managerId) && !ids.has(agent.id)) { ids.add(agent.id); grew = true; }
      }
      agents = active.filter((agent) => ids.has(agent.id));
    }
    if (!agents.length) throw new WorkforceError('bad_request', 'There is no agent to save in this pattern.');
    const saved = agents.map((agent) => ({ ...agent, instructions: coreInstructions(s, agent) })); // wave 3: SYSTEM.md, as in the agents' prompts
    const text = patternFromAgents({ name: input.name.trim(), description: input.description?.trim() ?? '', version: '1', agents: saved });
    return this.store('saved', text, { kind: 'org', sha256: sha(text), at: s.clock.now() });
  }

  async import(input: { url?: string; name?: string; text?: string }): Promise<PatternSummary> {
    const s = this.deps.services();
    if (input.url) {
      const text = await fetchPattern(input.url, this.deps.fetch);
      return this.store('imported', text, { kind: 'url', ref: input.url, sha256: sha(text), at: s.clock.now() });
    }
    if (input.text === undefined) throw new WorkforceError('bad_request', 'Give a URL or a file.');
    const file = (input.name ?? 'pattern.md').replace(/^.*[\\/]/, '').slice(0, 120);
    return this.store('imported', input.text, { kind: 'file', ref: file, sha256: sha(input.text), at: s.clock.now() });
  }

  /** "Check for update" of a URL pattern: the person's request, one fetch. */
  async refresh(id: string): Promise<PatternSummary> {
    const entry = this.entry(id);
    if (entry.source !== 'imported' || entry.provenance?.kind !== 'url' || !entry.provenance.ref) throw new WorkforceError('bad_request', 'Only a pattern imported from a URL can be checked for updates.');
    const text = await fetchPattern(entry.provenance.ref, this.deps.fetch);
    const hash = sha(text);
    if (hash === entry.provenance.sha256) return summary(entry);
    const parsed = parsePattern(text);
    const now = this.deps.services().clock.now();
    const provenance: PatternProvenance = { ...entry.provenance, sha256: hash, at: now, previousSha256: entry.provenance.sha256 };
    this.deps.services().db.run('UPDATE team_patterns SET name = ?, version = ?, body = ?, provenance = ?, updated_at = ? WHERE id = ?',
      [parsed.name, parsed.version, storedText(text), JSON.stringify(provenance), now, id]);
    this.parsed.delete(id);
    return summary(this.entry(id));
  }

  remove(id: string): void {
    if (id.startsWith('builtin:')) throw new WorkforceError('bad_request', 'Built-in patterns cannot be removed.');
    const s = this.deps.services();
    const result = s.db.run('DELETE FROM team_patterns WHERE id = ?', [id]);
    this.parsed.delete(id);
    if (!result.changes) throw new WorkforceError('not_found', 'This pattern does not exist.');
    s.log.info('team pattern removed', { id });
  }

  /**
   * A pattern as an editable proposal: templates resolved, unknown skills and templates reported;
   * an imported pattern never preselects a power mode (importers/modes.ts importedMode).
   */
  propose(pattern: ParsedPattern, source: PatternSource = 'imported'): { agents: ProposedAgent[]; mapped: string[]; dropped: string[] } {
    const s = this.deps.services();
    const templates = new Map(s.org.templates().map((template) => [template.key, template]));
    const skills = new Set((s.skills?.list() ?? []).map((skill) => skill.name));
    const tiers = modeTiers(() => s.modes.list());
    const modes = new Set(tiers.keys());
    const keys = new Map(pattern.roles.map((role, index) => [role.name.toLocaleLowerCase(), `p${index + 1}`]));
    const mapped: string[] = [];
    const dropped: string[] = [];
    const agents = pattern.roles.map((role, index): ProposedAgent => {
      const template = role.template ? templates.get(role.template) : undefined;
      if (role.template && !template) dropped.push(`${role.name}: template "${role.template}" is not installed here – role and instructions come from the pattern`);
      const wanted = [...(template?.skills ?? []), ...role.skills];
      const missing = wanted.filter((skill) => !skills.has(skill));
      if (missing.length) dropped.push(`${role.name}: skills not in this app: ${[...new Set(missing)].join(', ')}`);
      const modeName = role.mode ?? template?.mode;
      const named = modeName && modes.has(modeName) ? modeName : guessMode(`${role.role ?? ''} ${role.name}`, modes);
      const mode = source === 'imported' ? importedMode(role.name, named, tiers, dropped) : named;
      const parent = role.reportsTo ? keys.get(role.reportsTo.toLocaleLowerCase()) : undefined;
      const partner = role.companionOf ? keys.get(role.companionOf.toLocaleLowerCase()) : undefined;
      if (role.companionOf && !partner) dropped.push(`${role.name}: companion of "${role.companionOf}", who is not in this pattern`);
      if (role.reportsTo && !parent) dropped.push(`${role.name}: reports to "${role.reportsTo}", who is not in this pattern – reports to the chosen manager`);
      return {
        key: `p${index + 1}`, name: role.name, role: role.role ?? template?.role ?? role.name,
        instructions: [template?.instructions ?? '', role.body].filter((part) => part.trim()).join('\n\n').slice(0, 20_000),
        mode, skills: [...new Set(wanted.filter((skill) => skills.has(skill)))], include: !role.optional,
        ...(template ? { template: template.key } : {}), ...(parent && parent !== `p${index + 1}` ? { reportsTo: parent } : {}),
        ...(partner && partner !== `p${index + 1}` ? { companionOf: partner } : {}),
      };
    });
    mapped.push(`${agents.length} role${agents.length === 1 ? '' : 's'} → editable agents`);
    if (pattern.secretsRemoved) dropped.push(`${pattern.secretsRemoved} secret${pattern.secretsRemoved === 1 ? '' : 's'} removed from the text`);
    return { agents, mapped, dropped };
  }

  private store(source: 'saved' | 'imported', text: string, provenance: PatternProvenance): PatternSummary {
    const s = this.deps.services();
    const parsed = parsePattern(text); // validates before anything is stored
    const count = s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM team_patterns')?.n ?? 0;
    if (count >= MAX_ROWS) throw new WorkforceError('conflict', `Remove a pattern first: the library keeps at most ${MAX_ROWS}.`);
    const id = `pt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const now = s.clock.now();
    s.db.run('INSERT INTO team_patterns (id, name, version, source, body, provenance, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, parsed.name, parsed.version, source, storedText(text), JSON.stringify(provenance), HUMAN_ID, now, now]);
    s.log.info('team pattern stored', { id, source, provenance: provenance.kind, roles: parsed.roles.length });
    return summary(this.entry(id));
  }

  /** One pattern: a built-in, or only the requested row (parsed once per version). */
  private entry(id: string): Entry {
    const found = id.startsWith('builtin:')
      ? this.builtin().find((entry) => entry.id === id)
      : (() => {
        const meta = this.deps.services().db.get<Meta>('SELECT id, updated_at FROM team_patterns WHERE id = ?', [id]);
        return meta ? this.load(meta) : undefined;
      })();
    if (!found) throw new WorkforceError('not_found', 'This pattern does not exist.');
    return found;
  }

  private entries(): Entry[] {
    const rows = this.deps.services().db.all<Meta>('SELECT id, updated_at FROM team_patterns ORDER BY updated_at DESC LIMIT ?', [MAX_ROWS]);
    const live = new Set(rows.map((row) => row.id));
    for (const id of this.parsed.keys()) if (!live.has(id)) this.parsed.delete(id);
    const own = rows.map((row) => this.load(row)).filter((entry): entry is Entry => entry !== undefined);
    return [...this.builtin(), ...own];
  }

  /** A stored row, parsed when it is new or changed since the last call; unreadable rows are logged once per version. */
  private load(meta: Meta): Entry | undefined {
    const cached = this.parsed.get(meta.id);
    if (cached && cached.updatedAt === meta.updated_at) return cached.entry;
    const s = this.deps.services();
    const row = s.db.get<Row>('SELECT * FROM team_patterns WHERE id = ?', [meta.id]);
    if (!row) { this.parsed.delete(meta.id); return undefined; }
    let entry: Entry | undefined;
    try {
      entry = { id: row.id, source: row.source as PatternSource, parsed: parsePattern(row.body), provenance: JSON.parse(row.provenance) as PatternProvenance, updatedAt: row.updated_at };
    } catch (error) { s.log.warn('team pattern unreadable', { id: row.id, error: String(error) }); }
    this.parsed.set(row.id, { updatedAt: row.updated_at, ...(entry ? { entry } : {}) });
    return entry;
  }

  private builtin(): Entry[] {
    if (this.builtins) return this.builtins;
    const out: Entry[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.deps.dir).filter((name) => name.endsWith('.md')).sort(); } catch { names = []; }
    for (const name of names) {
      try {
        const text = readFileSync(path.join(this.deps.dir, name), 'utf8');
        out.push({ id: `builtin:${name.slice(0, -3)}`, source: 'builtin', text, parsed: parsePattern(text), updatedAt: 0 });
      } catch (error) { this.deps.services().log.warn('built-in pattern unreadable', { name, error: String(error) }); }
    }
    this.builtins = out;
    return out;
  }
}

function summary(entry: Entry): PatternSummary {
  return {
    id: entry.id, name: entry.parsed.name, description: entry.parsed.description, version: entry.parsed.version, source: entry.source,
    ...(entry.provenance ? { provenance: entry.provenance } : {}), tags: entry.parsed.tags, agentCount: entry.parsed.roles.length,
    optional: entry.parsed.optional, updatedAt: entry.updatedAt, // B-047 D7: no first-run preselection (`start`) any more
  };
}
