// PC scan: installed CLIs + login state (official status commands, in the default CLI homes; the
// ACP plan CLIs Gemini CLI, Copilot CLI and Kimi Code answer an ACP initialize + session/new probe
// in a short-lived process, engines/acp/providers.ts), local model servers on their default loopback
// ports (400 ms GETs in parallel), the names of the provider key variables that are set (the one
// table, ENV_KEY_PROVIDERS), Tailscale status. Every CLI starts in `cwd` (the empty engine folder or
// the app temp), never in the process cwd where a project config could apply.
// Audit 23.10.: heavy CLIs (Claude Code is a ~290 MB binary) start slowly on a loaded 8 GB PC, so each
// command gets CLI_TIMEOUT_MS, a CLI's status and version run one after the other (half the peak RAM),
// and a status command that did not answer leaves the login *unknown* (no loggedIn) – never "signed
// out", which would flip a working account to needs_login. Its `--version` is then skipped (that CLI
// is slow right now; another cold start would only add up to CLI_TIMEOUT_MS), and such a report counts
// as incomplete (loginUnknown): the next non-forced detect scans again instead of serving the cache.
// Owns: the DetectionReport. Results are cached (and adopted) by AccountService (adoption.ts), not here.
// Never: reads credential files, prints env values, scans the LAN, or starts/pulls models.

import os from 'node:os';
import { ENV_KEY_PROVIDERS, type DetectionReport } from '../../shared/model/providers.ts';
import type { Supervisor } from '../system/supervisor.ts';
import type { CliId, Executable, ExecutableFinder } from './executables.ts';
import { CLAUDE_EXIT_GRACE_MS, parseClaudeStatus, parseCodexStatus, runCli } from './cli.ts';
import { childEnv } from '../engines/codex/server.ts';
import { ACP_PROVIDERS, AcpLaunches, acpProvider, probeSignedIn } from '../engines/acp/providers.ts';
import { isRecord } from '../engines/shared.ts';

export const ENV_KEYS: readonly string[] = Object.keys(ENV_KEY_PROVIDERS);

/** How long one CLI command of a scan may take (a cold Claude Code start on a loaded PC took 5–30 s). */
export const CLI_TIMEOUT_MS = 30_000;

export interface DetectDeps {
  finder: ExecutableFinder;
  supervisor: Supervisor;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  probeTimeoutMs?: number;
  /** Folder every CLI starts in (default the OS temp folder) – never the process cwd, where project config could apply. */
  cwd?: string;
  /** The ACP plan CLIs' launches (shared with the ACP engine, so `--help` is read once) and the version their probe reports. */
  launches?: AcpLaunches;
  version?: string;
  /** How long an ACP plan CLI may take for its sign-in probe (default 15 s). */
  acpProbeMs?: number;
  /** How long one CLI command (status, version) may take (default CLI_TIMEOUT_MS). */
  cliTimeoutMs?: number;
}

type Cli = DetectionReport['clis'][number];
type Local = DetectionReport['localServers'][number];

/** Every CLI the scan looks for: its provider id in the report and its executable. */
const CLIS: ReadonlyArray<{ provider: Cli['provider']; exe: CliId }> = [
  { provider: 'codex', exe: 'codex' }, { provider: 'claude', exe: 'claude' },
  ...Object.values(ACP_PROVIDERS).map((spec) => ({ provider: spec.provider, exe: spec.cli })),
];
const cwdOf = (deps: DetectDeps) => deps.cwd ?? os.tmpdir();

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

export async function detect(deps: DetectDeps): Promise<DetectionReport> {
  const env = deps.env ?? process.env;
  const [clis, localServers, tailscale] = await Promise.all([detectClis(deps, env), probeLocal(deps), detectTailscale(deps, env)]);
  return {
    clis, localServers, tailscale,
    envKeys: ENV_KEYS.filter((name) => Boolean(env[name]?.trim())),
    checkedAt: (deps.now ?? Date.now)(),
  };
}

async function detectClis(deps: DetectDeps, env: NodeJS.ProcessEnv): Promise<Cli[]> {
  const cwd = cwdOf(deps);
  const launches = deps.launches ?? new AcpLaunches({ finder: deps.finder, supervisor: deps.supervisor, cwd, env });
  return Promise.all(CLIS.map(async ({ provider, exe: id }): Promise<Cli> => {
    const exe = await deps.finder.find(id);
    if (!exe) return { provider };
    const cli: Cli = { provider, path: exe.path };
    const childEnvironment = childEnv(env, {});
    // One process of this CLI at a time: the status first, then the version (none after a status that timed out).
    const status = await loginStatus(deps, provider, exe, childEnvironment, launches);
    if (status === TIMED_OUT) return cli; // login unknown: the next detect scans again (loginUnknown)
    const version = await runCli(deps.supervisor, exe, ['--version'], { env: childEnvironment, cwd, timeoutMs: deps.cliTimeoutMs ?? CLI_TIMEOUT_MS, owner: `detect:${provider}` }).catch(() => undefined);
    const v = version && version.code === 0 ? /\d+\.\d+[\w.+-]*/.exec(strip(version.stdout))?.[0] : undefined;
    if (v) cli.version = v;
    if (status) { cli.loggedIn = status.loggedIn; if (status.method) cli.method = status.method; }
    return cli;
  }));
}

/** The CLIs whose status command decides the login; an installed one without an answer makes the report incomplete. */
const STATUS_CLIS: ReadonlySet<Cli['provider']> = new Set<Cli['provider']>(['codex', 'claude']);

