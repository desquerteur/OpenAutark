// Running split groups (B-057 S3/S7/S11/S12/S13/S16): a group starts when its parent's turn ends (startGroup) – parts
// without `after` are queued, the others wait; ready parts start on their own dispatcher lanes (pump →
// dispatcher.startSplit, at most SPLIT_LIMITS.runningPerAgent per agent; 'busy' or 'refused' leaves them queued until a
// lane frees – the dispatcher's onLaneFree calls pump again). A split is marked running (attempt counted) before
// startSplit, so a lane that ends at once still finds it running; an answer other than 'started' puts it back.
// A run's end (onRunEnd): done; put back without counting the attempt when it did not really run (reconcile.ts putBack)
// or when no account could run it (SplitRunEnd.wait – it waits for one, holds.ts, and pump skips it until it is due);
// queued again once for a retryable failure (SPLIT_LIMITS.attempts – after the ended attempt's lane is gone: turn-finish
// reports from inside it, its end pumps again); else failed or stopped. Then the group advances: ready parts are
// queued, parts building on one that did not end done are skipped (in cascade), an ended group settles (gather.ts).
// A part that ended for good (done, failed after its last attempt, stopped) releases its native session at once – its
// engine unloads it while the siblings still run (release.ts); the results are read from the run journal only. A part
// queued again keeps it (the retry resumes it); a skipped part never ran. An attempt after a restart's put-back gets
// reconcile.ts RESTART_NOTE in its input (restarted – noted at its start, read by service.inputFor; kept through a hold or
// put-back that did not really run, dropped once an attempt ran).
// Worktree parts (worktree: true): before their first start in this process their folder is opened – git checks
// first (canIsolate; a refusal fails that part with git's reason, create cannot wait for git) – and that folder is the
// turn's cwd; when the part ends (any way) its work is committed on its branch (finish) before it counts as ended.
// Stops (stop): the person's (or another agent's) stop of a group or of all its splits stops the group – no parent
// wake, its native sessions released (release.ts; again for a part whose lane ends later); the person's stop of one
// part, and the parent's own stop, let the group end normally (the parent gets the partial results). Running parts are
// aborted on their lane (dispatcher.stopSplit), waiting ones stopped (one whose work is being committed ends as it ran).
// Owns: those transitions, the in-process worktree folders and the per-agent cap. Never: runs a turn or changes results.

