// AgentCore (wave 3): SYSTEM.md in each agent's core folder is the one authoritative source of its
// instructions (layout.ts). The `agents.instructions` column stays as the cache of the last good text
// (lists, exports, history and every older reader keep working) and is never newer than the file:
//   - an edit in the app (agents.update, the agents.update tool, a revert) writes SYSTEM.md first
//     (OrgService hook beforeSave, atomic) – a failed write fails the edit; an edit that does not change
//     the instructions never touches the file; a file changed outside and not taken over yet is a
//     conflict (an editor's stale draft is refused before that: agents.update `base`, root/text-doc.ts staleBase);
//   - a change on disk (an editor, a script) reaches the cache as an edit by the person with the reason
//     EXTERNAL_REASON (an agent revision with undo) – picked up through the data folder watcher (watch.ts →
//     runtime/root/watcher.ts, the owner of <data>/agents), at start
//     (reconcileAll – also the one-time migration: every agent without a folder gets one from its cached
//     instructions, idempotent), when agents.core is read, and by a stat at each prompt (instructions():
//     the prompt uses the file's text before the cache caught up, an emptied file only after the
//     debounced take-over – it may be an editor's save in progress);
//   - a missing SYSTEM.md is written again from the cache (deleting it never drops instructions; an empty
//     file means none); a too large, non-UTF-8, unreadable or linked one leaves the cache in use with a
//     quiet notice (store.ts); an id that cannot name a folder keeps its instructions in the app only.
// Main Skills (<folder>/skills) belong to the skill library (skills/service.ts mainRoots); a change on disk
// invalidates it, then 'skills.changed' tells every listener. discardOrphans removes the folders of hires a
// rolled-back transaction took back. A watcher an error stopped is armed again on the next use (RootWatcher.ensure).
// B-044: the agent's home project (home.ts – `home` in agent.json): read, judged, set or cleared here (an edit on
// disk too: 'agentCore.changed'); its skills are listed from the home folder (untrusted, bounded, cached).
// Owns: these rules. Never: stores instructions anywhere else, treats file text as a permission, or polls.

import { mkdirSync, rmSync } from 'node:fs';
import type { Bus } from '../bus.ts';
import type { Clock, Logger, OrgService } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { AGENT_CORE_DIR, type AgentCoreInfo, type AgentHome } from '../../shared/model/agent-core.ts';
import type { SkillInfo } from '../../shared/model/knowledge.ts';
import type { Agent } from '../../shared/model/org.ts';
import { agentFolder, coreRoot, isCoreFolderName, mainSkillsDir, mainSkillsSignature, systemText, type SystemRead } from './layout.ts';
import { canonical } from '../root/text-doc.ts';
import type { RootWatcher } from '../root/watcher.ts';
import { nudgeCore, watchCoreFolders, type CoreChange } from './watch.ts';
import { mainSkillProblems } from './info.ts';
import { FolderStore } from './store.ts';
import { AgentHomes, type HomePaths } from './home.ts';

export { REJECTED_FILE } from './store.ts';
export const EXTERNAL_REASON = 'Changed in SYSTEM.md outside the app.';

export interface AgentCoreDeps {
  dataDir: string;
  org: () => OrgService;
  /** The skill library (SkillLibrary): skills as a viewer's route sees them, an agent's enabled Main Skills, a fresh look. */
  skills: () => { list(viewerId?: string): SkillInfo[]; mainFor(agent: Agent): SkillInfo[]; invalidate?(): void } | undefined;
  bus: Pick<Bus, 'emit' | 'on'>;
  clock: Clock;
  log: Logger;
  /** The data folder watcher (compose: s.rootWatcher; absent = no live pick-up, follow-ups run after the current work). */
  root?: Pick<RootWatcher, 'register' | 'nudge' | 'ensure' | 'flush' | 'wrote'>;
  /** Runs a follow-up after the current work when there is no watcher (default setImmediate). */
  defer?: (run: () => void) => void;
  paths?: HomePaths; // B-044: the folders homes are resolved against (no paths = no home projects: fakes)
}

