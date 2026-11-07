// The dispatcher: turns due wakes into agent turns. Event-driven only – the scheduler
// announces due agents (onDueWakes: immediate wakes in a microtask batch, future ones from its
// single timer); after every turn the agent is pumped again. No polling.
//   pump(agent): claim due wakes → group by (chat, task) → drop stale message
//   groups → run the most important group, release the others → TurnExecutor.execute →
//   wakes done (released instead on shutdown/urgent abort) → idle → pump again → nothing ran: quiet pickup (K4).
// B-059: a data volume under 1 GB starts no turn – the wakes stay queued, freed space resumes the queue (system/disk-gate.ts).
// Guarantees: at most ONE running turn per agent on its main lane; at most `maxConcurrent` turns overall, with
// a FIFO of agents waiting for a slot (heavy engine slots are admitted by the supervisor).
// B-057 S12 (dispatch-lanes.ts): an agent's splits run on lanes of their own beside its main lane (startSplit – a free slot
// now or 'busy'; split lanes hold at most maxConcurrent − 1 slots – one stays for main lanes); every lane's end hands the
// slot to the FIFO first, then to waiting splits (onLaneFree); haltAll and stop() cover the lanes; interrupt() never stops a
// split (the person's Stop in a chat ends them through the split service – rpc/handlers/chats.ts messages.stop), but every
// person's Stop of a turn stops the groups it split that have not started, at once (split-stop.ts);
// urgent/steer/relay/continueNow and the quiet pickup address the main lane only.
// Important messages steer a running turn in that chat when the engine can, otherwise the
// running turn is interrupted (its wakes are kept) and that chat runs next. Such an interrupt waits
// for the turn's next tool boundary (dispatch-boundary.ts: no call doing work; one quiet line says so) – a call in flight, maybe an outside effect, is never cut mid-way;
// only the person's own Stop aborts at once. A normal message of the person in the chat of a running turn is folded into it
// when the engine can steer (steer(); else its queued wake runs the next turn). urgent() with a task id
// (continueNow() sends one for a task's turn; no task tool does since tasks/urgent.ts went) runs that task next and
// interrupts the agent's turn on less urgent work; a turn on that or another priority-2 task, or one serving the
// person's answer, finishes first. Picks run in the order named (dispatch-groups.ts nextGroup).
// D15: relay() hands a call's live-voice text to the running turn in that chat (dispatch-steer.ts steerRelay).
// B-048 E4.2: continueNow() – the agent's model.set now: its turn is cut at the next tool boundary the urgent
// way and its chat (task) runs again at once with a note, on the new route.
// Task groups carry their task's priority and due state into the order (taskFacts). The running
// turns, their abort kinds (human / urgent / shutdown) and wake settling: dispatch-runs.ts. stop() names
// the runs it cuts off in the journal (runs/journal.ts recordShutdownRuns), so the next start
// names their unknown effects (RC1); start() clears that list (a cancelled restart).
// The person's emergency stop (agents/work-stop.ts) halts: haltAll() aborts every running turn as the
// person's Stop and setHalted(true) starts no turn until it is lifted (independent of setPaused).
// B-050 K4: the idle moment – a turn ended and the hand-over started no other turn of that agent (nothing
// due) – lets the agent pick up a person's quiet lines it has not seen, and a colleague's quiet answer in a room
// of two agents (chat/quiet-pickup.ts: one 'review' wake per chat). Round 3: an agent with no turn running picks them up QUIET_DELAY_MS later too – when such a
// line arrives (quietArrived, from chat/delivery.ts), after start() and when it is un-paused – so a quiet line
// never waits for unrelated work; round 4: a colleague's quiet answer within seconds (pickUpQuiet's QUIET_ANSWER_DELAY_MS). Never after the person's Stop of that turn (until its next turn ends), while
// the dispatcher is paused or halted, for a paused (its lines wait for the un-pause) or archived
// agent, or one waiting for a slot.
// B-050 group cost: a group that only answers colleagues' still running turns (dispatch-groups.ts waitsFor: their
// lines, their tasks' results) goes back to the queue and the agent waits for those turns – when one ended,
// handOver() pumps it (event-driven, `awaiting`); an urgent pick never waits. A 'handoff' group of a finished task is
// settled without a turn, and one the agent already answered in its chat without it carries answeredNote.
// Linked PCs (owner 31.10.2026): an agent runs on its home PC – one whose home is another CEO PC starts no turn and no
// quiet pickup here; its due wakes go there (devices/sync/home.ts homeElsewhere, rows.ts hands them over).
// AF-001: an agent restarting itself (wake groups of only 'retry'/'review', model.set now) is limited per window; past the
// limit those groups wait out a cooldown, with a log entry and one chat line (restart-guard.ts). Messages are never held.
// Owns: when and what runs – pump gates, interrupt/urgent/stop, held (paused) agents, the idle moment (slot FIFO: dispatch-slots.ts).
// Never: runs two main-lane turns for one agent, drops wakes of a paused agent, or polls.

