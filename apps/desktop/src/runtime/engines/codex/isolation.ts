// Keeps Codex threads from taking settings out of the workspace (agents and content injected into
// them can write files there). Codex adds a config layer for every `.codex/` folder between a
// thread's cwd and the project root (config.toml: sandbox, MCP servers, hooks, models; rules/: exec
// policies; hooks) for a trusted project only, and app-server thread/start trusts the cwd by itself
// when the thread asks for a writable sandbox (persisted in CODEX_HOME/config.toml, else "in-memory
// trust for this thread"; seen in codex-cli 0.163). Therefore:
// - a thread opens read-only (no writable sandbox for that auto-trust to react to) and its session
//   config marks the cwd untrusted under every spelling Codex may key it by (on Windows Codex saves
//   trust all lower case); trust is read from the effective configuration, so this also beats trust
//   that an older build or the person's own Codex home saved. `project_root_markers = []` makes the
//   cwd the project root (also for the server itself, SERVER_CONFIG): no `.codex/` layer from a
//   parent folder and no trust inherited from a parent repository; `project_doc_max_bytes = 0`: no
//   AGENTS.md of the workspace or a task worktree becomes project instructions (agents can write
//   them; Workforce's own instructions come through the thread); `shell_environment_policy.set`
//   gives every agent shell the safe git env (I02: git/safe-env.ts – Codex's default KEY/SECRET/TOKEN
//   excludes would drop GIT_CONFIG_KEY_n, `set` applies after them); ignore_default_excludes is never
//   set, so secrets in the server's env stay out of shells;
// - every turn sets its own sandbox and approval policy ('never': Codex asks nobody), so no config file
//   changes them. An agent's turn (Workforce tools or our MCP hub) outside the server's own folder runs with
//   full access – the PC belongs to the AI team; a turn marked readOnly and a runtime helper
//   call (decisions, compaction) run read-only, so a helper cannot plant files in the folder it runs in;
// - the server turns off two features that act on workspace files even in an untrusted folder
//   (skills still load there): installing a skill's MCP dependencies and importing other agents'
//   configs (.claude/, .mcp.json …).
// Owns: these overrides, the spellings of a folder and which turns may write.
// Never: reads or writes CODEX_HOME files or anything in the workspace.

import * as path from 'node:path';
import type { EngineTurnInput } from '../types.ts';
import { agentIdentityEnv } from '../agent-token.ts'; // AF-001

/** Turned off with `-c features.<name>=false` when the app-server starts (server.ts). */
export const WORKSPACE_FEATURES = ['skill_mcp_dependency_install', 'external_migration'];

/** Server-wide `-c` overrides (server.ts): the server's own config takes no `.codex/` layer from a parent of its folder. */
export const SERVER_CONFIG = ['project_root_markers=[]'];

const UNTRUSTED = { trust_level: 'untrusted' } as const;

/** Approval requests (if any) go to the client, never to Codex's auto-reviewer a config file may select. */
const REVIEWER = 'user';

function trimSeparators(dir: string): string {
  if (/^[a-z]:[\\/]*$/i.test(dir) || /^[\\/]+$/.test(dir)) return dir; // a drive or file-system root stays as it is
  return dir.replace(/[\\/]+$/, '');
}

/**
 * The keys Codex may look a folder up by in `projects`: as given, resolved and its real path
 * (`real`, when known). On Windows also all lower case – the form Codex saves trust under
 * (`[projects.'c:\users\…']`) – and with either drive-letter case.
 */
export function trustKeys(cwd: string, real?: string, platform: NodeJS.Platform = process.platform): string[] {
  const keys = new Set<string>();
  const resolve = platform === 'win32' ? path.win32.resolve : path.posix.resolve;
  for (const spelling of [cwd, resolve(cwd), real]) {
    if (!spelling) continue;
    const key = trimSeparators(spelling);
    keys.add(key);
    if (platform !== 'win32') continue;
    keys.add(key.toLowerCase());
    if (/^[a-z]:/i.test(key)) {
      keys.add(key[0]!.toUpperCase() + key.slice(1));
      keys.add(key[0]!.toLowerCase() + key.slice(1));
    }
  }
  return [...keys];
}

/**
 * thread/start and thread/resume settings: read-only until a turn sets its sandbox; the cwd untrusted
 * and the project root; no project docs; `shellSet` (the safe git env) in every shell. AF-001: with `agentId` (a thread is
 * one agent's) its shells also get the agent's wf identity (engines/agent-token.ts), so its `wf send` writes as the agent.
 */
export function threadIsolation(keys: string[], shellSet: Record<string, string> = {}, agentId?: string): {
  sandbox: 'read-only'; approvalsReviewer: typeof REVIEWER;
  config: {
    projects: Record<string, typeof UNTRUSTED>; project_root_markers: string[]; project_doc_max_bytes: 0;
    shell_environment_policy: { set: Record<string, string> };
  };
} {
  return {
    sandbox: 'read-only', approvalsReviewer: REVIEWER,
    config: {
      projects: Object.fromEntries(keys.map((key) => [key, UNTRUSTED])), project_root_markers: [], project_doc_max_bytes: 0,
      shell_environment_policy: { set: { ...shellSet, ...agentIdentityEnv(agentId) } },
    },
  };
}

/** `a` and `b` are the same folder or one lies inside the other (resolved; case-insensitive on Windows). */
export function foldersOverlap(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (dir: string) => { const resolved = p.resolve(dir); return platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const within = (root: string, target: string) => {
    const relative = p.relative(root, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
  };
  const [x, y] = [norm(a), norm(b)];
  return within(x, y) || within(y, x);
}

/** 'full': an agent's turn – no sandbox; 'read': a helper's turn. */
export type TurnAccess = 'full' | 'read';

/**
 * Full access for an agent's turn – it carries Workforce tools or our MCP hub – in a folder apart from the
 * server's own (`serverCwd`), never for a `readOnly` turn; a tool-less runtime call reads only.
 */
export function turnAccess(input: Pick<EngineTurnInput, 'tools' | 'mcp' | 'cwd' | 'readOnly'>, serverCwd: string, platform: NodeJS.Platform = process.platform): TurnAccess {
  if (input.readOnly || (!input.tools.length && !input.mcp)) return 'read';
  return foldersOverlap(input.cwd, serverCwd, platform) ? 'read' : 'full';
}

/** turn/start settings: the sandbox, approval policy and approval reviewer every turn runs with. */
export function turnPermissions(access: TurnAccess = 'full'): Record<string, unknown> {
  return {
    approvalPolicy: 'never',
    approvalsReviewer: REVIEWER,
    sandboxPolicy: access === 'read' ? { type: 'readOnly', networkAccess: false } : { type: 'dangerFullAccess' },
  };
}
