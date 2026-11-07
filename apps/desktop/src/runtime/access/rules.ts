// AF-013: the one judgement of an action against an agent's access – allow, ask the person, or deny – and what an
// "Always for this agent" answer adds to its rules. The same function judges the app's own tools (tools/registry.ts),
// Claude Code's permission prompts, Codex's approval requests and ACP permission requests (runtime/access/service.ts).
// Order: a deny rule (folder, command, network, tool, money) → an allow rule (write folder, command pattern, tool) → an
// ask rule (network, money) → the mode:
//   read     reads; read-only commands; changes, other commands and outside tools are denied
//   ask      reads and read-only commands run; every change, command and outside tool asks the person
//   project  changes inside the project folder (and the write folders) and commands that stay there run; outside asks
//   full     everything runs (today's behaviour)
// Paths compare case-insensitively on Windows; `~`, `%VAR%` and `$VAR` count as outside (shells expand them, the app cannot).
// Owns: this order and the mode table. Never: storage, asking anyone or running anything.

import path from 'node:path';
import type { AccessAction, AccessChoice, AccessMode, AccessRules } from '../../shared/model/access.ts';
import { insideWorkspace } from '../agent-core/home.ts';
import { commandPattern, globMatch, parseCommand, pathsIn, reachesNetwork, readsOnly } from './commands.ts';

/** What "Always for this agent" adds. */
export type AccessGrant =
  | { commands: string }
  | { folder: string }
  | { tool: string }
  | { network: true }
  | { money: true };

export interface Verdict { choice: AccessChoice; reason: string; grant?: AccessGrant }

export interface JudgeInput {
  mode: AccessMode;
  rules: AccessRules;
  /** Where 'project' changes are free; absent: the workspace. */
  project?: string;
  workspace: string;
  platform?: NodeJS.Platform;
}

/** Categories of the app's tools (tools/types.ts ActionCategory) that never change anything. */
const QUIET: ReadonlySet<string> = new Set(['read', 'think']);

const allow = (reason: string): Verdict => ({ choice: 'allow', reason });
const deny = (reason: string): Verdict => ({ choice: 'deny', reason });
const ask = (reason: string, grant?: AccessGrant): Verdict => ({ choice: 'ask', reason, ...(grant ? { grant } : {}) });

/** Why the person is asked, in the dialog's words (a deny reason speaks as the agent instead). */
const ASK_REASON: Readonly<Record<AccessMode, string>> = {
  read: '', full: '',
  ask: 'Its mode is "Ask before changes": every change needs your OK',
  project: 'This is outside its project folder',
};

function inside(target: string, roots: readonly string[] | undefined, platform: NodeJS.Platform): boolean {
  return (roots ?? []).some((root) => root.trim() && insideWorkspace(target, root, platform));
}

