// Loop and cost guard for agent-to-agent traffic in a chat (G11):
//  * rate limit: more than N agent messages per minute in one chat pauses agent-triggered wakes;
//  * ping-pong: two agents alternating M times with no human message or task change → pause;
//  * discussion (B-050 round 4: an agent's line in a group wakes the colleagues the responder pick names, so three
//    agents can talk in a circle that is no ping-pong): D changes of speaker among agents with no human message or
//    task change → the same pause. One agent talking alone changes no speaker and is never paused this way.
// A human message (or a task status change) clears the pause. Lifting a rate pause also starts
// a fresh one-minute window (else the very next reply would pause the chat again); without a
// pause the window keeps counting, so task lines are no way around the cost brake.
// Important brake (T10, ImportantBrake): more than 5 important messages of one author in one scope
// within 10 minutes count as normal; the first one over the limit says so once ('braking'), the
// rest until the window has room again stay quiet ('braked'). Scopes: a chat for important
// messages (chat/delivery.ts).
// Owns: in-memory counters per conversation (and per scope and author for the brake). Never: posts
// messages itself (delivery does).

export interface LoopGuardOptions {
  maxPerMinute?: number; // default 20
  pingPongTurns?: number; // default 8 alternating agent messages
  discussionTurns?: number; // default 12 changes of speaker among agents (Infinity: off)
}

interface State {
  times: number[]; // agent message timestamps in the last minute
  run: string[]; // agent authors since the last human message / task change (the newest ones)
  switches: number; // changes of speaker in that run
  loop?: string[]; // the agents of the loop that paused the chat
  paused?: 'rate' | 'ping_pong';
}

export class LoopGuard {
  private readonly states = new Map<string, State>();
  private readonly maxPerMinute: number;
  private readonly pingPongTurns: number;
  private readonly discussionTurns: number;

  constructor(options: LoopGuardOptions = {}) {
    this.maxPerMinute = options.maxPerMinute ?? 20;
    this.pingPongTurns = options.pingPongTurns ?? 8;
    this.discussionTurns = options.discussionTurns ?? 12;
  }

  /**
   * Records an agent message. Returns 'ok', or the reason the chat just became paused
   * ('rate' | 'ping_pong'), or 'paused' when it already was.
   */
  agentMessage(conversationId: string, agentId: string, at: number): 'ok' | 'rate' | 'ping_pong' | 'paused' {
    const state = this.state(conversationId);
    state.times = state.times.filter(time => at - time < 60_000);
    state.times.push(at);
    if (state.run.length && state.run[state.run.length - 1] !== agentId) state.switches++;
    state.run.push(agentId);
    if (state.run.length > this.pingPongTurns * 2) state.run.splice(0, state.run.length - this.pingPongTurns * 2);
    if (state.paused) return 'paused';
    if (state.times.length > this.maxPerMinute) return (state.paused = 'rate');
    if (isPingPong(state.run, this.pingPongTurns)) { state.loop = [...new Set(state.run.slice(-2))]; return (state.paused = 'ping_pong'); }
    if (state.switches >= this.discussionTurns) { state.loop = [...new Set(state.run)]; return (state.paused = 'ping_pong'); }
    return 'ok';
  }

  /** Human message or real task progress: agents may wake each other again. */
  reset(conversationId: string): void {
    const state = this.states.get(conversationId);
    if (!state) return;
    if (state.paused === 'rate') state.times = [];
    state.run = [];
    state.switches = 0;
    state.loop = undefined;
    state.paused = undefined;
  }

  paused(conversationId: string): boolean {
    return Boolean(this.states.get(conversationId)?.paused);
  }

  /** The agents of a detected loop – the two of a ping-pong, the voices of a discussion (for escalation to the lead). */
  pair(conversationId: string): string[] {
    const state = this.states.get(conversationId);
    return state?.loop ?? [...new Set(state?.run.slice(-2) ?? [])];
  }

  private state(id: string): State {
    let state = this.states.get(id);
    if (!state) this.states.set(id, (state = { times: [], run: [], switches: 0 }));
    return state;
  }
}

/** Last `turns` authors alternate between exactly two agents (A B A B …). */
function isPingPong(run: string[], turns: number): boolean {
  if (run.length < turns) return false;
  const tail = run.slice(-turns);
  if (new Set(tail).size !== 2) return false;
  return tail.every((author, index) => index === 0 || author !== tail[index - 1]);
}

export interface ImportantBrakeOptions {
  maxImportant?: number; // default 5 per author and chat
  windowMs?: number; // default 10 minutes
}

/** Rate brake for important messages (or urgent tasks) per (scope, author); see the header. */
export class ImportantBrake {
  private readonly states = new Map<string, { times: number[]; braked: boolean }>();
  readonly max: number;
  readonly windowMs: number;

  constructor(options: ImportantBrakeOptions = {}) {
    this.max = options.maxImportant ?? 5;
    this.windowMs = options.windowMs ?? 10 * 60_000;
  }

  /** Records an important message: 'ok' keeps it important; 'braking' (first over the limit) and 'braked' make it normal. */
  important(scope: string, authorId: string, at: number): 'ok' | 'braking' | 'braked' {
    const key = `${scope}\u0000${authorId}`;
    let state = this.states.get(key);
    if (!state) this.states.set(key, (state = { times: [], braked: false }));
    state.times = state.times.filter(time => at - time < this.windowMs);
    state.times.push(at);
    if (state.times.length <= this.max) { state.braked = false; return 'ok'; }
    if (state.braked) return 'braked';
    state.braked = true;
    return 'braking';
  }
}