export type ReconcileOutcome = 'created' | 'updated' | 'same' | 'problem' | 'skipped' | 'unknown';

export class AgentCore {
  private readonly deps: AgentCoreDeps;
  private readonly store: FolderStore;
  private readonly scheduled = new Set<string>();
  /** Hires this run wrote a folder for (a rolled-back transaction may take the agent back). */
  private readonly hired = new Set<string>();
  private offWatch?: () => void;
  private offUpserted?: () => void;
  /** B-044: the home projects (home.ts) – state, the folder turns start in (usable), its skills (skillsIn). */
  readonly homes: AgentHomes;

  constructor(deps: AgentCoreDeps) {
    this.deps = deps;
    this.store = new FolderStore({ ...deps, writes: deps.root });
    this.homes = new AgentHomes({ dataDir: deps.dataDir, paths: deps.paths, clock: deps.clock });
  }

  /** Start-up reconcile (and one-time migration) of every agent, then live pick-up. */
  start(): Record<ReconcileOutcome, number> {
    mkdirSync(coreRoot(this.deps.dataDir), { recursive: true, mode: 0o700 });
    // Registered before the reconcile: an edit on disk meanwhile is handed over, the reconcile's own writes are not.
    if (this.deps.root && !this.offWatch) this.offWatch = watchCoreFolders(this.deps.root, (agentId, change) => this.changed(agentId, change));
    const counts = this.reconcileAll();
    this.offUpserted = this.deps.bus.on('agent.upserted', (agent) => this.store.refreshManifest(agent));
    this.deps.log.info('agent folders reconciled', counts);
    return counts;
  }

  stop(): void {
    this.offWatch?.();
    this.offWatch = undefined;
    this.offUpserted?.();
    this.offUpserted = undefined;
  }

  /** Hands over pending folder events now (tests). */
  flush(): void {
    if (this.offWatch) this.deps.root?.flush(AGENT_CORE_DIR);
  }

  reconcileAll(): Record<ReconcileOutcome, number> {
    const counts: Record<ReconcileOutcome, number> = { created: 0, updated: 0, same: 0, problem: 0, skipped: 0, unknown: 0 };
    for (const agent of this.deps.org().list({ includeArchived: true })) {
      counts[this.reconcile(agent.id)]++;
      if (isCoreFolderName(agent.id)) this.store.state(agent.id).skillsSig ??= mainSkillsSignature(this.deps.dataDir, agent.id);
    }
    return counts;
  }

  /** The folder's state into the cache: an outside edit becomes an edit by the person, a missing file is written again. */
  reconcile(agentId: string): ReconcileOutcome {
    const agent = this.deps.org().get(agentId);
    if (!agent) return 'unknown';
    if (!isCoreFolderName(agentId)) { this.store.setNotice(agentId, 'no-folder'); return 'skipped'; }
    const state = this.store.state(agentId);
    const manifest = this.store.knownManifest(agentId);
    const read = this.store.safeCheck(agentId);
    if (read.kind === 'missing') {
      // A folder without agent.json is new (the one-time migration, an agent the old store imported): silent;
      // with it, SYSTEM.md was removed: written again and named once.
      if (!this.store.writeFolder(agent)) return 'problem';
      this.store.setNotice(agentId, manifest !== undefined ? 'missing' : undefined);
      return 'created';
    }
    if (manifest === undefined) this.store.tryManifest(agent);
    if (read.kind === 'problem') {
      this.store.setNotice(agentId, read.problem);
      return 'problem';
    }
    const outside = this.store.isOutside(agentId, read);
    if (read.text !== canonical(agent.instructions)) {
      try {
        this.deps.org().update(agentId, { instructions: read.text }, { by: HUMAN_ID, reason: EXTERNAL_REASON });
      } catch (error) {
        this.deps.log.warn('SYSTEM.md not taken over', { agentId, error: String(error) });
        this.store.setNotice(agentId, 'unreadable');
        return 'problem';
      }
      this.store.adopt(agentId, read.sig);
      this.store.setNotice(agentId, undefined);
      return 'updated';
    }
    if (outside || state.notice?.problem !== 'missing') this.store.setNotice(agentId, undefined);
    return 'same';
  }

