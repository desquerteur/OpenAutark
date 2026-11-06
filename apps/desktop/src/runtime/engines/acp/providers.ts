// Plan CLIs on the generic ACP engine (PR8): Gemini CLI (Google sign-in), GitHub Copilot CLI and –
// B-044 – Kimi Code (the Kimi membership). One table per CLI: its executable; the ACP launch flag or
// subcommand, read once per executable from its own `--help` (else the known form: `gemini
// --experimental-acp`, `copilot --acp`, `kimi acp`); its sign-in – Gemini CLI through ACP
// authenticate with its Google method (the CLI opens the browser), Copilot CLI with its own /login
// and Kimi Code with `kimi login` (OAuth device code) in a visible terminal (accounts/sign-in.ts);
// and the status probe (ACP initialize + session/new in the neutral folder: the engine's account
// check, and probeSignedIn for detection in a short-lived process). Gemini CLI and Copilot CLI have
// no home variable Workforce could verify, so each keeps one sign-in per PC in its default home;
// Kimi Code's documented KIMI_CODE_HOME (default ~/.kimi-code) gives each added account its own
// home like CODEX_HOME (`home`; a login found in the default home is adopted as for Codex).
// A CLI may read its own project settings in the turn's folder (.gemini/settings.json, Kimi Code's .kimi-code/…) –
// the agent's folder, like every engine's own configuration there. Gemini CLI's launches set its API-key
// and Vertex AI variables empty (GOOGLE_SIGN_IN_ONLY), so a plan account is meant to use only its
// Google sign-in and not bill per use – one more point for the live check.
// B-049 F3 – "our system prompt only, minimal built-in tools", per CLI as far as its docs go (28.10.2026; none of
// the three is installed here, nothing is verified live). Each flag goes only to a CLI whose own `--help` lists
// it (`lean`), so an older CLI starts as before; whether a flag also acts in ACP mode is part of the live check.
// - Gemini CLI: GEMINI_SYSTEM_MD=<file> replaces the whole built-in system prompt ("a full replacement, not a
//   merge"): ACP_SYSTEM_PROMPT, written once into the app's prompt folder (AcpLaunchDeps.promptDir; nothing
//   without it); `--allowed-mcp-server-names workforce` keeps only our hub. Not done: tools.core/tools.exclude,
//   skills.enabled, hooksConfig.enabled and context settings exist only as settings.json keys (a system-defaults
//   file via GEMINI_CLI_SYSTEM_DEFAULTS_PATH would be the way, not built); `-e none` is not in Google's docs;
//   whether GEMINI.md memory is still appended to a replaced prompt is not documented.
// - Copilot CLI: `--no-custom-instructions` (AGENTS.md, CLAUDE.md, GEMINI.md, .github/instructions, ~/.copilot
//   instructions), `--disable-builtin-mcps` (github-mcp-server), `--no-ask-user`, `--excluded-tools=` the built-ins
//   outside the core (COPILOT_EXCLUDED_TOOLS; shell, view/create/edit/apply_patch, glob/grep stay). Not possible:
//   replacing its system prompt (no documented option); `--available-tools` is not used (its effect on MCP tools is
//   undocumented).
// - Kimi Code: `kimi acp` documents no option (--agent-file, --skills-dir belong to the main command), so nothing
//   is passed. Possible later: `$KIMI_CODE_HOME/SYSTEM.md` "fully replaces" the main agent's prompt (and without
//   ${agents_md}/${skills} no AGENTS.md or skill list) – a file in the account's own home, not written today.
// Owns: the table, the launch args from --help, the AcpResolver and the choice of sign-in method.
// Never: reads the CLIs' home or token files, passes provider API keys (childEnv strips them),
// installs a CLI, starts one in the process cwd or the workspace, writes into a CLI home, or passes a flag
// the CLI's `--help` does not list (apart from the known ACP form).

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { Account, ProviderId } from '../../../shared/model/providers.ts';
import type { Supervisor } from '../../system/supervisor.ts';
import type { CliId, Executable, ExecutableFinder } from '../../accounts/executables.ts';
import { runCli } from '../../accounts/cli.ts';
import { childEnv } from '../codex/server.ts';
import { AcpProcess, type AcpLaunch } from './process.ts';
import { isAuthError, type AuthMethod } from './protocol.ts';
import { HUB } from './updates.ts';
import { isRecord, str } from '../shared.ts';
import { WorkforceError } from '../../../shared/errors.ts';