import { HUMAN_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { SPLIT_LIMITS, type Split, type SplitGroup, type SplitStatus } from '../../shared/model/splits.ts';
import type { Dispatcher } from '../contracts.ts';
import type { SplitRunEnd } from '../contracts/splits.ts';
import { BUSY_GROUPS, LIVE_SPLITS, isTerminal, type SplitCore } from './core.ts';
import { settle } from './gather.ts';
import { PUT_BACK, mayPutBack, putBack, putBackByRestart } from './reconcile.ts';
import { SplitHolds, WAIT_TEXT } from './holds.ts';

export const PERSON_STOPPED = 'Stopped by the person.';
export const SELF_STOPPED = 'Stopped by its main self.';
const ENDED: Partial<Record<SplitStatus, string>> = { failed: 'failed', stopped: 'was stopped', skipped: 'was skipped' };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class SplitRunner {
  private readonly core: SplitCore;
  private pumping = false;
  private again = false;
  /** Worktree parts whose folder is opening (still queued meanwhile) → their agent. */
  private readonly opening = new Map<string, string>();
  /** Worktree folders of parts opened in this process (their turns' cwd). */
  private readonly folders = new Map<string, string>();
  /** Worktree parts whose work is being committed (still running until that ends). */
  private readonly finishing = new Set<string>();
  /** Parts whose current attempt runs after a restart put them back (their input says so – reconcile.ts RESTART_NOTE). */
  private readonly restarts = new Set<string>();

  /** Parts waiting for an account (holds.ts): queued, not started before they are due. */
  readonly holds: SplitHolds;

  constructor(core: SplitCore) { this.core = core; this.holds = new SplitHolds(() => core.now(), () => this.pump()); }
  /** The worktree folder a part works in (opened in this process), else undefined. */
  folderOf(splitId: string): string | undefined { return this.folders.get(splitId); }
  /** A worktree step of this part is in flight (reconcile leaves it alone). */
  busy(splitId: string): boolean { return this.opening.has(splitId) || this.finishing.has(splitId); }
  /** Does the part's current attempt run because a restart put it back? */
  restarted(splitId: string): boolean { return this.restarts.has(splitId); }
  private dispatcher(): Dispatcher | undefined { try { return this.core.deps.dispatcher(); } catch { return undefined; } }
  private readonly lost = (error: unknown): void => { this.core.deps.log.error('split worktree step failed', { error: message(error) }); }; // never unhandled

  // ---------------------------------------------------------------- group transitions (no emit: the caller emits)
  /** The parent's turn ended: a pending group runs. */
  startGroup(groupId: string): void {
    const group = this.core.repo.getGroup(groupId);
    if (!group || group.status !== 'pending') return;
    this.core.repo.updateGroup(groupId, { status: 'running', startedAt: this.core.now() });
    this.advance(groupId);
  }

  /** A pending group that never starts: it and its splits are stopped with `reason`; how many splits. */
  stopPending(groupId: string, reason: string): number {
    const group = this.core.repo.getGroup(groupId);
    if (!group || group.status !== 'pending') return 0;
    let count = 0;
    const splits = this.core.repo.listSplits({ groupId });
    for (const split of splits) if (LIVE_SPLITS.includes(split.status)) { this.stopOne(split, reason); count++; }
    this.core.repo.updateGroup(groupId, { status: 'stopped', endedAt: this.core.now() });
    this.core.release(splits);
    return count;
  }

  /** Queues ready parts, skips those building on a part that did not end done (cascade), settles an ended group. */
  advance(groupId: string): boolean {
    const group = this.core.repo.getGroup(groupId);
    if (!group || group.status !== 'running') return false;
    const byIdx = new Map(this.core.repo.listSplits({ groupId }).map((split) => [split.idx, split]));
    const now = this.core.now();
    let moved = true;
    while (moved) {
      moved = false;
      for (const split of [...byIdx.values()]) {
        if (split.status !== 'pending') continue;
        const before = split.after.map((idx) => byIdx.get(idx)).filter((other): other is Split => other !== undefined);
        const blocker = before.find((other) => isTerminal(other.status) && other.status !== 'done');
        const patch = blocker
          ? { status: 'skipped' as const, endedAt: now, error: `Part #${blocker.idx}, which it builds on, ${ENDED[blocker.status] ?? blocker.status}.` }
          : before.every((other) => other.status === 'done') ? { status: 'queued' as const } : undefined;
        if (!patch) continue;
        const next = this.core.repo.updateSplit(split.id, patch);
        if (next) byIdx.set(next.idx, next);
        moved = true;
      }
    }
    return settle(this.core, groupId);
  }

  // ---------------------------------------------------------------- starting
  /** Starts ready parts while their agent has room and the dispatcher takes them (re-entrant calls run once more). */
  pump(): void {
    if (this.pumping) { this.again = true; return; }
    this.pumping = true;
    const changed = new Set<string>();
    try { do { this.again = false; this.pumpOnce(changed); } while (this.again); }
    catch (error) { this.core.deps.log.error('split pump failed', { error: message(error) }); }
    finally { this.pumping = false; }
    this.core.emit(changed);
  }

  private pumpOnce(changed: Set<string>): void {
    const dispatcher = this.dispatcher();
    if (!dispatcher?.startSplit) return; // no lanes (fakes, or not wired yet): parts wait
    const queued = this.core.repo.listSplits({ statuses: ['queued'] });
    if (!queued.length) return;
    const groups = new Map<string, SplitGroup | undefined>();
    const groupOf = (id: string) => (groups.has(id) ? groups.get(id) : groups.set(id, this.core.repo.getGroup(id)).get(id));
    const byAgent = new Map<string, Split[]>();
    for (const split of queued) (byAgent.get(split.agentId) ?? byAgent.set(split.agentId, []).get(split.agentId)!).push(split);
    for (const [agentId, list] of byAgent) {
      const lanes = this.core.repo.listSplits({ agentId, statuses: ['running'] }).filter((split) => !this.finishing.has(split.id)).length;
      let running = lanes + [...this.opening.values()].filter((id) => id === agentId).length;
      let onLane = new Set<string>(); // a retry waits until its ended attempt's lane is gone (see the header)
      try { onLane = new Set((dispatcher.splitLanes?.(agentId) ?? []).map((lane) => lane.splitId)); } catch { /* no lane listing */ }
      for (const split of list) {
        if (running >= SPLIT_LIMITS.runningPerAgent) break;
        if (this.opening.has(split.id) || onLane.has(split.id) || this.holds.waiting(split.id)) continue;
        const group = groupOf(split.groupId);
        if (!group || group.status !== 'running') continue;
        if (split.worktree && !this.folders.has(split.id)) { this.openFolder(split, group); running++; continue; }
        if (this.startOne(dispatcher, split) !== 'started') break; // busy or refused: this agent waits for a free lane
        running++;
        changed.add(split.groupId);
      }
    }
  }

  private startOne(dispatcher: Dispatcher, split: Split): 'started' | 'busy' | 'refused' {
    const attempts = split.attempts + 1;
    if (putBackByRestart(split.error)) this.restarts.add(split.id); // read by inputFor while the lane builds the turn; kept until an attempt really ran (onRunEnd)
    this.core.repo.updateSplit(split.id, { status: 'running', attempts, startedAt: split.startedAt ?? this.core.now(), error: undefined });
    let result: 'started' | 'busy' | 'refused';
    try { result = dispatcher.startSplit!({ agentId: split.agentId, splitId: split.id }); } catch (error) {
      this.core.deps.log.warn('split not started', { splitId: split.id, error: message(error) });
      result = 'refused';
    }
    if (result === 'started') return result;
    const now = this.core.repo.getSplit(split.id);
    if (now?.status === 'running' && now.attempts === attempts) this.core.repo.updateSplit(split.id, { status: 'queued', attempts: split.attempts, startedAt: split.startedAt, error: split.error });
    return result;
  }

  /** Opens a worktree part's own folder (git checks first), then pumps again; a refusal fails the part. */
  private openFolder(split: Split, group: SplitGroup): void {
    this.opening.set(split.id, split.agentId);
    const { worktrees } = this.core.deps;
    const open = async () => {
      const s = this.core.services();
      if (!s) throw new WorkforceError('unavailable', 'worktrees are not available here.');
      const reason = await worktrees.canIsolate(s, group.cwd ?? '');
      if (reason) throw new WorkforceError('conflict', reason);
      return worktrees.open(s, group, split);
    };
    open().then((opened) => {
      this.opening.delete(split.id);
      const now = this.core.repo.getSplit(split.id);
      if (now?.status === 'queued') { // not stopped meanwhile (a stopped part's folder is closed at the next open – git/split-worktree.ts)
        this.folders.set(split.id, opened.cwd);
        this.core.repo.updateSplit(split.id, { branch: { ...now.branch, name: opened.branch } });
        this.core.emit([split.groupId]);
      }
      this.pump();
    }, (error: unknown) => {
      this.opening.delete(split.id);
      const now = this.core.repo.getSplit(split.id);
      if (now?.status === 'queued') {
        const text = message(error);
        this.core.repo.updateSplit(split.id, { status: 'failed', endedAt: this.core.now(), error: text.startsWith('Part #') ? text : `Part #${split.idx} got no worktree: ${text}` });
        this.core.release([split]); // an attempt before a restart may have left one
        this.after(split.groupId);
      } else this.pump();
    }).catch(this.lost);
  }

  // ---------------------------------------------------------------- ending
  /** A split run ended (turn-finish of a split turn). */
  onRunEnd(splitId: string, end: SplitRunEnd): void {
    const split = this.core.repo.getSplit(splitId);
    if (!split) return;
    if (split.status !== 'running' || this.finishing.has(splitId)) {
      // Already ended (stopped while it ran) or a second report: its lane is done now – a worktree part's work is kept.
      if (isTerminal(split.status) && this.folders.has(splitId)) this.closeFolder(split);
      const group = this.core.repo.getGroup(split.groupId);
      if (isTerminal(split.status) || group?.status === 'stopped' || group?.status === 'gathered') this.core.release([split]); // its turn saved its session again
      this.after(split.groupId);
      return;
    }
    const now = this.core.now();
    const back = putBack(this.core, end) && mayPutBack(this.core, split); // did not really run: its attempt does not count
    // No account could run it (a limit or an outage): it waits for one without using its attempt (holds.ts).
    const held = !back && end.status === 'failed' && end.wait === true && end.retryable === true && this.holds.hold(splitId, this.accounts());
    if (back || held || (end.status !== 'done' && end.retryable && split.attempts < SPLIT_LIMITS.attempts)) {
      if (!back && !held) this.restarts.delete(splitId); // an ordinary retry: this attempt ran (a put-back or a hold keeps the restart note)
      this.core.repo.updateSplit(splitId, { status: 'queued', ...(back || held ? { attempts: Math.max(0, split.attempts - 1) } : {}),
        error: held ? WAIT_TEXT : end.error ?? (back ? PUT_BACK : 'The attempt failed; the part runs once more.') });
      this.after(split.groupId);
      return;
    }
    this.holds.clear(splitId); // it ended for good
    this.restarts.delete(splitId);
    this.core.release([split]); // nothing resumes its session: it leaves its engine now, while its siblings still run
    const outcome = end.status === 'done' ? { status: 'done' as const }
      : { status: end.status === 'stopped' ? 'stopped' as const : 'failed' as const, error: end.error ?? (end.status === 'stopped' ? 'Stopped.' : 'The part failed.') };
    if (this.folders.has(splitId)) { this.finishThenEnd(split, outcome); return; }
    this.core.repo.updateSplit(splitId, { status: outcome.status, endedAt: now, error: 'error' in outcome ? outcome.error : undefined });
    this.after(split.groupId);
  }

  /** A worktree part's work is committed on its branch (with its diff stat) before the part counts as ended (also at boot). */
  finishThenEnd(split: Split, outcome: { status: SplitStatus; error?: string }): void {
    this.finishing.add(split.id);
    this.commit(split).then(({ stat, failed }) => {
      this.finishing.delete(split.id);
      this.folders.delete(split.id);
      const now = this.core.repo.getSplit(split.id);
      if (now && !isTerminal(now.status)) {
        const lost = failed !== undefined && outcome.status === 'done';
        this.core.repo.updateSplit(split.id, {
          status: lost ? 'failed' : outcome.status, endedAt: this.core.now(),
          error: lost ? `Its work could not be committed on ${now.branch?.name ?? 'its branch'}: ${failed}` : outcome.error,
          ...(stat && now.branch ? { branch: { ...now.branch, stat } } : {}),
        });
      }
      this.core.release([split]); // a report while its work was committed may have saved its session again
      this.after(split.groupId);
    }).catch(this.lost);
  }

  /** A part that ended while it ran (stopped): its folder is committed and closed in the background. */
  private closeFolder(split: Split): void {
    this.folders.delete(split.id);
    this.commit(split).then(({ stat }) => {
      const now = this.core.repo.getSplit(split.id);
      if (stat && now?.branch) { this.core.repo.updateSplit(split.id, { branch: { ...now.branch, stat } }); this.core.emit([split.groupId]); }
    }).catch(this.lost);
  }

  private async commit(split: Split): Promise<{ stat?: string; failed?: string }> {
    const s = this.core.services();
    if (!s) return { failed: 'worktrees are not available here' };
    try { return await this.core.deps.worktrees.finish(s, split); } catch (error) {
      this.core.deps.log.warn('split worktree not finished', { splitId: split.id, error: message(error) });
      return { failed: message(error) };
    }
  }

  private after(groupId: string): void {
    this.advance(groupId);
    this.core.emit([groupId]);
    this.pump();
  }

  // ---------------------------------------------------------------- stopping
  /** Stops splits (see the header); an empty query: every pending or running group. Returns how many splits stopped. */
  stop(q: { splitId?: string; groupId?: string; agentId?: string; conversationId?: string; taskId?: string }, by: string, reason?: string): number {
    const targets: Array<{ group: SplitGroup; splits: Split[]; whole: boolean }> = [];
    if (q.splitId) {
      const split = this.core.repo.getSplit(q.splitId);
      const group = split && this.core.repo.getGroup(split.groupId);
      if (split && group) targets.push({ group, splits: [split], whole: false });
    } else {
      const groups = q.groupId
        ? [this.core.repo.getGroup(q.groupId)].filter((group): group is SplitGroup => group !== undefined)
        : this.core.repo.listGroups({ ...(q.agentId ? { agentId: q.agentId } : {}), ...(q.conversationId ? { conversationId: q.conversationId } : {}),
          ...(q.taskId !== undefined ? { taskId: q.taskId } : {}), statuses: BUSY_GROUPS }); // taskId: exactly the groups split on that task
      const splits = this.core.repo.listSplits({ groupIds: groups.map((group) => group.id) });
      for (const group of groups) targets.push({ group, splits: splits.filter((split) => split.groupId === group.id), whole: true });
    }
    let count = 0;
    const changed = new Set<string>();
    for (const { group, splits, whole } of targets) {
      if (group.status !== 'pending' && group.status !== 'running') continue; // ended: nothing to stop
      const self = by === group.agentId;
      const why = reason ?? (self ? SELF_STOPPED : by === HUMAN_ID ? PERSON_STOPPED : `Stopped by ${this.core.agentName(by)}.`);
      const live = splits.filter((split) => LIVE_SPLITS.includes(split.status) && !this.finishing.has(split.id));
      for (const split of live) { this.stopOne(split, why); count++; changed.add(group.id); }
      const ended = this.core.repo.listSplits({ groupId: group.id }).every((split) => isTerminal(split.status));
      // Nothing ran yet, or the person stopped the whole group: it ends without results. Otherwise it ends normally.
      if ((group.status === 'pending' && (whole || ended)) || (group.status === 'running' && whole && !self)) {
        this.core.repo.updateGroup(group.id, { status: 'stopped', endedAt: this.core.now() });
        this.core.release(this.core.repo.listSplits({ groupId: group.id }));
        changed.add(group.id);
      } else if (this.advance(group.id)) changed.add(group.id);
    }
    if (count) this.core.deps.log.info('splits stopped', { count, by: by === HUMAN_ID ? 'person' : by });
    this.core.emit(changed);
    this.pump();
    return count;
  }

  private accounts() { try { return this.core.services()?.accounts?.list() ?? []; } catch { return []; } }

  private stopOne(split: Split, why: string): void {
    this.holds.clear(split.id);
    try { if (split.status === 'running') this.dispatcher()?.stopSplit?.(split.id, 'human'); } catch (error) {
      this.core.deps.log.warn('split lane not stopped', { splitId: split.id, error: message(error) });
    }
    this.core.repo.updateSplit(split.id, { status: 'stopped', endedAt: this.core.now(), error: why });
    this.restarts.delete(split.id);
    if (split.status === 'running') return; // its lane's late end releases its session (onRunEnd)
    if (this.folders.has(split.id)) this.closeFolder(split); // opened, never started
    this.core.release([split]); // a waiting retry's session from its earlier attempt
  }
}