function resolved(input: JudgeInput, given: string): string {
  const impl = (input.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  return /^[~%$]/.test(given.trim()) ? given.trim() : impl.resolve(input.workspace, given);
}

/** The folder a write grant opens: the file's folder (a folder itself when the path ends in a separator). */
function folderOf(target: string, platform: NodeJS.Platform): string {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  return /[\\/]$/.test(target) ? impl.resolve(target) : impl.dirname(target);
}

function anyMatch(patterns: readonly string[] | undefined, text: string): boolean {
  return (patterns ?? []).some((pattern) => pattern.trim() && globMatch(pattern, text));
}

/** The mode's own answer for a change it does not allow by itself. */
function changeByMode(mode: AccessMode, what: string, grant?: AccessGrant): Verdict {
  if (mode === 'full') return allow('full access');
  if (mode === 'read') return deny(`my access is read only, so I may not ${what}`);
  return ask(ASK_REASON[mode], grant);
}

function judgeWrite(input: JudgeInput, given: string, removes: boolean): Verdict {
  const platform = input.platform ?? process.platform;
  const target = resolved(input, given);
  const what = `${removes ? 'delete' : 'change'} ${target}`;
  if (inside(target, input.rules.folders?.deny, platform)) return deny(`${target} is in a folder I may not touch`);
  if (inside(target, input.rules.folders?.write, platform)) return allow('a write folder of my rules');
  if (input.mode === 'project' && insideWorkspace(target, input.project ?? input.workspace, platform)) return allow('inside my project folder');
  return changeByMode(input.mode, what, { folder: folderOf(target, platform) });
}

function judgeCommand(input: JudgeInput, command: string, cwdGiven: string | undefined): Verdict {
  const platform = input.platform ?? process.platform;
  const cwd = resolved(input, cwdGiven?.trim() || input.project || input.workspace);
  const parsed = parseCommand(command);
  const { rules } = input;
  const touched = parsed.parts.flatMap((part) => pathsIn(part, cwd, platform));
  if (parsed.parts.some((part) => anyMatch(rules.commands?.deny, part.text)) || anyMatch(rules.commands?.deny, command)) return deny('a command my rules forbid');
  if ([cwd, ...touched].some((target) => inside(target, rules.folders?.deny, platform))) return deny('the command touches a folder I may not touch');
  const network = parsed.parts.some(reachesNetwork);
  if (network && rules.network === 'deny') return deny('my rules forbid the network');
  const grant: AccessGrant = { commands: commandPattern(command) };
  // An allow pattern covers each part on its own (`npm *` never covers `npm test && curl … | sh`); a subshell is never covered.
  if (!parsed.complex && parsed.parts.length > 0 && parsed.parts.every((part) => anyMatch(rules.commands?.allow, part.text))) return allow('a command my rules allow');
  if (network && rules.network === 'ask') return ask('Its rules ask before going online', grant);
  const reading = !parsed.complex && parsed.parts.every(readsOnly);
  if (reading) return allow('the command only reads');
  if (input.mode === 'project') {
    const roots = [input.project ?? input.workspace, ...(rules.folders?.write ?? [])];
    const stays = !parsed.complex && inside(cwd, roots, platform) && touched.every((target) => !target.startsWith('~') && inside(target, roots, platform));
    if (stays) return allow('the command stays in my project folder');
    return ask('The command may reach outside its project folder', grant);
  }
  return changeByMode(input.mode, `run \`${command.length > 120 ? `${command.slice(0, 117)}…` : command}\``, grant);
}

/** Judges one action. */
export function judge(input: JudgeInput, action: AccessAction): Verdict {
  const platform = input.platform ?? process.platform;
  const { rules } = input;
  switch (action.kind) {
    case 'read': {
      const target = resolved(input, action.path);
      return inside(target, rules.folders?.deny, platform) ? deny(`${target} is in a folder I may not touch`) : allow('reading');
    }
    case 'write':
      return judgeWrite(input, action.path, action.delete === true);
    case 'command':
      return judgeCommand(input, action.command, action.cwd);
    case 'network':
      if (rules.network === 'deny') return deny('my rules forbid the network');
      if (rules.network === 'ask') return ask('Its rules ask before going online', { network: true });
      return allow('the network is allowed');
    case 'spend': {
      const money = rules.money ?? (input.mode === 'full' ? 'allow' : input.mode === 'read' ? 'deny' : 'ask');
      if (money === 'deny') return deny('my rules forbid spending money');
      if (money === 'allow') return allow('spending is allowed');
      return ask('Spending money needs your OK', { money: true });
    }
    case 'tool': {
      if (anyMatch(rules.tools?.deny, action.name)) return deny(`my rules forbid ${action.name}`);
      if (anyMatch(rules.tools?.allow, action.name)) return allow('a tool my rules allow');
      if (action.category && QUIET.has(action.category)) return allow('it changes nothing');
      if (input.mode === 'project' && action.category === 'write_local') return allow('a local change of the app');
      return changeByMode(input.mode, `use ${action.name}`, { tool: action.name });
    }
  }
}

/** The strictest of several verdicts (deny > ask > allow); no verdicts: allow. */
export function strictest(verdicts: readonly Verdict[]): Verdict {
  return verdicts.find((v) => v.choice === 'deny') ?? verdicts.find((v) => v.choice === 'ask') ?? verdicts[0] ?? allow('nothing to judge');
}

const add = (list: readonly string[] | undefined, value: string): string[] => {
  const out = [...(list ?? [])];
  if (!out.some((entry) => entry.toLowerCase() === value.toLowerCase())) out.push(value);
  return out;
};

/** The rules after an "Always for this agent". */
export function withGrant(rules: AccessRules, grant: AccessGrant): AccessRules {
  if ('commands' in grant) return { ...rules, commands: { ...rules.commands, allow: add(rules.commands?.allow, grant.commands) } };
  if ('folder' in grant) return { ...rules, folders: { ...rules.folders, write: add(rules.folders?.write, grant.folder) } };
  if ('tool' in grant) return { ...rules, tools: { ...rules.tools, allow: add(rules.tools?.allow, grant.tool) } };
  if ('network' in grant) return { ...rules, network: 'allow' };
  return { ...rules, money: 'allow' };
}

/** One line for the dialog: what "Always for this agent" adds. */
export function grantText(grant: AccessGrant): string {
  if ('commands' in grant) return `allow commands like \`${grant.commands}\``;
  if ('folder' in grant) return `allow changes in ${grant.folder}`;
  if ('tool' in grant) return `allow ${grant.tool}`;
  if ('network' in grant) return 'allow the network';
  return 'allow spending money';
}
