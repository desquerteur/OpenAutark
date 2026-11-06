// The wf terminal client (C7) without process wiring (that is wf.ts): parses the command line,
// finds the runtime (discover.ts), connects (client.ts), runs one command (commands.ts) and turns
// a failure into one short line on stderr (a JSON line with --json) and an exit code (errors.ts).
// Owns: help text, --timeout and Ctrl+C rules, output redaction of the owner token, and that no
// printed line carries raw control characters (format.ts terminalText/terminalJson).
// Never: exits the process, prints the token, or connects before the arguments were checked.

import { checkOptions, flag, parseArgs, text, timeoutMs, type Parsed } from './args.ts';
import { connect, type Rpc, type SocketFactory } from './client.ts';
import { COMMANDS, type Command, type Ctx, type Out } from './commands.ts';
import { PRODUCT_NAME, discover, type DiscoverEnv } from './discover.ts';
import { CliError, EXIT, asCliError, exitCodeOf } from './errors.ts';
import { terminalJson, terminalText } from './format.ts';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  stdin(): Promise<string>;
  env: DiscoverEnv;
  socket?: SocketFactory;
  /** Aborted on Ctrl+C. */
  interrupt: AbortSignal;
  now(): number;
  version: string;
}

export function usage(command?: string): string {
  const entry = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (entry) return `Usage: wf ${entry.usage}\n  ${entry.summary}\n`;
  return [
    `wf – control ${PRODUCT_NAME} from a terminal.`,
    '',
    'Usage: wf [--data <dir>] [--json] <command> [arguments] [options]',
    '',
    'Commands:',
    ...Object.values(COMMANDS).flatMap((item) => [`  ${item.usage}`, `      ${item.summary}`]),
    '',
    'Options:',
    '  --data <dir>  data dir of the app or headless runtime (default: this user\'s app data folder)',
    '  --json        machine-readable output: the runtime\'s JSON (one line per item when streaming)',
    '  --help        this help (wf help <command> for one command); --version prints the version',
    '',
    'Exit codes: 0 ok, 1 failed, 2 bad request, 3 forbidden, 4 not found, 5 runtime unreachable, 130 interrupted.',
    '',
  ].join('\n');
}

function checkArity(parsed: Parsed, command: Command): void {
  const [min, max] = command.arity;
  if (parsed.args.length < min || parsed.args.length > max) throw new CliError('bad_request', `Usage: wf ${command.usage}`);
}

/** Every printed line passes here: untrusted text (agents, external contacts) never drives the terminal. */
function output(io: CliIo, redact: (text: string) => string, json: boolean): Out {
  return {
    line: (line) => io.stdout(`${redact(terminalText(line))}\n`),
    lines: (lines) => { if (lines.length) io.stdout(`${redact(terminalText(lines.join('\n')))}\n`); },
    json: (value, pretty) => io.stdout(`${redact(terminalJson(JSON.stringify(value ?? null, null, pretty ? 2 : undefined)))}\n`),
    note: (line) => { if (!json) io.stderr(`${redact(terminalText(line))}\n`); },
  };
}

/** Rejects when `signal` aborts first: a timeout, or Ctrl+C. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal, timedOut: () => boolean, timeoutMessage = 'No answer before the timeout.'): Promise<T> {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timedOut() ? new CliError('timeout', timeoutMessage) : new CliError('interrupted', 'Interrupted.'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

interface Prepared { parsed: Parsed; command: Command; limitMs?: number }

/** Checks the whole command line before anything connects; a number is the exit code (help, version). */
function prepare(argv: readonly string[], io: CliIo): Prepared | number {
  const parsed = parseArgs(argv);
  if (flag(parsed, 'version')) { io.stdout(`wf ${io.version}\n`); return EXIT.ok; }
  if (parsed.command === 'help' || flag(parsed, 'help')) {
    io.stdout(usage(parsed.command === 'help' ? parsed.args[0] : parsed.command));
    return EXIT.ok;
  }
  if (!parsed.command) { io.stderr(usage()); return EXIT.badRequest; }
  const command = Object.hasOwn(COMMANDS, parsed.command) ? COMMANDS[parsed.command] : undefined;
  if (!command) throw new CliError('bad_request', `Unknown command "${parsed.command}". Run 'wf help' for the list.`);
  checkOptions(parsed, command.options);
  checkArity(parsed, command);
  command.check?.(parsed);
  return { parsed, command, limitMs: timeoutMs(parsed) ?? command.defaultTimeoutMs?.(parsed) };
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let redact = (line: string) => line;
  const end = argv.indexOf('--');
  const json = (end >= 0 ? argv.slice(0, end) : argv).includes('--json'); // known even when parsing fails
  const fail = (error: CliError): number => {
    const line = json ? terminalJson(JSON.stringify({ error: { code: error.kind, message: error.message } })) : terminalText(`wf: ${error.message}`);
    io.stderr(`${redact(line)}\n`);
    return exitCodeOf(error.kind);
  };

  let prepared: Prepared | number;
  try {
    prepared = prepare(argv, io);
  } catch (error) {
    return fail(asCliError(error));
  }
  if (typeof prepared === 'number') return prepared;
  const { parsed, command, limitMs } = prepared;

  const found = discover({ data: text(parsed, 'data') }, io.env);
  if (!found.ok) return fail(new CliError('unreachable', found.message));
  const { endpoint } = found;
  redact = (line) => endpoint.redact(line);

  const controller = new AbortController();
  let timedOut = false;
  const onInterrupt = () => controller.abort();
  if (io.interrupt.aborted) controller.abort();
  io.interrupt.addEventListener('abort', onInterrupt, { once: true });
  const timer = limitMs === undefined ? undefined : setTimeout(() => { timedOut = true; controller.abort(); }, limitMs);
  timer?.unref?.();
  let rpc: Rpc | undefined;
  try {
    const connecting = connect(endpoint, { socket: io.socket });
    connecting.then((late) => { if (controller.signal.aborted) late.close(); }, () => undefined); // opened after Ctrl+C/timeout
    rpc = await untilAborted(connecting, controller.signal, () => timedOut);
    const ctx: Ctx = {
      rpc, out: output(io, redact, json), parsed, json, signal: controller.signal, timedOut: () => timedOut, stdin: io.stdin, now: io.now,
    };
    const work = command.run(ctx);
    await (command.streams ? work : untilAborted(work, controller.signal, () => timedOut, command.timeoutMessage?.(parsed)));
    return EXIT.ok;
  } catch (error) {
    return fail(asCliError(error));
  } finally {
    if (timer) clearTimeout(timer);
    io.interrupt.removeEventListener('abort', onInterrupt);
    rpc?.close();
  }
}