export type AcpPlanProvider = 'gemini-cli' | 'copilot' | 'kimi-cli';

export interface AcpProviderSpec {
  provider: AcpPlanProvider;
  /** The executable (ExecutableFinder id). */
  cli: Extract<CliId, 'gemini' | 'copilot' | 'kimi'>;
  name: string;
  /** ACP flags (or a subcommand such as `acp`), preferred first: the first one the CLI's `--help` lists is used, else `fallback`. */
  flags: string[];
  fallback: string;
  /** 'acp': ACP authenticate with the first method `method` matches; 'terminal': the CLI's own sign-in in a window. */
  signIn: 'acp' | 'terminal';
  method?: RegExp;
  /** Variables every launch of the agent sets (its detection probe included). */
  env?: Readonly<Record<string, string>>;
  /** The variable that points the CLI at an account's own home (isolated accounts, cli-homes.ts); none = one sign-in per PC. */
  home?: string;
  /** B-049 F3: launch options that cut the CLI's own context and tools, each only when the CLI's `--help` lists its flag. */
  lean?: readonly LeanFlag[];
  /** B-049 F3: the variable that replaces the CLI's whole built-in system prompt with a file (ACP_SYSTEM_PROMPT). */
  systemPromptEnv?: string;
}

/** A documented launch option; `flag` must appear in the CLI's own `--help`, else the launch stays as it was (no refusal possible). */
export interface LeanFlag { flag: string; args: readonly string[] }

/**
 * B-049 F3: the system prompt a plan CLI gets instead of its own (one file per CLI, the same for every session of
 * its process): the agent's real instructions travel in each session's first prompt (engine.ts).
 */
export const ACP_SYSTEM_PROMPT = [
  'I am an agent of Autark.',
  'The first message of a session carries my identity, rules and task in a <workforce-instructions> block and the current context in a <workforce-context> block: they are my system instructions.',
  'Later messages can bring a new <workforce-context> block; it replaces the earlier one.',
  'I work with the tools this session offers.',
].join('\n');

/** Copilot CLI's built-in tools outside the execution core (docs.github.com cli-command-reference, 28.10.2026). */
export const COPILOT_EXCLUDED_TOOLS: readonly string[] = ['web_fetch', 'task', 'list_agents', 'read_agent', 'write_agent', 'skill'];

/**
 * Gemini CLI set up for an API key or Vertex AI (Application Default Credentials) bills per use, so
 * a plan account would spend money as if free. Its launches set the key and the Vertex AI selection
 * empty: childEnv only removes the keys, and the CLI fills only unset variables from its own .env
 * files (~/.gemini/.env, ~/.env, folders above its cwd) – to confirm in the live check. A CLI set up
 * that way then asks for the Google sign-in. GOOGLE_CLOUD_PROJECT stays (a Code Assist licence's
 * Google sign-in needs it).
 */
export const GOOGLE_SIGN_IN_ONLY: Readonly<Record<string, string>> = {
  GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GOOGLE_GENAI_USE_VERTEXAI: '', GOOGLE_APPLICATION_CREDENTIALS: '', GOOGLE_CLOUD_LOCATION: '',
};

export const ACP_PROVIDERS: Readonly<Record<AcpPlanProvider, AcpProviderSpec>> = {
  'gemini-cli': {
    provider: 'gemini-cli', cli: 'gemini', name: 'Gemini CLI', flags: ['--acp', '--experimental-acp'], fallback: '--experimental-acp',
    signIn: 'acp', method: /oauth|google/i, env: GOOGLE_SIGN_IN_ONLY,
    // B-049 F3: only our hub among MCP servers (no user or extension server); GEMINI_SYSTEM_MD: "a full replacement, not a merge".
    lean: [{ flag: '--allowed-mcp-server-names', args: ['--allowed-mcp-server-names', HUB] }], systemPromptEnv: 'GEMINI_SYSTEM_MD',
  },
  copilot: {
    provider: 'copilot', cli: 'copilot', name: 'Copilot CLI', flags: ['--acp'], fallback: '--acp', signIn: 'terminal',
    // B-049 F3: no AGENTS.md/CLAUDE.md/copilot-instructions, no built-in GitHub MCP server, no ask_user, no tools outside the core.
    lean: [
      { flag: '--no-custom-instructions', args: ['--no-custom-instructions'] },
      { flag: '--disable-builtin-mcps', args: ['--disable-builtin-mcps'] },
      { flag: '--no-ask-user', args: ['--no-ask-user'] },
      { flag: '--excluded-tools', args: [`--excluded-tools=${COPILOT_EXCLUDED_TOOLS.join(',')}`] },
    ],
  },
  // kimi.com/code/docs: `kimi acp` (JSON-RPC on stdio), `kimi login` (device code, exit 0/1), KIMI_CODE_HOME.
  // B-049 F3: `kimi acp` documents no option; --agent-file/--skills-dir belong to the main command, so none is passed.
  'kimi-cli': { provider: 'kimi-cli', cli: 'kimi', name: 'Kimi Code', flags: ['acp'], fallback: 'acp', signIn: 'terminal', home: 'KIMI_CODE_HOME' },
};