  /**
   * OrgService hook, before an edit is saved: SYSTEM.md gets the new instructions first. Throws (and
   * the edit is not saved) when the file cannot be written or was changed outside the app meanwhile.
   */
  beforeSave(before: Agent, next: Agent): void {
    const wanted = canonical(next.instructions);
    if (canonical(before.instructions) === wanted || !isCoreFolderName(next.id)) return; // no folder: the row only
    const read = this.store.safeCheck(next.id);
    if (read.kind === 'ok' && read.text === wanted) return; // already the file's text (taking over an outside edit)
    if (read.kind === 'ok' && read.text !== canonical(before.instructions)) {
      this.later(next.id);
      throw new WorkforceError('conflict', 'SYSTEM.md was changed outside the app. Its text is being loaded – check it and save again.');
    }
    if (read.kind === 'problem') this.store.keepRejected(next.id);
    try {
      if (read.kind === 'missing' && !this.store.state(next.id).manifest) this.store.writeManifest(next);
      this.store.write(next.id, systemText(next.instructions));
    } catch (error) {
      this.deps.log.warn('SYSTEM.md not written', { agentId: next.id, error: String(error) });
      this.store.setNotice(next.id, 'unwritable');
      throw new WorkforceError('unavailable', 'The instructions could not be saved: SYSTEM.md in the agent folder cannot be written.');
    }
    this.store.setNotice(next.id, undefined);
  }

  /** OrgService hook after a hire: the new agent's folder (a failure is a notice; the next start writes it). */
  created(agent: Agent): void {
    if (!isCoreFolderName(agent.id)) return;
    this.hired.add(agent.id);
    this.store.writeFolder(agent);
  }

  /** After a rolled-back hire (import, derive, team proposal): removes the folders of agents this run hired that no longer exist. */
  discardOrphans(): number {
    let removed = 0;
    for (const agentId of [...this.hired]) {
      this.hired.delete(agentId);
      if (this.deps.org().get(agentId)) continue;
      this.store.forget(agentId);
      this.homes.forget(agentId);
      try {
        rmSync(agentFolder(this.deps.dataDir, agentId), { recursive: true, force: true });
        removed++;
      } catch (error) {
        this.deps.log.warn('agent folder of a rolled-back hire not removed', { agentId, error: String(error) });
      }
    }
    if (removed) this.deps.skills()?.invalidate?.();
    return removed;
  }

  /** The instructions a prompt uses now: SYSTEM.md when it is usable, else the cached last good text. */
  instructions(agent: Agent): string {
    if (!isCoreFolderName(agent.id)) return agent.instructions;
    this.ensureWatching();
    let read: SystemRead;
    try { read = this.store.check(agent.id); } catch { return agent.instructions; }
    if (read.kind === 'ok') {
      const cached = canonical(agent.instructions);
      if (read.text === cached) return read.text;
      this.later(agent.id);
      // An emptied file may be an editor's save in progress: the last good text until the debounced take-over confirms it.
      return read.text === '' && cached !== '' ? agent.instructions : read.text;
    }
    if (read.kind === 'missing' || !this.store.state(agent.id).notice) this.later(agent.id);
    return agent.instructions;
  }

  /** The agent's enabled Main Skills (its prompt section, skills.list). */
  mainSkills(agent: Agent): SkillInfo[] {
    try { return this.deps.skills()?.mainFor(agent) ?? []; } catch { return []; }
  }

