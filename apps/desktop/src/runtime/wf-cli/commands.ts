// The commands of the wf terminal client (C7): call, chats, read, send (B-050 K4: --important or
// --silent), todos, tasks, agents here; the streaming ones (watch, events, send --wait) in stream.ts;
// export and import of chat folders (B-050 K8) in chat-files.ts; the team's feedback mailbox (B-055:
// feedback setup | receive | status) in feedback.ts. Every command goes through the
// runtime's normal RPC with owner scope – the same methods and checks as the desktop window;
// nothing here skips a runtime rule.
// Owns: what each command calls and prints. Never: marks chats as read, retries a call, or
// prints params (they may hold keys the person typed).

import { randomUUID } from 'node:crypto';
import type { ConversationSummary, Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { TaskStatus, TaskView } from '../../shared/model/tasks.ts';
import { flag, integer, text, type Parsed } from './args.ts';
import type { Rpc } from './client.ts';
import { exportCommand } from './chat-files.ts';
import { feedbackCommand } from './feedback.ts'; // B-055: wf feedback setup | receive | status
import { CliError } from './errors.ts';
import { chatTitle, formatAgents, formatChats, formatMessage, formatMessages, formatTasks, formatTodos, namesOf } from './format.ts';
import { loadAgents, resolveChat } from './resolve.ts';
import { events, replyWaiter, watch } from './stream.ts';

export interface Out {
  line(text: string): void;
  lines(texts: readonly string[]): void;
  /** One JSON document; `pretty` indents it (human mode of `wf call`). */
  json(value: unknown, pretty?: boolean): void;
  /** A hint for people on stderr; nothing with --json. */
  note(text: string): void;
}

export interface Ctx {
  rpc: Rpc;
  out: Out;
  parsed: Parsed;
  json: boolean;
  /** Aborted by Ctrl+C or when --timeout passes. */
  signal: AbortSignal;
  timedOut(): boolean;
  stdin(): Promise<string>;
  now(): number;
}

export interface Command {
  usage: string;
  summary: string;
  options: readonly string[];
  /** Positional arguments after the command: [min, max]. */
  arity: readonly [number, number];
  /** Runs until Ctrl+C, --count or --timeout and ends cleanly then (watch, events). */
  streams?: boolean;
  defaultTimeoutMs?(parsed: Parsed): number | undefined;
  /** What a passed --timeout means for this command (default: no answer in time). */
  timeoutMessage?(parsed: Parsed): string | undefined;
  /** Checks arguments and option values before anything connects (throws a bad request). */
  check?(parsed: Parsed): void;
  run(ctx: Ctx): Promise<void>;
}

const METHOD = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
const ACTIVE: readonly TaskStatus[] = ['open', 'working', 'waiting', 'needs_you', 'blocked'];
const SEND_WAIT_MS = 300_000;
const NO_REPLY = 'No reply arrived before the timeout.';

function checkMethod(method: string): void {
  if (method.length > 80 || !METHOD.test(method)) throw new CliError('bad_request', `"${method}" is not a method name (for example chats.list).`);
}

/** --status values, or undefined; refused together with --all. */
function statuses(parsed: Parsed): string[] | undefined {
  const status = text(parsed, 'status')?.split(',').map((part) => part.trim()).filter(Boolean);
  if (status && flag(parsed, 'all')) throw new CliError('bad_request', 'Use either --status or --all.');
  if (status && !status.length) throw new CliError('bad_request', '--status needs at least one status.');
  return status;
}

function parseParams(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError('bad_request', 'The params are not valid JSON. Pass one JSON value, or - to read it from stdin.');
  }
}

const call: Command = {
  usage: 'call <method> [<json> | -]',
  summary: 'Call any runtime method with JSON params; prints the JSON result. wf call rpc.methods lists them with their params (\'{"match":"chat"}\' narrows it).',
  options: ['timeout'],
  arity: [1, 2],
  check: (parsed) => checkMethod(parsed.args[0]),
  async run(ctx) {
    const [method, raw] = ctx.parsed.args;
    checkMethod(method);
    const params = raw === undefined ? undefined : parseParams(raw === '-' ? await ctx.stdin() : raw);
    ctx.out.json(await ctx.rpc.call(method, params), !ctx.json);
  },
};

const chats: Command = {
  usage: 'chats [--all]',
  summary: 'List the chats (--all: team rooms and app chats too).',
  options: ['all'],
  arity: [0, 0],
  async run(ctx) {
    const [list, agents] = await Promise.all([
      ctx.rpc.call('chats.list', flag(ctx.parsed, 'all') ? { includeHidden: true } : undefined) as Promise<ConversationSummary[]>,
      loadAgents(ctx.rpc),
    ]);
    if (ctx.json) ctx.out.json(list);
    else ctx.out.lines(formatChats(list, namesOf(agents), ctx.now()));
  },
};

const read: Command = {
  usage: 'read <chat> [--limit n]',
  summary: 'Print the last messages of a chat (default 20, at most 200). <chat> is an id or a name.',
  options: ['limit'],
  arity: [1, 1],
  check: (parsed) => { integer(parsed, 'limit', 1, 200); },
  async run(ctx) {
    const limit = integer(ctx.parsed, 'limit', 1, 200) ?? 20;
    const { chat, name } = await resolveChat(ctx.rpc, ctx.parsed.args[0]);
    const messages = await ctx.rpc.call('messages.list', { conversationId: chat.id, limit }) as Message[];
    if (ctx.json) { ctx.out.json(messages); return; }
    ctx.out.line(`# ${chatTitle(chat, name)} (${chat.id})`);
    ctx.out.lines(formatMessages(messages, name, ctx.now()));
  },
};