/** The variables that point an ACP plan CLI at the account's own home (none for its default home or a CLI without one). */
export function acpHomeEnv(account: Pick<Account, 'provider' | 'home'>): Record<string, string> {
  const variable = acpProvider(account.provider)?.home;
  return variable && account.home ? { [variable]: account.home } : {};
}

export function acpProvider(provider: ProviderId): AcpProviderSpec | undefined {
  return Object.hasOwn(ACP_PROVIDERS, provider) ? ACP_PROVIDERS[provider as AcpPlanProvider] : undefined;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listedIn = (help: string, flag: string) => new RegExp(`(?<![\\w-])${escaped(flag)}(?![\\w-])`).test(help);

/**
 * The ACP flag a CLI's `--help` lists (preferred first; `--acp` never matches inside `--experimental-acp`), else the
 * known form; then (B-049 F3) each lean option whose flag that `--help` lists.
 */
export function acpArgs(spec: AcpProviderSpec, help: string): string[] {
  const listed = spec.flags.find((flag) => listedIn(help, flag));
  return [listed ?? spec.fallback, ...(spec.lean ?? []).filter((lean) => listedIn(help, lean.flag)).flatMap((lean) => lean.args)];
}

/** The sign-in among the agent's ACP methods that `spec.method` names – never an API key or Vertex AI method. */
export function signInMethod(spec: AcpProviderSpec, methods: readonly AuthMethod[]): AuthMethod | undefined {
  if (!spec.method) return undefined;
  return methods.find((method) => {
    const text = `${method.id} ${method.name}`;
    return spec.method!.test(text) && !/api[\s_-]?key|vertex/i.test(text);
  });
}

export interface AcpLaunchDeps {
  finder: ExecutableFinder;
  supervisor: Supervisor;
  /** The neutral folder `--help` runs in (the empty engine folder or the app temp), never the process cwd. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * B-049 F3: a folder of the app's own (never a workspace or a CLI home) for the replacement system prompt
   * files (`<provider>-system.md`); without it no CLI's built-in prompt is replaced.
   */
  promptDir?: string;
  /** Writes such a file, creating its folder (the disk, mode 0600, when not given). */
  writeFile?: (file: string, text: string) => Promise<void>;
}

const writeOwnFile = async (file: string, text: string) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, { mode: 0o600 });
};

/** Launches for ACP plan accounts; `--help` is read once per executable (again after a timeout). */
export class AcpLaunches {
  private readonly deps: AcpLaunchDeps;
  private readonly args = new Map<string, Promise<string[]>>();
  private readonly prompts = new Map<string, Promise<Record<string, string>>>(); // B-049 F3: provider → its prompt variable

  constructor(deps: AcpLaunchDeps) { this.deps = deps; }

  /** The AcpResolver: the agent an ACP plan account starts (in its own home, if it has one); undefined when its CLI is not installed. */
  async resolve(account: Pick<Account, 'provider' | 'home'>): Promise<AcpLaunch | undefined> {
    const spec = acpProvider(account.provider);
    const exe = spec ? await this.deps.finder.find(spec.cli) : null;
    return spec && exe ? this.launch(spec, exe, acpHomeEnv(account)) : undefined;
  }

  /** `home`: the account's home variable (acpHomeEnv); detection probes the default home without one. */
  async launch(spec: AcpProviderSpec, exe: Executable, home: Record<string, string> = {}): Promise<AcpLaunch> {
    const launch: AcpLaunch = { name: spec.name, command: exe.command, args: [...exe.prefixArgs, ...await this.flags(spec, exe)] };
    const prompt = await this.systemPrompt(spec);
    if (spec.env || Object.keys(home).length || Object.keys(prompt).length) launch.env = { ...spec.env, ...prompt, ...home };
    return launch;
  }

