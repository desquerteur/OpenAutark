// Per-agent folder state of the agent core (wave 3; agent-core/service.ts decides what wins). SYSTEM.md is
// one text document of the data folder (runtime/root/text-doc.ts – B-044): its read cache (one stat per
// check, the file read again only when its signature changed), the app's own atomic writes (told to the
// data folder watcher, remembered by signature so a later look at them is no outside edit), a replaced
// problem file kept once as SYSTEM.rejected.md, and its quiet notice, which reaches the agent view as
// 'agentCore.changed'. Also agent.json (written with the folder, following renames – also after a restart,
// as found on disk – and keeping its `home`, B-044).
// Owns: this state and these file operations. Never: edits agents, reads other folders, or polls.

import type { Bus } from '../bus.ts';
import type { Clock, Logger } from '../contracts.ts';
import type { AgentCoreNotice, AgentCoreProblem } from '../../shared/model/agent-core.ts';
import type { Agent } from '../../shared/model/org.ts';
import { QuietNotice, type TextNotice } from '../root/notice.ts';
import { TextDoc, writeAtomic, type OwnWrites } from '../root/text-doc.ts';
import { isCoreFolderName, manifestFile, manifestText, readManifest, SYSTEM_LIMITS, systemFile, systemText, type SystemRead } from './layout.ts';
import { NOTICES } from './info.ts';
import { homeOf } from './home.ts';

/** The kept problem file (text-doc.ts rejectedPath of SYSTEM.md). */
export const REJECTED_FILE = 'SYSTEM.rejected.md';

export interface FolderState {
  /** The quiet notice as agents.core shows it (kept in step with the folder's notice, see noticed()). */
  notice?: AgentCoreNotice;
  skillsSig?: string;
  /** agent.json as written or found on disk (undefined: none yet). */
  manifest?: string;
}

export interface FolderStoreDeps {
  dataDir: string;
  bus: Pick<Bus, 'emit'>;
  clock: Clock;
  log: Logger;
  /** The data folder watcher, told about every write (absent: nobody is told). */
  writes?: OwnWrites;
}

export class FolderStore {
  private readonly deps: FolderStoreDeps;
  private readonly states = new Map<string, FolderState>();
  private readonly docs = new Map<string, TextDoc<AgentCoreProblem>>();
  /** Notices of ids that cannot name a folder (no SYSTEM.md holds them). */
  private readonly loose = new Map<string, QuietNotice<AgentCoreProblem>>();

  constructor(deps: FolderStoreDeps) {
    this.deps = deps;
  }

  state(agentId: string): FolderState {
    let state = this.states.get(agentId);
    if (!state) { state = {}; this.states.set(agentId, state); }
    return state;
  }

  forget(agentId: string): void {
    this.states.delete(agentId);
    this.docs.delete(agentId);
    this.loose.delete(agentId);
  }

  /** SYSTEM.md now: one stat, the file read again only when its signature changed. */
  check(agentId: string): SystemRead {
    return this.doc(agentId).check();
  }

  /** check() that never throws (an error reads as 'unreadable'). */
  safeCheck(agentId: string): SystemRead {
    try { return this.check(agentId); } catch { return { kind: 'problem', problem: 'unreadable', sig: 'error' }; }
  }

  /** True when `read` is not the app's own last write of SYSTEM.md (nor an outside edit already taken over). */
  isOutside(agentId: string, read: SystemRead): boolean {
    return this.doc(agentId).isOutside(read);
  }

  /** An outside edit was taken over: the file with `sig` counts as known. */
  adopt(agentId: string, sig: string): void {
    this.doc(agentId).adopt(sig);
  }

  write(agentId: string, text: string): void {
    this.doc(agentId).write(text);
  }

  /** agent.json + SYSTEM.md from the cache; false (and a notice) when the folder cannot be written. */
  writeFolder(agent: Agent): boolean {
    try {
      this.writeManifest(agent);
      this.write(agent.id, systemText(agent.instructions));
      return true;
    } catch (error) {
      this.deps.log.warn('agent folder not written', { agentId: agent.id, error: String(error) });
      this.setNotice(agent.id, 'unwritable');
      return false;
    }
  }

  /** agent.json; B-044: its `home` (agent-core/home.ts) as `set` gives it, else as the file holds it now – a rename keeps it, an edit on disk too. */
  writeManifest(agent: Agent, set?: { home?: string }): void {
    const file = manifestFile(this.deps.dataDir, agent.id);
    const text = manifestText(agent, set ? set.home : homeOf(readManifest(file)));
    writeAtomic(file, text, this.deps.writes);
    this.state(agent.id).manifest = text;
  }

  /** What agent.json holds on disk, read once per run (reconcile: after a restart a rename must still replace it). */
  knownManifest(agentId: string): string | undefined {
    const state = this.state(agentId);
    state.manifest ??= readManifest(manifestFile(this.deps.dataDir, agentId));
    return state.manifest;
  }

  tryManifest(agent: Agent): void {
    try { this.writeManifest(agent); } catch (error) { this.deps.log.debug('agent.json not updated', { agentId: agent.id, error: String(error) }); }
  }

  /** agent.json follows a rename (status updates change nothing in it; a folder not reconciled yet is left to reconcile). */
  refreshManifest(agent: Agent): void {
    const state = this.states.get(agent.id);
    if (!state?.manifest || state.manifest === manifestText(agent, homeOf(state.manifest)) || !isCoreFolderName(agent.id)) return;
    this.tryManifest(agent);
  }

  /** A problem file the app replaces is kept once (an older kept copy goes). */
  keepRejected(agentId: string): void {
    try { this.doc(agentId).keepRejected(); } catch { /* nothing to keep */ }
  }

  setNotice(agentId: string, problem: AgentCoreProblem | undefined): void {
    this.quiet(agentId).set(problem);
  }

  private doc(agentId: string): TextDoc<AgentCoreProblem> {
    let doc = this.docs.get(agentId);
    if (!doc) {
      doc = new TextDoc<AgentCoreProblem>({
        file: systemFile(this.deps.dataDir, agentId), limits: SYSTEM_LIMITS, clock: this.deps.clock, writes: this.deps.writes,
        onNotice: (notice) => this.noticed(agentId, notice),
      });
      this.docs.set(agentId, doc);
    }
    return doc;
  }

  private quiet(agentId: string): QuietNotice<AgentCoreProblem> {
    if (isCoreFolderName(agentId)) return this.doc(agentId).notices;
    let notice = this.loose.get(agentId);
    if (!notice) {
      notice = new QuietNotice<AgentCoreProblem>(this.deps.clock, (next) => this.noticed(agentId, next));
      this.loose.set(agentId, notice);
    }
    return notice;
  }

  /** The quiet notice hook: the agent view's notice text, a log line when one comes, 'agentCore.changed'. */
  private noticed(agentId: string, notice: TextNotice<AgentCoreProblem> | undefined): void {
    this.state(agentId).notice = notice ? { problem: notice.problem, text: NOTICES[notice.problem], at: notice.at } : undefined;
    if (notice) this.deps.log.warn('agent folder notice', { agentId, problem: notice.problem });
    this.deps.bus.emit('agentCore.changed', { agentId });
  }
}