const send: Command = {
  usage: 'send <chat> <text… | -> [--important | --silent] [--wait [--timeout s]]',
  summary: 'Send a message as you – run by an agent (AUTARK_AGENT_TOKEN), as that agent, into a chat it is a member of (@Name in the text mentions an agent). --silent posts it quietly: it wakes only the members it @mentions. --wait prints the first agent reply (default timeout 300 s).',
  options: ['important', 'silent', 'wait', 'timeout'],
  arity: [2, Number.POSITIVE_INFINITY],
  defaultTimeoutMs: (parsed) => (flag(parsed, 'wait') ? SEND_WAIT_MS : undefined),
  timeoutMessage: (parsed) => (flag(parsed, 'wait') ? NO_REPLY : undefined),
  check: (parsed) => {
    const words = parsed.args.slice(1);
    if (!(words.length === 1 && words[0] === '-') && !words.join(' ').trim()) throw new CliError('bad_request', 'Nothing to send.');
    if (flag(parsed, 'important') && flag(parsed, 'silent')) throw new CliError('bad_request', 'Use either --important or --silent.');
  },
  async run(ctx) {
    const [ref, ...words] = ctx.parsed.args;
    const body = words.length === 1 && words[0] === '-' ? await ctx.stdin() : words.join(' ');
    if (!body.trim()) throw new CliError('bad_request', 'Nothing to send.');
    const { chat, name } = await resolveChat(ctx.rpc, ref);
    const title = chatTitle(chat, name);
    // Subscribe before sending, so a fast reply is not missed.
    const waiter = flag(ctx.parsed, 'wait') ? await replyWaiter(ctx, chat.id) : undefined;
    const message = await ctx.rpc.call('messages.send', {
      conversationId: chat.id, body, priority: flag(ctx.parsed, 'important') ? 'important' : undefined, silent: flag(ctx.parsed, 'silent') || undefined, clientId: `wf-${randomUUID()}`,
    }) as Message;
    if (!waiter) {
      if (ctx.json) ctx.out.json(message);
      else ctx.out.line(`Sent to ${title} (${message.id}).`);
      return;
    }
    ctx.out.note(`Sent to ${title} (${message.id}). Waiting for a reply…`);
    const reply = await waiter.after(message.seq);
    if (ctx.json) ctx.out.json({ message, reply });
    else ctx.out.lines(formatMessage(reply, name, ctx.now()));
    if (reply.state !== 'final') throw new CliError('failed', reply.state === 'stopped' ? 'The reply was stopped.' : 'The reply failed.');
  },
};

const todos: Command = {
  usage: 'todos [--limit n]',
  summary: 'List your to-dos (the My day list): what is due now, then the "Later" ones – snoozed, a repeating timer until its next time, or a timer (widget.at) more than 12 h ahead. --json prints the runtime\'s list unsplit.',
  options: ['limit'],
  arity: [0, 0],
  check: (parsed) => { integer(parsed, 'limit', 1, 200); },
  async run(ctx) {
    const limit = integer(ctx.parsed, 'limit', 1, 200);
    const list = await ctx.rpc.call('todos.list', limit ? { limit } : undefined) as TaskView[];
    if (ctx.json) ctx.out.json(list);
    else ctx.out.lines(formatTodos(list, ctx.now()));
  },
};

const tasks: Command = {
  usage: 'tasks [--status s,…] [--all] [--limit n]',
  summary: `List tasks: unfinished ones by default (${ACTIVE.join(', ')}), --status picks statuses, --all lists every task.`,
  options: ['status', 'all', 'limit'],
  arity: [0, 0],
  check: (parsed) => { statuses(parsed); integer(parsed, 'limit', 1, 1000); },
  async run(ctx) {
    const status = statuses(ctx.parsed);
    const limit = integer(ctx.parsed, 'limit', 1, 1000);
    const filter = { status: status ?? (flag(ctx.parsed, 'all') ? undefined : [...ACTIVE]), limit };
    const [list, agents] = await Promise.all([ctx.rpc.call('tasks.list', filter) as Promise<TaskView[]>, loadAgents(ctx.rpc)]);
    if (ctx.json) ctx.out.json(list);
    else ctx.out.lines(formatTasks(list, namesOf(agents), ctx.now()));
  },
};

const agents: Command = {
  usage: 'agents [--all]',
  summary: 'List the agents (--all: archived ones too).',
  options: ['all'],
  arity: [0, 0],
  async run(ctx) {
    const all = await loadAgents(ctx.rpc);
    const list: Agent[] = flag(ctx.parsed, 'all') ? all : all.filter((agent) => !agent.archivedAt);
    if (ctx.json) ctx.out.json(list);
    else ctx.out.lines(formatAgents(list, namesOf(all)));
  },
};

export const COMMANDS: Readonly<Record<string, Command>> = { call, chats, read, send, watch, todos, tasks, agents, events, export: exportCommand, feedback: feedbackCommand };