  /** agents.core: reconciled now; `withFolder` (the folder and the skill paths) only for the person on the PC. */
  info(agentId: string, withFolder: boolean): AgentCoreInfo {
    this.deps.org().require(agentId);
    this.ensureWatching();
    this.reconcile(agentId);
    const state = this.store.state(agentId);
    const notice = state.notice ? { notice: { ...state.notice } } : {};
    if (!isCoreFolderName(agentId)) return { agentId, inUse: false, ...notice, mainSkills: [] };
    const read = this.store.safeCheck(agentId); // a file the reconcile just wrote again is in use
    const library = this.deps.skills();
    library?.invalidate?.();
    const mainSkills = (library?.list(agentId) ?? []).filter((info) => info.main === true && info.ownerAgentId === agentId)
      .map((info) => (withFolder ? info : { ...info, path: '' }));
    const skillProblems = mainSkillProblems(mainSkillsDir(this.deps.dataDir, agentId), agentId, library);
    const home = this.homes.state(agentId);
    return {
      agentId,
      ...(withFolder ? { folder: agentFolder(this.deps.dataDir, agentId) } : {}),
      ...(home ? { home: withFolder ? home : { ...home, path: '' } } : {}),
      inUse: read.kind === 'ok',
      ...notice,
      mainSkills,
      ...(skillProblems.length ? { skillProblems } : {}),
    };
  }

  folder(agentId: string): string {
    return agentFolder(this.deps.dataDir, agentId);
  }

  /** B-044: sets (a folder home.ts accepts; relative = inside the workspace) or clears ('' / undefined) the home project in agent.json. */
  setHome(agentId: string, value: string | undefined): AgentHome | undefined {
    const agent = this.deps.org().require(agentId);
    if (!this.deps.paths || !isCoreFolderName(agentId)) throw new WorkforceError('conflict', 'This agent has no agent folder, so it cannot have a home project.');
    const dir = value === undefined ? undefined : this.homes.resolve(value);
    if (dir !== undefined && agent.archivedAt !== undefined) throw new WorkforceError('conflict', 'Restore this agent first.', { details: { id: agentId } });
    if (dir === this.homes.stored(agentId)) return this.homes.state(agentId);
    try { this.store.writeManifest(agent, { home: dir }); } catch (error) {
      this.deps.log.warn('agent.json not written', { agentId, error: String(error) });
      throw new WorkforceError('unavailable', 'The home project could not be saved: agent.json in the agent folder cannot be written.');
    }
    this.homes.forget(agentId);
    this.deps.bus.emit('agentCore.changed', { agentId });
    return this.homes.state(agentId);
  }

  // ---------------------------------------------------------------- internals

  /** A reconcile later: through the watcher's debounce (an editor's save settles first), else after the current work. */
  private later(agentId: string): void {
    if (this.offWatch && this.deps.root) { nudgeCore(this.deps.root, agentId); return; }
    if (this.scheduled.has(agentId)) return;
    this.scheduled.add(agentId);
    (this.deps.defer ?? ((run) => { setImmediate(run); }))(() => {
      this.scheduled.delete(agentId);
      try { this.reconcile(agentId); } catch (error) { this.deps.log.warn('agent folder not reconciled', { agentId, error: String(error) }); }
    });
  }

  /** A watcher an error stopped is armed again on the next use (RootWatcher.ensure: at most every REARM_MS, then every folder is checked once, debounced). */
  private ensureWatching(): void {
    if (this.offWatch) this.deps.root?.ensure();
  }

  private changed(agentId: string, change: CoreChange): void {
    const ids = agentId === '*' ? this.deps.org().list({ includeArchived: true }).map((agent) => agent.id) : [agentId];
    for (const id of ids) {
      if (change.system || change.all) this.reconcile(id);
      if ((change.manifest || change.all) && isCoreFolderName(id) && this.homes.reread(id)) this.deps.bus.emit('agentCore.changed', { agentId: id });
      if (!(change.skills || change.all) || !isCoreFolderName(id)) continue;
      const sig = mainSkillsSignature(this.deps.dataDir, id);
      const state = this.store.state(id);
      if (sig === state.skillsSig) continue;
      state.skillsSig = sig;
      this.deps.skills()?.invalidate?.(); // listeners that reload at once must see the change
      this.deps.bus.emit('skills.changed', {});
      this.deps.bus.emit('agentCore.changed', { agentId: id });
    }
  }
}