import type { Dispatcher, RuntimeServices, SplitLane } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import type { Task } from '../../shared/model/tasks.ts';
import {
  addPick, answeredNote, defaultMaxConcurrent, groupWakes, isStaleHandOver, isStaleMessageGroup, isUrgent, nextGroup, settleWithin, taskFacts,
  waitsFor, wakeIds, type UrgentPick, type WakeGroup,
} from './dispatch-groups.ts';
import { steerRelay, steerTurn } from './dispatch-steer.ts';
import { noteDeferred } from './dispatch-boundary.ts';
import { DiskGate } from '../system/disk-gate.ts'; // B-059 #20
import { LiveStatus } from './dispatch-live.ts';
import { abortTurn, RunningTurns, type RunEntry, type TurnDeps } from './dispatch-runs.ts';
import { SlotQueue } from './dispatch-slots.ts';
import { SplitLanes, splitSlots, type LaneStart } from './dispatch-lanes.ts'; // B-057
import { stopPendingSplits } from './split-stop.ts'; // B-057 S13
import { recordShutdownRuns } from '../runs/journal.ts';
import { pickUpQuiet, QUIET_DELAY_MS } from '../chat/quiet-pickup.ts';
import { homeElsewhere } from '../devices/sync/home.ts';
import { RestartGuard, automaticGroup, countRestart, holdRestarts, type RestartLimit } from './restart-guard.ts'; // AF-001

const SETTLE_MS = 5000;

export interface DispatcherDeps extends TurnDeps {
  /** Global cap of parallel turns (default clamp(cpus − 2, 2, 6)). */
  maxConcurrent?: number;
  /** B-059 #20: free bytes on the data volume (default fs.statfs; tests). */
  freeBytes?: (dir: string) => number | undefined;
  /** AF-001: how many automatic restarts an agent may make per window before a cooldown (restart-guard.ts; tests). */
  restartLimit?: Partial<RestartLimit>;
}

