// Claude Code native fork (B-057 S4a): a split starts as its parent – `claude -p --resume <parent> --fork-session
// --session-id <new uuid>` copies the parent's conversation into a new session with an id the app chooses; the parent's
// transcript stays as it is. Read from the 2.1.303 CLI (not run live): "--session-id can only be used with --continue or
// --resume if --fork-session is also specified"; with --fork-session and --resume <another id> a --session-id that exists
// already is refused ("Session ID … is already in use") – so the flags go only on the fork's first turn.
// fork() only reserves the new id: the engine keeps the pending fork in this process and the first turn on its ref resumes
// the parent with the fork flags (engine.ts run, target()). Claude Code replays the recorded system prompt on a resumed
// session, so the split's identity travels in the user message (<workforce-context>, as on every resume).
// Where the parent resumes from: a `project:` ref by its id in the app's own home's fixed project folder (the fork lands
// there too: its ref keeps the prefix); a transcript path as it is (while it exists); a plain id by that id when the split
// runs in the folder the parent's turns ran in (this process saw it), else by the absolute path of the CLI's transcript of
// that id (<home>/projects/<folder>/<id>.jsonl, found by listing folder names – Claude Code finds a session id only in the
// project folder of the cwd, e.g. not from a split's worktree); none found → fork() throws (the split falls back).
// The parent's transcript must exist before a fork is reserved (a Forget or a purge may have removed it): a project: ref's
// file in the app home's project folder, a same-folder plain id's file in the account home (when the account names its
// home – else the CLI finds it by the cwd); a missing one throws, so the split falls back to the ledger or text instead of
// a first turn that fails and starts fresh.
// A pending fork ends once the CLI took it (it reported the new id, or answered at all – also an error, e.g. the parent is
// gone: that turn reports the session ended); a turn that never reached the CLI keeps it; deleting its ref drops it. A
// restart forgets it: the first turn then cannot resume the new id, the session is reported ended and renewed (the split
// loses the parent's context).
// Owns: the pending forks and where a parent resumes from. Never: reads a file of a home (folder names and file sizes
// only), writes into one, or touches the parent's transcript.

import * as path from 'node:path';
import type { EngineForkInput, EngineForkResult } from '../types.ts';
import { sameFolder } from '../shared.ts';
import { PROJECT_DIR_NAME, PROJECT_REF, isTranscriptPath, resumeTarget, type RebuildFiles } from './rebuild.ts';

/** Pending forks kept per process (the oldest go first beyond this). */
const MAX_PENDING = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a turn resumes a session ref: resumeTarget()'s answer, plus `fork` – the new session id on a fork's first turn. */
export type ResumeAt = ReturnType<typeof resumeTarget> & { fork?: string };

interface PendingFork { resume: string; env: Record<string, string>; sessionId: string }

export interface ClaudeForksDeps {
  /** The rebuilder's file operations (folder names and sizes: the disk unless the engine's FileOps give them). */
  files: () => Pick<RebuildFiles, 'folders' | 'size'>;
  uuid: () => string;
}

export class ClaudeForks {
  private readonly deps: ClaudeForksDeps;
  private readonly pending = new Map<string, PendingFork>(); // the fork's ref → where its parent resumes from

  constructor(deps: ClaudeForksDeps) {
    this.deps = deps;
  }

  /** Reserves a fork of `input.parentRef`; `ranIn`: the folder the parent's turns ran in, when this process saw one. */
  async fork(input: EngineForkInput, ranIn: string | undefined): Promise<EngineForkResult> {
    const sessionId = this.deps.uuid();
    const parent = input.parentRef;
    const home = input.account.home;
    if (parent.startsWith(PROJECT_REF)) {
      const target = resumeTarget(parent);
      const file = home ? path.join(home, 'projects', PROJECT_DIR_NAME, `${target.resume}.jsonl`) : undefined;
      if (!file || (await this.deps.files().size(file)) === undefined) throw new Error("the parent session's transcript is gone");
      return this.keep(`${PROJECT_REF}${sessionId}`, { resume: target.resume, env: target.env, sessionId });
    }
    if (isTranscriptPath(parent)) {
      if ((await this.deps.files().size(parent)) === undefined) throw new Error("the parent session's transcript is gone");
      return this.keep(sessionId, { resume: parent, env: {}, sessionId });
    }
    if (ranIn !== undefined && input.cwd !== undefined && sameFolder(ranIn, input.cwd)) {
      if (home && !(await this.transcriptOf(home, parent))) throw new Error("the parent session's transcript is gone");
      return this.keep(sessionId, { resume: parent, env: {}, sessionId });
    }
    const file = await this.transcriptOf(home, parent);
    if (!file) throw new Error("the parent session's transcript was not found in this account's home");
    return this.keep(sessionId, { resume: file, env: {}, sessionId });
  }

  /** The session `ref` is deleted (engine.deleteSession): a fork still pending on it never runs. */
  drop(ref: string): void {
    this.pending.delete(ref);
  }

  /** How a turn on `ref` resumes: a pending fork's parent with the new id, else as resumeTarget() says. */
  target(ref: string): ResumeAt {
    const fork = this.pending.get(ref);
    return fork ? { resume: fork.resume, env: fork.env, fork: fork.sessionId } : resumeTarget(ref);
  }

  /** After a turn on `ref`: the fork is no longer pending once the CLI reported its id or answered (`answered`). */
  settle(ref: string | undefined, reported: string | undefined, answered: boolean): void {
    const fork = ref ? this.pending.get(ref) : undefined;
    if (fork && (answered || reported === fork.sessionId)) this.pending.delete(ref!);
  }

  /** The CLI's own transcript of session `id` in `home` (projects/<folder>/<id>.jsonl, by folder names); undefined when none. */
  private async transcriptOf(home: string | undefined, id: string): Promise<string | undefined> {
    if (!home || !UUID.test(id)) return undefined;
    const projects = path.join(home, 'projects');
    for (const folder of await this.deps.files().folders(projects)) {
      const file = path.join(projects, folder, `${id}.jsonl`);
      if ((await this.deps.files().size(file)) !== undefined) return file;
    }
    return undefined;
  }

  private keep(ref: string, fork: PendingFork): EngineForkResult {
    this.pending.delete(ref);
    this.pending.set(ref, fork);
    if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    return { ref, generation: 1 };
  }
}