/**
 * The scan could not tell the login of an installed Codex or Claude Code (its status command
 * timed out or failed): the report is incomplete, so the next non-forced detect scans again (adoption.ts) –
 * on its next natural trigger (start, Settings), no timer. ACP plan CLIs whose probe cannot tell are not
 * counted: for them that is a normal answer (Settings offers Add).
 */
export function loginUnknown(report: Pick<DetectionReport, 'clis'>): boolean {
  return report.clis.some((cli) => STATUS_CLIS.has(cli.provider) && cli.path !== undefined && cli.loggedIn === undefined);
}

/** A status command that did not answer in time. */
const TIMED_OUT = 'timed-out';

async function loginStatus(deps: DetectDeps, provider: Cli['provider'], exe: Executable, env: NodeJS.ProcessEnv, launches: AcpLaunches): Promise<{ loggedIn: boolean; method?: string } | typeof TIMED_OUT | undefined> {
  const cwd = cwdOf(deps);
  const timeoutMs = deps.cliTimeoutMs ?? CLI_TIMEOUT_MS;
  try {
    if (provider === 'codex') {
      const r = await runCli(deps.supervisor, exe, ['login', 'status'], { env, cwd, timeoutMs, owner: 'detect:codex-status' });
      if (r.timedOut) return TIMED_OUT; // no answer: the login is unknown, not signed out
      return parseCodexStatus(r.code, `${r.stdout}\n${r.stderr}`);
    }
    if (provider === 'claude') {
      const r = await runCli(deps.supervisor, exe, ['auth', 'status', '--json'], { env, cwd, timeoutMs, owner: 'detect:claude-status', graceMs: CLAUDE_EXIT_GRACE_MS });
      if (r.timedOut) return TIMED_OUT;
      const s = parseClaudeStatus(r.code, r.stdout);
      return s.unknown ? undefined : { loggedIn: s.loggedIn, method: s.method };
    }
    const spec = acpProvider(provider);
    if (spec) {
      const launch = await launches.launch(spec, exe);
      const loggedIn = await probeSignedIn({ launch, supervisor: deps.supervisor, cwd, version: deps.version ?? 'dev', env, timeoutMs: deps.acpProbeMs ?? 15_000, key: `detect:${provider}` });
      return loggedIn === undefined ? undefined : { loggedIn };
    }
  } catch { /* status unknown */ }
  return undefined;
}

async function get(deps: DetectDeps, url: string): Promise<unknown | undefined> {
  const fetchFn = deps.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
  try {
    const response = await fetchFn(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(deps.probeTimeoutMs ?? 400) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return undefined; }
    const text = await response.text();
    if (text.length > 1024 * 1024) return undefined;
    try { return JSON.parse(text); } catch { return {}; }
  } catch { return undefined; }
}

function ids(value: unknown, key: 'data' | 'models', field: 'id' | 'name'): string[] {
  const list = isRecord(value) && Array.isArray(value[key]) ? value[key] as unknown[] : [];
  return list.map((m) => (isRecord(m) ? m[field] : undefined)).filter((id): id is string => typeof id === 'string' && id.length <= 200).slice(0, 200);
}

async function probeLocal(deps: DetectDeps): Promise<Local[]> {
  const base = (port: number) => `http://127.0.0.1:${port}`;
  const probes: Array<Promise<Local | undefined>> = [
    (async () => {
      const version = await get(deps, `${base(11434)}/api/version`);
      if (!version) return undefined;
      const tags = await get(deps, `${base(11434)}/api/tags`);
      return { provider: 'ollama', baseUrl: `${base(11434)}/v1`, models: ids(tags, 'models', 'name') };
    })(),
    (async () => {
      const models = await get(deps, `${base(1234)}/v1/models`);
      return models ? { provider: 'lmstudio', baseUrl: `${base(1234)}/v1`, models: ids(models, 'data', 'id') } : undefined;
    })(),
    ...[9931, 8080].map(async (port): Promise<Local | undefined> => {
      const health = await get(deps, `${base(port)}/health`);
      if (!health) return undefined;
      const models = await get(deps, `${base(port)}/v1/models`);
      return { provider: 'llamacpp', baseUrl: `${base(port)}/v1`, models: ids(models, 'data', 'id') };
    }),
    (async () => {
      const models = await get(deps, `${base(8000)}/v1/models`);
      return models ? { provider: 'vllm', baseUrl: `${base(8000)}/v1`, models: ids(models, 'data', 'id') } : undefined;
    })(),
  ];
  const found = (await Promise.all(probes)).filter((x): x is Local => Boolean(x));
  // llama.cpp on 8080 and vLLM can be the same server; keep the first per baseUrl.
  return found.filter((s, i) => found.findIndex((o) => o.baseUrl === s.baseUrl) === i);
}

async function detectTailscale(deps: DetectDeps, env: NodeJS.ProcessEnv): Promise<DetectionReport['tailscale']> {
  const exe = await deps.finder.find('tailscale');
  if (!exe) return undefined;
  try {
    const r = await runCli(deps.supervisor, exe, ['status', '--json'], { env: childEnv(env, {}), cwd: cwdOf(deps), timeoutMs: 5_000, maxBytes: 512 * 1024, owner: 'detect:tailscale' });
    const value = JSON.parse(r.stdout) as Record<string, unknown>;
    const self = isRecord(value.Self) ? value.Self : {};
    const dns = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : undefined;
    return { running: value.BackendState === 'Running', dnsName: dns };
  } catch {
    return { running: false };
  }
}
