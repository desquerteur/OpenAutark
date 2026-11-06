// A scripted Claude Code CLI for engine tests: `auth status --json`, the status probe (initialize +
// get_usage control requests) and `-p` turns speaking stream-json, plus the engine wiring with
// in-memory files and a fake account home.
// Owns: nothing in production. Never imported by src/; never starts a real binary, never touches
// the person's home (every account home is a fake path, every file stays in memory).

import { ClaudeEngine } from '../../../src/runtime/engines/claude/engine.ts';
import { account, fakeFinder, fakeSpawn, memoryFiles, testSupervisor, tick, type SpawnCall } from './fakes.ts';

export type CallKind = 'status' | 'probe' | 'turn';

export interface ClaudeScript {
  /** `claude auth status --json` (default: signed in through claude.ai). */
  status?: { code?: number; json: Record<string, unknown> | string };
  /** The initialize payload; 'error' = an error response (older CLI), 'crash' = the probe exits without answering. */
  init?: Record<string, unknown> | 'error' | 'crash';
  /** The get_usage payload (default: an error response). */
  usage?: Record<string, unknown>;
  /** Lines a turn writes after its first user message (after system/init); default: one successful result. */
  turn?: (call: SpawnCall, session: string) => unknown[];
  /** The turn process exits after its lines (default true); an interrupt always ends it. */
  exit?: boolean;
  /** B-049: a turn process whose arguments this accepts exits at once with code 1 and no line (a CLI refusing a flag). */
  refuse?: (args: string[]) => boolean;
}

/** Only the probe runs in safe mode (helper turns also pass --no-session-persistence, X08). */
export const kindOf = (args: string[]): CallKind => (args.includes('auth') ? 'status' : args.includes('--safe-mode') ? 'probe' : 'turn');

const valueAfter = (args: string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

export function claudeCli(script: ClaudeScript = {}) {
  const fake = fakeSpawn((call) => {
    const { child } = call;
    const kind = kindOf(call.args);
    if (kind === 'status') {
      const status: { code?: number; json: Record<string, unknown> | string } = script.status ?? { json: { loggedIn: true, authMethod: 'claude.ai', email: 'person@example.test', subscriptionType: 'max' } };
      setImmediate(() => { child.stdout.write(typeof status.json === 'string' ? status.json : JSON.stringify(status.json)); setImmediate(() => child.exit(status.code ?? 0)); });
      return;
    }
    if (kind === 'probe') {
      child.stdin.once('end', () => setImmediate(() => child.exit(0))); // like the CLI: its input ended, it quits (login guard 03.11.)
      child.onLine = (message) => {
        if (message?.type !== 'control_request') return;
        if (script.init === 'crash') { child.exit(1); return; }
        const payload = message.request?.subtype === 'initialize' ? script.init : message.request?.subtype === 'get_usage' ? script.usage : undefined;
        child.send({
          type: 'control_response',
          response: payload && payload !== 'error' ? { subtype: 'success', request_id: message.request_id, response: payload } : { subtype: 'error', request_id: message.request_id, error: 'Unsupported request' },
        });
      };
      return;
    }
    if (script.refuse?.(call.args)) { setImmediate(() => child.exit(1)); return; }
    const session = valueAfter(call.args, '--resume') ?? valueAfter(call.args, '--session-id') ?? '';
    let started = false;
    child.onLine = (message) => {
      if (message?.type === 'control_request' && message.request?.subtype === 'interrupt') {
        child.send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Request interrupted by user', session_id: session });
        setImmediate(() => child.exit(0));
        return;
      }
      if (message?.type !== 'user' || started) return;
      started = true;
      child.send({ type: 'system', subtype: 'init', session_id: session });
      const lines = script.turn?.(call, session) ?? [{ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session }];
      for (const line of lines) child.send(line);
      if (script.exit !== false) setImmediate(() => child.exit(0));
    };
  });
  return { ...fake, of: (kind: CallKind) => fake.calls.filter((call) => kindOf(call.args) === kind) };
}

export const TEMP = '/fake-temp/workforce';
/** Only these reach the CLI; the API key must be stripped (it would override the subscription login). */
export const BASE_ENV: NodeJS.ProcessEnv = { PATH: '/fake-bin', ANTHROPIC_API_KEY: 'not-a-real-key' };

export const claudeAccount = (patch: Record<string, unknown> = {}) => {
  const id = (patch.id as string | undefined) ?? 'acc_claude';
  return account({ id, provider: 'claude', label: 'Claude', home: `/fake-homes/claude/${id}`, ...patch });
};

/** Engine over the scripted CLI with in-memory files; `clock` drives the probe throttle. */
export function claudeSetup(script: ClaudeScript = {}, options: { installed?: boolean } = {}) {
  const cli = claudeCli(script);
  const memory = memoryFiles();
  const clock = { now: 1_800_000_000_000 };
  let n = 0;
  const engine = new ClaudeEngine({
    supervisor: testSupervisor(cli.spawn), finder: fakeFinder({ claude: options.installed === false ? null : '/fake-bin/claude' }),
    tempDir: TEMP, files: memory.files, env: BASE_ENV, now: () => clock.now,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  return { engine, cli, clock, ...memory };
}

/** Waits (event-loop turns, no timer) until `done()` holds. */
export async function until(done: () => boolean, turns = 100): Promise<void> {
  for (let i = 0; i < turns && !done(); i++) await tick();
}