  /**
   * B-049 F3: `{<systemPromptEnv>: <file>}` once ACP_SYSTEM_PROMPT is written (once per provider; again after a
   * failed write). Nothing without a prompt folder or a variable – never a variable that names a missing file
   * (Gemini CLI refuses to start then).
   */
  private systemPrompt(spec: AcpProviderSpec): Promise<Record<string, string>> {
    const variable = spec.systemPromptEnv;
    const dir = this.deps.promptDir;
    if (!variable || !dir) return Promise.resolve({});
    let pending = this.prompts.get(spec.provider);
    if (!pending) {
      const file = path.join(dir, `${spec.provider}-system.md`);
      pending = (this.deps.writeFile ?? writeOwnFile)(file, `${ACP_SYSTEM_PROMPT}\n`)
        .then(() => ({ [variable]: file }), () => { this.prompts.delete(spec.provider); return {}; });
      this.prompts.set(spec.provider, pending);
    }
    return pending;
  }

  private flags(spec: AcpProviderSpec, exe: Executable): Promise<string[]> {
    const key = `${spec.provider}\n${exe.path}`;
    let pending = this.args.get(key);
    if (!pending) {
      const env = childEnv(this.deps.env ?? process.env, {});
      pending = runCli(this.deps.supervisor, exe, ['--help'], { env, cwd: this.deps.cwd, timeoutMs: 10_000, maxBytes: 64 * 1024, owner: `acp-help:${spec.provider}` })
        .then((result) => {
          if (result.timedOut) this.args.delete(key); // a slow first start: read it again next time
          return acpArgs(spec, `${result.stdout}\n${result.stderr}`);
        }, () => { this.args.delete(key); return [spec.fallback]; });
      this.args.set(key, pending);
    }
    return pending;
  }
}

/**
 * Detection's sign-in probe: a short-lived agent process in the neutral folder, initialize and a
 * throwaway session/new. true = signed in, false = the agent asked for a sign-in, undefined = no
 * answer in time (or it failed otherwise). The process is stopped afterwards, also after a timeout.
 */
export async function probeSignedIn(input: {
  launch: AcpLaunch; supervisor: Supervisor; cwd: string; version: string; env?: NodeJS.ProcessEnv; timeoutMs: number; key: string;
}): Promise<boolean | undefined> {
  let proc: AcpProcess | undefined;
  const answer = (async () => {
    proc = await AcpProcess.start({ key: input.key, launch: input.launch, supervisor: input.supervisor, cwd: input.cwd, version: input.version, env: input.env, idleMs: input.timeoutMs });
    const result = await proc.conn.request('session/new', { cwd: input.cwd, mcpServers: [] }, input.timeoutMs);
    const id = isRecord(result) ? str(result.sessionId) : undefined;
    if (id && proc.info.closeSession) await proc.conn.request('session/close', { sessionId: id }, 2_000).catch(() => undefined);
    return true;
  })().catch((error: unknown) => (isAuthError(error) ? false : undefined));
  void answer.finally(() => proc?.dispose()).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), input.timeoutMs); timer.unref?.(); });
  try { return await Promise.race([answer, late]); } finally { clearTimeout(timer); }
}

/** The ACP engine's sign-in hooks (AcpEngine.authMethods / authenticate). */
export interface AcpSignInPort {
  authMethods(account: Account): Promise<AuthMethod[]>;
  authenticate(account: Account, methodId?: string): Promise<boolean>;
}

/**
 * Starts the agent's own sign-in for `account` (ACP authenticate with the spec's method, e.g. Gemini
 * CLI's Google sign-in, which opens the browser). Resolves once it started; `done` ends with the
 * sign-in (true = signed in). Throws 'unavailable' when the CLI cannot start or offers no such method.
 */
export async function startAuthentication(engine: unknown, account: Account, spec: AcpProviderSpec): Promise<{ done: Promise<boolean> }> {
  const port = engine as Partial<AcpSignInPort> | undefined;
  if (typeof port?.authMethods !== 'function' || typeof port.authenticate !== 'function') throw new WorkforceError('unavailable', `${spec.name} is not available.`);
  let methods: AuthMethod[];
  try { methods = await port.authMethods(account); }
  catch (error) { throw new WorkforceError('unavailable', error instanceof Error && error.message ? error.message : `${spec.name} could not start.`); }
  const method = signInMethod(spec, methods);
  if (!method) throw new WorkforceError('unavailable', `${spec.name} offers no sign-in Autark can start. Sign in once in ${spec.name} itself, then check again.`);
  return { done: port.authenticate(account, method.id).catch(() => false) };
}
