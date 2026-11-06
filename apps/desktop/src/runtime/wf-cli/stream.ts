// The streaming parts of the wf terminal client (C7): `wf watch <chat>` (final messages and status
// lines of one chat – agents' notices about the person's edits and deletes are skipped, with --json
// too, so --count counts only lines the person sees, C6), `wf events <topic…>` (every pushed event
// of the topics, those notices included) and the reply wait of `wf send --wait`. All of it is
// event-driven: one events.subscribe, then the pushed frames.
// Owns: when a stream ends – Ctrl+C or --timeout (exit 0), --count reached (exit 0), --count not
// reached in time (timeout), the runtime going away (unreachable). Never: polls or re-reads lists.

import type { Topic } from '../../shared/api/protocol.ts';
import type { Message, MessageState } from '../../shared/model/chat.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';
import { integer, type Parsed } from './args.ts';
import type { Command, Ctx } from './commands.ts';
import { CliError } from './errors.ts';
import { chatTitle, formatEvent, formatMessage, namesOf } from './format.ts';
import { loadAgents, resolveChat, resolveTopics } from './resolve.ts';

const MAX_COUNT = 1_000_000;
const ENDED: ReadonlySet<MessageState> = new Set(['final', 'failed', 'stopped']);
const MESSAGE_EVENTS = new Set(['message.created', 'message.updated']);
/** Recent messages read when a watch starts: those already ended are not printed again. */
const WATCH_RECENT = 50;

const shownKey = (message: Message) => `${message.id}:${message.state}:${message.editedAt ?? ''}`;

/**
 * Calls `handle` for every pushed event until the stream ends; `handle` returns true when it
 * printed something. `ready` is the stderr hint shown once the subscription is live; `prime`
 * runs right after subscribing (so nothing falls between a read and the subscription).
 */
export async function follow(ctx: Ctx, topics: Topic[], ready: string, handle: (event: string, data: unknown) => boolean, prime?: () => Promise<void>): Promise<void> {
  const count = integer(ctx.parsed, 'count', 1, MAX_COUNT);
  let printed = 0;
  /** Set the moment the stream ends: frames of the same burst (dispatched synchronously) print nothing more. */
  let stopped = false;
  let resolveDone: () => void = () => {};
  let rejectDone: (error: unknown) => void = () => {};
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => undefined); // a late failure after the end must not become an unhandled rejection
  const finish = () => { stopped = true; resolveDone(); };
  const fail = (error: unknown) => { stopped = true; rejectDone(error); };
  const off = ctx.rpc.onEvent((event, data) => {
    if (stopped) return;
    try {
      if (handle(event, data) && count !== undefined && ++printed >= count) finish();
    } catch (error) { fail(error); }
  });
  const onAbort = () => {
    if (count !== undefined && ctx.timedOut()) fail(new CliError('timeout', `${printed} of ${count} arrived before the timeout.`));
    else finish();
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  void ctx.rpc.lost.then(fail);
  try {
    await ctx.rpc.call('events.subscribe', { topics });
    await prime?.();
    ctx.out.note(ready);
    if (ctx.signal.aborted) onAbort();
    await done;
  } finally {
    off();
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** --count is checked before connecting. */
export function checkCount(parsed: Parsed): void {
  integer(parsed, 'count', 1, MAX_COUNT);
}

/**
 * Subscribes to a chat before `wf send` sends; `after(seq)` then resolves with the first agent
 * text message after that seq once it is final, failed or stopped.
 */
export async function replyWaiter(ctx: Ctx, conversationId: string): Promise<{ after(seq: number): Promise<Message> }> {
  const ended: Message[] = [];
  let changed: () => void = () => {};
  const off = ctx.rpc.onEvent((event, data) => {
    if (!MESSAGE_EVENTS.has(event)) return;
    const message = data as Message;
    if (message.conversationId !== conversationId || message.authorKind !== 'agent' || message.kind !== 'text' || !ENDED.has(message.state)) return;
    ended.push(message);
    changed();
  });
  try {
    await ctx.rpc.call('events.subscribe', { topics: [`chat:${conversationId}`] });
  } catch (error) {
    off();
    throw error;
  }
  return {
    after(seq) {
      return new Promise<Message>((resolve, reject) => {
        const stop = (error?: unknown, message?: Message) => {
          off();
          ctx.signal.removeEventListener('abort', onAbort);
          if (message) resolve(message); else reject(error);
        };
        const onAbort = () => stop(ctx.timedOut() ? new CliError('timeout', 'No reply arrived before the timeout.') : new CliError('interrupted', 'Interrupted.'));
        changed = () => {
          const reply = ended.find((message) => message.seq > seq);
          if (reply) stop(undefined, reply);
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        void ctx.rpc.lost.then((error) => stop(error));
        if (ctx.signal.aborted) onAbort(); else changed();
      });
    },
  };
}

export const watch: Command = {
  usage: 'watch <chat> [--count n] [--timeout s]',
  summary: 'Print new final messages and status lines of a chat until Ctrl+C (or n messages, or s seconds).',
  options: ['count', 'timeout'],
  arity: [1, 1],
  streams: true,
  check: checkCount,
  async run(ctx) {
    const { chat, name } = await resolveChat(ctx.rpc, ctx.parsed.args[0]);
    /** Message states already on screen (or ended before the watch): a re-pushed final message stays quiet; an edit shows. */
    const shown = new Set<string>();
    const prime = async () => {
      const recent = await ctx.rpc.call('messages.list', { conversationId: chat.id, limit: WATCH_RECENT }) as Message[];
      for (const message of recent) if (ENDED.has(message.state)) shown.add(shownKey(message));
    };
    await follow(ctx, [`chat:${chat.id}`], `Watching ${chatTitle(chat, name)} (${chat.id}). Press Ctrl+C to stop.`, (event, data) => {
      if (!MESSAGE_EVENTS.has(event)) return false;
      const message = data as Message;
      if (message.conversationId !== chat.id || isAgentNotice(message) || !ENDED.has(message.state) || shown.has(shownKey(message))) return false; // C6: no agents' edit notices
      shown.add(shownKey(message));
      if (ctx.json) ctx.out.json(message);
      else ctx.out.lines(formatMessage(message, name, ctx.now()));
      return true;
    }, prime);
  },
};

export const events: Command = {
  usage: 'events <topic…> [--count n] [--timeout s]',
  summary: 'Print pushed events until Ctrl+C. Topics: chats, tasks, org, providers, system, chat:<chat>, runs:<agent>, browser:<agent>.',
  options: ['count', 'timeout'],
  arity: [1, 64],
  streams: true,
  check: checkCount,
  async run(ctx) {
    const agents = await loadAgents(ctx.rpc);
    const topics = await resolveTopics(ctx.rpc, ctx.parsed.args, agents);
    const name = namesOf(agents);
    await follow(ctx, topics, `Listening to ${topics.join(', ')}. Press Ctrl+C to stop.`, (event, data) => {
      if (ctx.json) { ctx.out.json({ event, data }); return true; }
      const line = formatEvent(event, data, name, ctx.now());
      if (line === undefined) return false;
      ctx.out.line(line);
      return true;
    });
  },
};