export class DispatcherImpl implements Dispatcher {
  private readonly deps: DispatcherDeps;
  private readonly maxConcurrent: number;
  private readonly runs: RunningTurns; // at most one running turn per agent on its main lane (B-057: plus its split lanes)
  private readonly lanes: SplitLanes; // B-057: the split lanes
  private readonly slots = new SlotQueue(); // agents waiting for a global slot (FIFO)
  private readonly held = new Set<string>(); // paused agents whose wakes (and quiet lines) wait for un-pause
  private readonly urgentPick = new Map<string, UrgentPick[]>(); // agent → chats (or tasks) that run next, in order
  private readonly stopped = new Set<string>(); // agents whose running turn the person stopped: no quiet pickup after it
  private readonly awaiting = new Map<string, Set<string>>(); // B-050: colleague → agents whose wakes wait for its running turn to end
  private readonly disk: DiskGate; // B-059 #20
  private readonly restarts: RestartGuard; // AF-001: automatic restarts per agent and window
  private readonly live: LiveStatus;
  private readonly unsubscribe: Array<() => void> = [];
  private started = false;
  private paused = false;
  private halted = false; // the person's emergency stop (work-stop.ts)

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    const cap = deps.maxConcurrent;
    this.maxConcurrent = cap !== undefined && Number.isFinite(cap) ? Math.max(1, Math.floor(cap)) : defaultMaxConcurrent();
    this.disk = new DiskGate(deps.services, () => queueMicrotask(() => this.resumeQueue()), deps.freeBytes);
    this.restarts = new RestartGuard(deps.restartLimit);
    this.live = new LiveStatus(deps.services, () => this.activity());
    this.runs = new RunningTurns(deps, this.live, (agentId, split) => this.handOver(agentId, split));
    this.lanes = new SplitLanes({
      services: deps.services, runs: this.runs,
      gate: () => (this.halted ? 'refused' : !this.started || this.paused || this.disk.blocked() ? 'busy' : 'ok'), // B-059 #20: no split starts on a full disk either
      slotFree: () => this.runs.lanes().length < splitSlots(this.maxConcurrent) && this.slots.tryAcquire(this.runs.size, this.maxConcurrent),
      hold: (agentId) => { this.held.add(agentId); },
    });
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    const services = this.deps.services();
    this.shutdownRuns(services, []); // running again here: nothing is cut off any more
    this.live.attach();
    // Immediate wakes (delivery → wakes.wake, due now) reach us through the scheduler's
    // wakes.onChange subscription in a microtask batch; future ones through its single timer.
    this.unsubscribe.push(services.scheduler.onDueWakes((agentIds) => { for (const id of agentIds) this.pump(id); }));
    this.unsubscribe.push(services.bus.on('agent.upserted', (agent) => this.onAgentChanged(agent)));
    for (const id of services.wakes.dueAgents()) this.pump(id);
    // K4 round 3: quiet lines still open from before the start – every agent not working now picks them up a little later.
    for (const agent of services.org.list()) if (!this.runs.has(agent.id)) this.idle(agent.id, QUIET_DELAY_MS);
    this.lanes.fire(); // B-057: splits that waited for the start (split service reconcile)
  }

  /** Stops pumping, interrupts running turns (their wakes go back to the queue), waits ≤ 5 s. */
  async stop(): Promise<void> {
    this.started = false;
    for (const off of this.unsubscribe.splice(0)) off();
    this.slots.drain();
    this.held.clear();
    this.awaiting.clear(); // their wakes stay queued: start() pumps every agent with due wakes
    const entries = this.runs.entries();
    if (entries.length) this.shutdownRuns(this.deps.services(), entries.map((entry) => entry.runId));
    for (const entry of entries) abortTurn(entry, 'The runtime is shutting down.', 'shutdown', 'release');
    await settleWithin(entries.map((entry) => entry.finished), SETTLE_MS);
  }

  private shutdownRuns(services: RuntimeServices, runIds: string[]): void {
    try { recordShutdownRuns(services, runIds); } catch (error) {
      services.log.warn('cut-off runs not recorded', { runs: runIds.length, error: String(error) });
    }
  }

  /** Holds new turns (e.g. before an update restart); running turns continue. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.resumeQueue();
  }

  /** The person's emergency stop: no new turn while halted; lifting it runs what waited (work-stop.ts). */
  setHalted(halted: boolean): void {
    this.halted = halted;
    if (!halted) this.resumeQueue();
  }

  /** Aborts every running turn at once as the person's Stop; its runs, and when they ended (≤ 5 s). */
  haltAll(reason: string): { runIds: string[]; settled: Promise<void> } {
    const entries = this.runs.entries();
    for (const entry of entries) this.personStop(entry, reason);
    return { runIds: entries.map((entry) => entry.runId), settled: settleWithin(entries.map((entry) => entry.finished), SETTLE_MS) };
  }

  private resumeQueue(): void {
    if (!this.started || this.paused || this.halted) return;
    // Agents that waited for a slot keep their FIFO order, then everyone else with due wakes.
    for (const id of [...this.slots.drain(), ...this.deps.services().wakes.dueAgents()]) this.pump(id);
    this.lanes.fire(); // B-057: then the splits that waited
  }

  // ------------------------------------------------------------------ control

  /** Stops the agent's main-lane turn (in that chat). B-057: never its splits – the person's Stop in a chat ends those itself (messages.stop). */
  async interrupt(agentId: string, conversationId?: string): Promise<void> {
    const entry = this.runs.get(agentId);
    if (!entry || (conversationId && entry.conversationId !== conversationId)) return;
    this.personStop(entry, 'The turn was stopped.');
    await settleWithin([entry.finished], SETTLE_MS);
  }

  /** Stops one run by id (RPC runs.cancel); false when it is not running here. */
  async cancelRun(runId: string): Promise<boolean> {
    const entry = this.runs.byRunId(runId);
    if (!entry) return false;
    this.personStop(entry, 'The turn was stopped.');
    await settleWithin([entry.finished], SETTLE_MS);
    return true;
  }

  /** The person's Stop of a running turn; its end is no idle moment for the quiet pickup. */
  private personStop(entry: RunEntry, reason: string): void {
    if (this.runs.get(entry.agentId) === entry) this.stopped.add(entry.agentId);
    abortTurn(entry, reason, 'human');
    stopPendingSplits(this.deps.services(), entry); // B-057 S13: the groups this turn split never start (split-stop.ts)
  }

  /** Important message – or, with `taskId`, a task made urgent (T10): that chat (task) runs next. */
  async urgent(agentId: string, conversationId: string, taskId?: string): Promise<void> {
    const services = this.deps.services();
    const entry = this.runs.get(agentId);
    const live = entry && !entry.controller.signal.aborted ? entry : undefined;
    if (taskId && live?.taskId === taskId) return; // already working on it
    if (!taskId && live?.conversationId === conversationId && live.control.engine?.steer) {
      if (await steerTurn(services, live, conversationId, () => this.runs.get(agentId) === live)) return;
    }
    // No steer: this chat (task) runs next, after the ones named before; an interrupted turn keeps its
    // wakes for later. The task's own wake comes from the task service, a message needs the chat's wake.
    this.urgentPick.set(agentId, addPick(this.urgentPick.get(agentId), taskId ? { conversationId, taskId } : { conversationId }));
    if (!taskId) services.wakes.wake({ agentId, reason: 'message', conversationId, coalesceKey: `chat:${conversationId}` });
    const current = this.runs.get(agentId);
    if (!current && this.started && this.runs.size >= this.maxConcurrent) {
      this.slots.toFront(agentId); // waiting for a global slot: important work goes to the front of the FIFO
    }
    // Interrupt other work: a turn that started in this chat while we tried to steer already reads
    // the new message; urgent task work cuts off only less urgent work (yields).
    const overtaken = taskId ? current !== undefined && this.yields(services, current, taskId) : current === entry || current?.conversationId !== conversationId;
    if (current && overtaken && !current.controller.signal.aborted) {
      // At the turn's next tool boundary: a call in flight is never cut mid-way (dispatch-boundary.ts).
      const reason = taskId ? 'Interrupted by urgent work.' : 'Interrupted by an important message.';
      const before = current.boundary.deferred;
      // Never after the person's Stop or a shutdown (abortTurn also drops it): that turn's work must not come back.
      if (current.boundary.at(() => { if (!current.controller.signal.aborted) abortTurn(current, reason, 'urgent', 'release'); })) await settleWithin([current.finished], SETTLE_MS);
      else if (!taskId && !before) noteDeferred(services, agentId, conversationId);
    }
  }

  /** A normal message in the chat of the agent's running turn: steered in when its engine can (read at its next step); false = the queued wake runs next turn. */
  async steer(agentId: string, conversationId: string): Promise<boolean> {
    const entry = this.runs.get(agentId);
    if (!entry || entry.controller.signal.aborted || entry.conversationId !== conversationId || !entry.control.engine?.steer) return false;
    return steerTurn(this.deps.services(), entry, conversationId, () => this.runs.get(agentId) === entry);
  }

  /** D15: a live voice's relay text into the agent's running turn in this chat (calls/talker.ts, dispatch-steer.ts steerRelay); false = not steered. */
  async relay(agentId: string, conversationId: string, text: string, mode: 'now' | 'next'): Promise<boolean> {
    const entry = this.runs.get(agentId);
    if (!entry || entry.controller.signal.aborted || entry.conversationId !== conversationId) return false;
    return steerRelay(this.deps.services(), entry, text, mode, () => this.runs.get(agentId) === entry && !entry.controller.signal.aborted);
  }

  /**
   * B-048 E4.2 – model.set now: the run ends at its next tool boundary like an urgent interrupt (its wakes
   * are kept) and its chat (task) runs next with `note`, on the route the request set. Called by a tool
   * of that very turn, so it never waits for the cut; a turn that ends first drops it (nothing is woken).
   */
  continueNow(agentId: string, runId: string, note: string): boolean {
    const entry = this.runs.get(agentId);
    if (!entry || entry.runId !== runId || entry.controller.signal.aborted || !entry.conversationId) return false;
    if (this.restarts.holdUntil(agentId, this.deps.services().clock.now()) !== undefined) return false; // AF-001: cooling down – the new model takes the next turn
    const conversationId = entry.conversationId;
    entry.boundary.at(() => {
      if (entry.controller.signal.aborted || this.runs.get(agentId) !== entry) return;
      const services = this.deps.services();
      countRestart(services, this.restarts, agentId, conversationId); // AF-001: a restart the agent asked for itself
      this.urgentPick.set(agentId, addPick(this.urgentPick.get(agentId), entry.taskId ? { conversationId, taskId: entry.taskId } : { conversationId }));
      services.wakes.wake({ agentId, reason: entry.reason, conversationId, taskId: entry.taskId, note, coalesceKey: `model-now:${conversationId}:${entry.taskId ?? ''}` });
      abortTurn(entry, 'Continuing on the requested model.', 'urgent', 'release');
    });
    return true;
  }

  /** Whether a running turn gives way to urgent task work: not one on that or another priority-2 task, or serving the person's answer or approval. */
  private yields(services: RuntimeServices, entry: RunEntry, taskId: string): boolean {
    if (entry.taskId === taskId || entry.reason === 'answer' || entry.reason === 'approval') return false;
    return !entry.taskId || this.taskOf(services, entry.taskId)?.priority !== 2;
  }

  activity(): AgentActivity[] { return this.runs.activity(); }

  /** K4 round 3: a person's quiet line (or a colleague's quiet answer) reached chats of these agents (chat/delivery.ts) – one with no turn running picks it up QUIET_DELAY_MS later (an answer: QUIET_ANSWER_DELAY_MS, chat/quiet-pickup.ts). */
  quietArrived(agentIds: readonly string[]): void {
    for (const id of agentIds) if (!this.runs.has(id)) this.idle(id, QUIET_DELAY_MS); // a running turn's end is the idle moment
  }

  /** Hook for ToolRegistryOptions: a call of that run started or ended (by call id, dispatch-boundary.ts). */
  setCall(ctx: { agentId: string; runId: string; callId: string }, running: boolean): void { this.runs.setCall(ctx, running); }

  // ------------------------------------------------------------------ B-057 split lanes (dispatch-lanes.ts)

  startSplit(input: { agentId: string; splitId: string }): LaneStart { return this.lanes.start(input); }
  splitLanes(agentId?: string): SplitLane[] { return this.lanes.list(agentId); }
  stopSplit(splitId: string, why: 'human' | 'shutdown'): boolean { return this.lanes.stop(splitId, why); }
  onLaneFree(listener: () => void): () => void { return this.lanes.onFree(listener); }

  // ------------------------------------------------------------------ pump

  /** Starts the next turn of an agent when it has due wakes and a slot; true when started. */
  pump(agentId: string): boolean {
    if (!this.started || this.paused || this.halted || this.runs.has(agentId)) return false;
    const services = this.deps.services();
    try {
      if (homeElsewhere(services, agentId)) return false; // its home PC runs it: the wakes stay unclaimed for the hand-over
      if (this.disk.blocked()) return false; // B-059 #20: disk almost full – the wakes wait unclaimed (no hold, no slot FIFO)
      if (this.runs.size >= this.maxConcurrent) {
        if (!this.slots.has(agentId) && services.wakes.pending(agentId) > 0) this.slots.push(agentId);
        return false;
      }
      return this.pumpNow(services, agentId);
    } catch (error) {
      services.log.error('dispatcher pump failed', { agentId, error: String(error) });
      return false;
    }
  }

  private pumpNow(services: RuntimeServices, agentId: string): boolean {
    let agent = services.org.get(agentId);
    if (!agent || agent.archivedAt) {
      const dropped = services.wakes.claim(agentId);
      if (dropped.length) {
        services.wakes.done(dropped.map((wake) => wake.id));
        services.log.info('wakes dropped', { agentId, count: dropped.length, reason: agent ? 'archived' : 'missing' });
      }
      return false;
    }
    if (agent.status === 'paused') {
      this.held.add(agentId); // paused by the human or a manager: wakes wait (onAgentChanged)
      return false;
    }

    const wakes = services.wakes.claim(agentId);
    if (!wakes.length) return false;
    const groups = groupWakes(wakes);
    const stale = groups.filter((group) => isStaleMessageGroup(services.chats, agentId, group) || isStaleHandOver(group, (id) => this.taskOf(services, id)?.status));
    if (stale.length) services.wakes.done(wakeIds(stale));
    const picks = this.urgentPick.get(agentId);
    // B-050: what only answers colleagues' running turns goes back unannounced (release without a due time) until they end.
    const waiting = groups.filter((group) => !stale.includes(group) && this.waitsForColleagues(services, agentId, group, picks));
    if (waiting.length) services.wakes.release(wakeIds(waiting), undefined, true);
    // AF-001: while the agent cools down after too many automatic restarts, those groups wait (restart-guard.ts).
    const live = holdRestarts(services, this.restarts, agentId, groups.filter((group) => !stale.includes(group) && !waiting.includes(group)));
    taskFacts(live, (id) => this.taskOf(services, id), services.clock.now());
    const { group, left } = nextGroup(live, picks);
    if (left.length) this.urgentPick.set(agentId, left);
    else this.urgentPick.delete(agentId);
    if (!group) return false;
    const rest = live.filter((item) => item !== group);
    if (rest.length) services.wakes.release(wakeIds(rest), undefined, true);
    const answered = answeredNote(services.chats, agentId, group);
    if (answered) group.aware = { text: answered, at: services.clock.now() };
    if (automaticGroup(group)) countRestart(services, this.restarts, agentId, group.conversationId); // AF-001
    this.runs.start(services, agent, group);
    return true;
  }

  /** B-050 group cost: true when the group only answers colleagues' running turns – the agent then waits for their hand-over (never an urgent pick). */
  private waitsForColleagues(services: RuntimeServices, agentId: string, group: WakeGroup, picks: UrgentPick[] | undefined): boolean {
    if (picks?.some((pick) => isUrgent(group, pick))) return false;
    const colleagues = waitsFor(services.chats, agentId, group, this.runs.entries());
    for (const id of colleagues) this.awaiting.set(id, (this.awaiting.get(id) ?? new Set<string>()).add(agentId));
    return colleagues.length > 0;
  }

  /** The task a group works on, for its priority, due state and – stale hand-overs – status (a failed read counts as normal work). */
  private taskOf(services: RuntimeServices, id: string): Pick<Task, 'priority' | 'dueAt' | 'status'> | undefined {
    try { return services.tasks.get(id); } catch { return undefined; }
  }

  /** A turn of `agentId` ended and its wakes are settled (dispatch-runs.ts): who gets the freed slot. B-057: a split lane's slot goes to the FIFO, then to waiting splits. */
  private handOver(agentId: string, split?: boolean): void {
    if (split) { this.serveWaiting(); this.lanes.fire(); return; }
    // An agent interrupted by an important message keeps its slot for that chat; otherwise the
    // freed slot goes to the agent that waited longest and this agent queues behind it.
    const urgent = this.urgentPick.has(agentId);
    const stopped = this.stopped.delete(agentId);
    const answering = this.awaiting.get(agentId); // B-050: the colleagues its turn wrote to answer now
    this.awaiting.delete(agentId);
    if (urgent) this.pump(agentId);
    this.serveWaiting();
    for (const id of answering ?? []) this.pump(id);
    if (!urgent) this.pump(agentId);
    this.lanes.fire(); // B-057: what the agents left of the slots goes to waiting splits
    if (!stopped && !this.runs.has(agentId)) this.idle(agentId);
  }

  /** Free slots go to the agents waiting in the FIFO, longest first. */
  private serveWaiting(): void {
    while (this.slots.size && this.runs.size < this.maxConcurrent && this.started && !this.paused && !this.halted) this.pump(this.slots.shift()!);
  }

  /** K4: the agent finished and nothing is due for it – the person's quiet lines it has not seen get a review wake (chat/quiet-pickup.ts), `delayMs` later. */
  private idle(agentId: string, delayMs = 0): void {
    if (!this.started || this.paused || this.halted || this.held.has(agentId) || this.slots.has(agentId)) return;
    const services = this.deps.services();
    try {
      const agent = services.org.get(agentId);
      if (homeElsewhere(services, agentId)) return; // its home PC picks up its quiet lines
      if (agent && !agent.archivedAt && agent.status !== 'paused') pickUpQuiet(services, agentId, delayMs);
      else if (agent && !agent.archivedAt) this.held.add(agentId); // paused: its quiet lines wait for the un-pause (onAgentChanged)
    } catch (error) {
      services.log.warn('quiet pickup failed', { agentId, error: String(error) });
    }
  }

  // ------------------------------------------------------------------ events

  /** Un-paused agents get their held wakes. */
  private onAgentChanged(agent: Agent): void {
    if (!this.started) return;
    const id = agent.id;
    if (this.held.has(id) && (agent.status !== 'paused' || agent.archivedAt)) {
      this.held.delete(id);
      queueMicrotask(() => { if (!this.pump(id) && !this.runs.has(id)) this.idle(id, QUIET_DELAY_MS); this.lanes.fire(); }); // B-057: its waiting splits too
    }
  }
}
